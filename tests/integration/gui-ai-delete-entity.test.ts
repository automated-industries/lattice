import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { aiDeleteEntity } from '../../src/gui/schema-ops.js';

/**
 * The assistant's guarded, reversible table delete (`delete_entity`). Exercises
 * `aiDeleteEntity` against a real ActiveDb (via the test-only `openConfig`
 * export), covering: the empty-table fast path, the non-empty "ask first"
 * guard, the `delete_data` + `move_to` resolutions, the native/ownership/
 * inbound-FK refusals, and that the underlying soft delete is no-reopen +
 * revertible (the physical table + rows survive; a `schema.delete_entity` audit
 * row is recorded).
 */

const dirs: string[] = [];
const dbs: ActiveDb[] = [];

afterEach(() => {
  for (const a of dbs.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-aidelete-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: people.md',
      '  contacts:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: contacts.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  dbs.push(active);
  return active;
}

describe('assistant delete_entity (aiDeleteEntity)', () => {
  it('soft-deletes an EMPTY table immediately (no reopen) and records a revertible audit op', async () => {
    const active = await boot();
    expect(active.validTables.has('people')).toBe(true);

    const out = await aiDeleteEntity(active, 'people', undefined, 'sess');
    expect(out).toEqual({ ok: true, deleted: 'people' });

    // Gone from the live registry + allowlist — without a reopen.
    expect(active.validTables.has('people')).toBe(false);
    expect(active.db.getRegisteredTableNames()).not.toContain('people');

    // Reversible: the physical SQL table still exists and an audit op was recorded.
    const audit = (await active.db.query('_lattice_gui_audit', {})) as { operation: string }[];
    expect(audit.some((a) => a.operation === 'schema.delete_entity')).toBe(true);
    // Physical table survives the soft delete (so revert can restore it).
    const adapter = (
      active.db as unknown as { _adapter: { allAsync?: (s: string) => Promise<unknown[]> } }
    )._adapter;
    const rows = await adapter.allAsync?.(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='people'",
    );
    expect((rows ?? []).length).toBe(1);
  });

  it('refuses a built-in (native) table', async () => {
    const active = await boot();
    const out = await aiDeleteEntity(active, 'secrets', undefined, 'sess');
    expect(out).toMatchObject({ ok: false });
    expect(active.validTables.has('secrets')).toBe(true); // untouched
  });

  it('does NOT delete a NON-empty table without a resolution — asks first', async () => {
    const active = await boot();
    await active.db.insert('people', { id: 'p1', name: 'Ada' });
    await active.db.insert('people', { id: 'p2', name: 'Linus' });

    const out = await aiDeleteEntity(active, 'people', undefined, 'sess');
    expect(out).toMatchObject({ needsResolution: true, rowCount: 2 });
    // Untouched — still listed, rows intact.
    expect(active.validTables.has('people')).toBe(true);
    expect(await active.db.count('people')).toBe(2);
  });

  it('resolution=delete_data soft-deletes the rows then the table (reversible)', async () => {
    const active = await boot();
    await active.db.insert('people', { id: 'p1', name: 'Ada' });

    const out = await aiDeleteEntity(active, 'people', 'delete_data', 'sess');
    expect(out).toMatchObject({ ok: true, deleted: 'people', deletedRows: 1 });
    expect(active.validTables.has('people')).toBe(false);

    const audit = (await active.db.query('_lattice_gui_audit', {})) as { operation: string }[];
    // The soft row-delete (an `update` that sets deleted_at) + the table delete,
    // both audited → the whole thing is revertible from history.
    expect(audit.some((a) => a.operation === 'update')).toBe(true);
    expect(audit.some((a) => a.operation === 'schema.delete_entity')).toBe(true);
    // No live rows remain before the table was removed.
    expect(active.db.getRegisteredTableNames()).not.toContain('people');
  });

  it('resolution=move_to copies rows into the target, then deletes the emptied table', async () => {
    const active = await boot();
    await active.db.insert('people', { id: 'p1', name: 'Ada' });
    await active.db.insert('people', { id: 'p2', name: 'Linus' });

    const out = await aiDeleteEntity(active, 'people', { move_to: 'contacts' }, 'sess');
    expect(out).toMatchObject({ ok: true, deleted: 'people', movedRows: 2 });
    expect(active.validTables.has('people')).toBe(false);

    // Rows landed in the target (with fresh ids), names preserved.
    const moved = (await active.db.query('contacts', {})) as { name: string }[];
    expect(moved.map((r) => r.name).sort()).toEqual(['Ada', 'Linus']);
  });

  it('rejects a move_to target that is not a known table', async () => {
    const active = await boot();
    await active.db.insert('people', { id: 'p1', name: 'Ada' });
    const out = await aiDeleteEntity(active, 'people', { move_to: 'nope' }, 'sess');
    expect(out).toMatchObject({ ok: false });
    expect(active.validTables.has('people')).toBe(true);
  });
});
