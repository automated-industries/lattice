import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/ai/feed.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';

describe('AI function dispatch', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('people', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'people.md',
    });
    // The shared mutation primitives write to the GUI audit table, which the
    // server creates in openConfig. Mirror it here so appendAudit can run.
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

  it('create_row inserts and publishes a feed event tagged source=ai', async () => {
    const events: FeedEvent[] = [];
    feed.subscribe((e) => events.push(e));

    const res = await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    expect(res.ok).toBe(true);
    expect((res.result as { id: string }).id).toBe('p1');
    expect(events).toHaveLength(1);
    expect(events[0]?.op).toBe('insert');
    expect(events[0]?.table).toBe('people');
    expect(events[0]?.source).toBe('ai');
  });

  it('get_row and list_rows read back the data', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const got = await executeFunction(ctx, 'get_row', { table: 'people', id: 'p1' });
    expect(got.ok).toBe(true);
    expect((got.result as { name: string }).name).toBe('Ada');

    const list = await executeFunction(ctx, 'list_rows', { table: 'people' });
    expect(list.ok).toBe(true);
    expect((list.result as unknown[]).length).toBe(1);
  });

  it('update_row changes a field', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const upd = await executeFunction(ctx, 'update_row', {
      table: 'people',
      id: 'p1',
      values: { name: 'Ada L.' },
    });
    expect(upd.ok).toBe(true);
    const got = await executeFunction(ctx, 'get_row', { table: 'people', id: 'p1' });
    expect((got.result as { name: string }).name).toBe('Ada L.');
  });

  it('delete_row soft-deletes; list_rows hides it unless includeDeleted', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const del = await executeFunction(ctx, 'delete_row', { table: 'people', id: 'p1' });
    expect(del.ok).toBe(true);

    const hidden = await executeFunction(ctx, 'list_rows', { table: 'people' });
    expect((hidden.result as unknown[]).length).toBe(0);

    const shown = await executeFunction(ctx, 'list_rows', {
      table: 'people',
      includeDeleted: true,
    });
    expect((shown.result as unknown[]).length).toBe(1);
  });

  it('list_entities reports user tables with row counts', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const res = await executeFunction(ctx, 'list_entities', {});
    expect(res.ok).toBe(true);
    const people = (res.result as { name: string; rowCount: number }[]).find(
      (t) => t.name === 'people',
    );
    expect(people?.rowCount).toBe(1);
  });

  it('rejects unknown tables, unknown functions, and non-dispatchable functions', async () => {
    const badTable = await executeFunction(ctx, 'list_rows', { table: 'ghosts' });
    expect(badTable.ok).toBe(false);
    expect(badTable.error).toMatch(/unknown table/i);

    const badFn = await executeFunction(ctx, 'nuke_everything', {});
    expect(badFn.ok).toBe(false);
    expect(badFn.error).toMatch(/unknown function/i);

    // Declared in the registry but not yet wired into the dispatcher.
    const notWired = await executeFunction(ctx, 'create_entity', { name: 'x' });
    expect(notWired.ok).toBe(false);
    expect(notWired.error).toMatch(/not available/i);
  });

  it('requires id and values where applicable', async () => {
    const noValues = await executeFunction(ctx, 'create_row', { table: 'people' });
    expect(noValues.ok).toBe(false);
    const noId = await executeFunction(ctx, 'get_row', { table: 'people' });
    expect(noId.ok).toBe(false);
  });

  it('undo reverses a create, redo re-applies it', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const undo = await executeFunction(ctx, 'undo', {});
    expect(undo.ok).toBe(true);
    expect((await executeFunction(ctx, 'get_row', { table: 'people', id: 'p1' })).ok).toBe(false);
    const redo = await executeFunction(ctx, 'redo', {});
    expect(redo.ok).toBe(true);
    expect((await executeFunction(ctx, 'get_row', { table: 'people', id: 'p1' })).ok).toBe(true);
  });

  it('undo reports nothing to undo on a clean slate', async () => {
    const res = await executeFunction(ctx, 'undo', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to undo/i);
  });

  it('get_history lists recorded mutations', async () => {
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'Ada' },
    });
    const hist = await executeFunction(ctx, 'get_history', {});
    expect(hist.ok).toBe(true);
    const entries = hist.result as { operation: string; table_name: string }[];
    expect(entries.some((e) => e.operation === 'insert' && e.table_name === 'people')).toBe(true);
  });

  it('link rejects a table that is not a registered junction', async () => {
    const res = await executeFunction(ctx, 'link', {
      table: 'people',
      values: { a_id: '1', b_id: '2' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown table/i);
  });
});
