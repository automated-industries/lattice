import { describe, it, expect } from 'vitest';
import { SchemaManager } from '../../src/schema/manager.js';
import { SQLiteAdapter } from '../../src/db/sqlite.js';

/**
 * Regression for the member-cloud reverse-sync data-loss bug.
 *
 * The per-viewer read-relation resolver (`readRel`) maps a masked table to its
 * `<table>_v` masking view. On a cloud MEMBER open, base-table SELECT is REVOKE'd
 * and granted only on the view. The RENDER engine already routed its reads through
 * this resolver — but the REVERSE-SYNC engine called `queryTable(adapter, table)`
 * with no resolver, so it SELECTed the REVOKE'd base table → permission denied →
 * the member's on-disk edit was silently swallowed (never written back, never in
 * version history).
 *
 * The fix centralizes the ONE resolver on SchemaManager (the read layer) and makes
 * it the default for `queryTable`, so EVERY reader inherits it — render AND
 * reverse-sync — without forking a second code path. There is one mechanism, with
 * per-access-rights routing, not two.
 *
 * This drives the real SQLiteAdapter against a real masking view, asserting the
 * exact no-readRel `queryTable` call reverse-sync makes (engine.ts:94).
 */
function setup(): { adapter: SQLiteAdapter; mgr: SchemaManager } {
  const adapter = new SQLiteAdapter(':memory:');
  adapter.open();
  adapter.run('CREATE TABLE widgets (id TEXT PRIMARY KEY, body TEXT, secret TEXT)');
  adapter.run("INSERT INTO widgets (id, body, secret) VALUES ('1', 'b', 'EYES_ONLY')");
  // The per-viewer masking view a scoped member's connection reads instead of the
  // REVOKE'd base table — here it nulls the owner-only `secret` column.
  adapter.run('CREATE VIEW widgets_v AS SELECT id, body, NULL AS secret FROM widgets');
  const mgr = new SchemaManager();
  mgr.define('widgets', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT' },
    render: () => '',
    outputFile: 'f.md',
  });
  return { adapter, mgr };
}

describe('SchemaManager.readRel — one resolver, every reader (render + reverse-sync)', () => {
  it('owner (resolver unset) → queryTable reads the BASE table (byte-identical to prior behavior)', async () => {
    const { adapter, mgr } = setup();
    const rows = await mgr.queryTable(adapter, 'widgets');
    expect(rows[0]?.secret).toBe('EYES_ONLY');
  });

  it("member (resolver set) → a no-arg queryTable (reverse-sync's exact call) reads the MASKING VIEW, not the base table", async () => {
    const { adapter, mgr } = setup();
    mgr.setReadRelation((t) => (t === 'widgets' ? 'widgets_v' : t));

    // No readRel arg — this is reverse-sync/engine.ts:94 verbatim. Pre-fix it
    // defaulted to identity → SELECT the base table → permission-denied for a
    // member → swallowed. After the fix it defaults to the centralized resolver.
    const rows = await mgr.queryTable(adapter, 'widgets');

    expect(rows[0]?.id).toBe('1'); // the row is still read (no permission error)
    expect(rows[0]?.secret).toBeNull(); // …through the masking view, not the base
  });

  it('an explicit readRel arg still wins (callers may override the default)', async () => {
    const { adapter, mgr } = setup();
    mgr.setReadRelation((t) => (t === 'widgets' ? 'widgets_v' : t));
    // Force identity explicitly → base table, overriding the member default.
    const rows = await mgr.queryTable(adapter, 'widgets', (t) => t);
    expect(rows[0]?.secret).toBe('EYES_ONLY');
  });
});
