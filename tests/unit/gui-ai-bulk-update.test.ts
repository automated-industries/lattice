import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { getFunction } from '../../src/gui/ai/registry.js';

/**
 * 3.3.5: the deterministic bulk executor. A bulk request used to loop per-row,
 * hit MAX_TOOL_LOOPS (16), and falsely report "all done" at ~10%. bulk_update
 * applies ONE change to EVERY matching row in a single tool call and returns the
 * TRUE affected count — so it completes regardless of row count and reports
 * honestly. These run on SQLite (the column path); cloud-only owner-gated
 * visibility is covered in the Postgres integration suite.
 */
describe('AI bulk_update (deterministic bulk executor)', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-bulk-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'people.md',
    });
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    feed = new FeedBus();
    ctx = {
      db,
      feed,
      validTables: new Set(['people']),
      junctionTables: new Set(),
      softDeletable: new Set(['people']),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed(n: number, status = 'draft'): Promise<void> {
    for (let i = 0; i < n; i++) {
      await executeFunction(ctx, 'create_row', {
        table: 'people',
        values: { name: 'Person ' + String(i), status },
      });
    }
  }
  async function statusCount(status: string): Promise<number> {
    const rows = (await db.query('people', {
      filters: [{ col: 'status', op: 'eq', val: status }],
    })) as {
      id: string;
    }[];
    return rows.length;
  }

  it('changes EVERY matching row in one call and returns the true count (past MAX_TOOL_LOOPS)', async () => {
    await seed(25); // > 16, the per-turn tool-loop cap — proves one call does them all
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'people',
      filter: [{ col: 'status', op: 'eq', val: 'draft' }],
      set: { status: 'published' },
    });
    expect(res.ok).toBe(true);
    const r = res.result as { affected: number; matched: number };
    expect(r.affected).toBe(25);
    expect(r.matched).toBe(25);
    expect(await statusCount('draft')).toBe(0);
    expect(await statusCount('published')).toBe(25);
  });

  it('with no filter targets every (non-deleted) row', async () => {
    await seed(12);
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'people',
      set: { status: 'archived' },
    });
    expect((res.result as { affected: number }).affected).toBe(12);
    expect(await statusCount('archived')).toBe(12);
  });

  it('excludes soft-deleted rows from a bulk change', async () => {
    await seed(10);
    const all = (await db.query('people', {})) as { id: string }[];
    await executeFunction(ctx, 'delete_row', { table: 'people', id: all[0]!.id });
    await executeFunction(ctx, 'delete_row', { table: 'people', id: all[1]!.id });
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'people',
      set: { status: 'kept' },
    });
    expect((res.result as { affected: number }).affected).toBe(8);
  });

  it('emits one audit/feed event per changed row (undo/history integrity)', async () => {
    await seed(6);
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));
    await executeFunction(ctx, 'bulk_update', { table: 'people', set: { status: 'x' } });
    expect(events.length).toBe(6);
    expect(events.every((e) => e.op === 'update' && e.source === 'ai')).toBe(true);
  });

  it('rejects a filter on an unknown column (recoverable tool error, not a wrong-rows match)', async () => {
    await seed(3);
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'people',
      filter: [{ col: 'nope', op: 'eq', val: 'x' }],
      set: { status: 'y' },
    });
    expect(res.ok).toBe(false);
    expect(await statusCount('draft')).toBe(3); // nothing changed
  });

  it('requires a set payload', async () => {
    const res = await executeFunction(ctx, 'bulk_update', { table: 'people' });
    expect(res.ok).toBe(false);
  });

  it('reports that visibility is cloud-only on a local (SQLite) workspace', async () => {
    await seed(2);
    const res = await executeFunction(ctx, 'bulk_update', {
      table: 'people',
      set: { visibility: 'private' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/shared cloud workspace/i);
  });

  it('is registered as a mutating row tool requiring table + set (not filter)', () => {
    expect(DISPATCHABLE.has('bulk_update')).toBe(true);
    const def = getFunction('bulk_update');
    expect(def?.mutates).toBe(true);
    expect(def?.category).toBe('row');
    expect(def?.args.required).toEqual(['table', 'set']);
  });
});
