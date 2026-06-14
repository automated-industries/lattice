import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
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
    // Per-column GUI metadata — the set_column_description tool writes here.
    db.define('_lattice_gui_column_meta', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT NOT NULL',
        column_name: 'TEXT NOT NULL',
        secret: 'INTEGER NOT NULL DEFAULT 0',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      render: () => '',
      outputFile: '.lattice-gui/column-meta.md',
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

  it('set_column_description persists a definition, trims it, clears it, and rejects unknown columns', async () => {
    async function descOf(column: string): Promise<string | null | undefined> {
      const rows = (await db.query('_lattice_gui_column_meta', {
        filters: [
          { col: 'table_name', op: 'eq', val: 'people' },
          { col: 'column_name', op: 'eq', val: column },
        ],
      })) as { description: string | null }[];
      return rows[0]?.description;
    }

    const r = await executeFunction(ctx, 'set_column_description', {
      table: 'people',
      column: 'name',
      description: '  The full name of the person.  ',
    });
    expect(r.ok).toBe(true);
    expect(await descOf('name')).toBe('The full name of the person.'); // trimmed

    // An empty description clears the override (reverts to the built-in/type).
    await executeFunction(ctx, 'set_column_description', {
      table: 'people',
      column: 'name',
      description: '',
    });
    expect(await descOf('name')).toBeNull();

    // Unknown column is a loud failure, not a silent write.
    const bad = await executeFunction(ctx, 'set_column_description', {
      table: 'people',
      column: 'does_not_exist',
      description: 'x',
    });
    expect(bad.ok).toBe(false);
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

  it('list_entities never includes the secrets table', async () => {
    await db.defineLate('secrets', {
      columns: { id: 'TEXT PRIMARY KEY', kind: 'TEXT', value: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'secrets.md',
    });
    const res = await executeFunction(ctx, 'list_entities', {});
    expect(res.ok).toBe(true);
    const names = (res.result as { name: string }[]).map((t) => t.name);
    expect(names).toContain('people');
    expect(names).not.toContain('secrets');
  });

  it('list_entities hides the conversation-storage tables', async () => {
    for (const t of ['chat_threads', 'chat_messages']) {
      await db.defineLate(t, {
        columns: { id: 'TEXT PRIMARY KEY', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: `${t}.md`,
      });
    }
    const names = (
      (await executeFunction(ctx, 'list_entities', {})).result as { name: string }[]
    ).map((t) => t.name);
    expect(names).toContain('people');
    expect(names).not.toContain('chat_threads');
    expect(names).not.toContain('chat_messages');
  });

  it('redacts columns marked secret from get_row and list_rows', async () => {
    // The GUI column-meta table records which columns are marked secret.
    await db.defineLate('_lattice_gui_column_meta', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT',
        column_name: 'TEXT',
        secret: 'INTEGER',
      },
      render: () => '',
      outputFile: 'cm.md',
    });
    await db.insert('_lattice_gui_column_meta', {
      id: 'm1',
      table_name: 'people',
      column_name: 'name',
      secret: 1,
    });
    await executeFunction(ctx, 'create_row', {
      table: 'people',
      values: { id: 'p1', name: 'sk-secret-value' },
    });

    const got = await executeFunction(ctx, 'get_row', { table: 'people', id: 'p1' });
    expect((got.result as { name: string }).name).not.toContain('sk-secret-value');
    expect((got.result as { name: string }).name).toMatch(/•/);

    const list = await executeFunction(ctx, 'list_rows', { table: 'people' });
    const rows = list.result as { name: string }[];
    expect(rows[0]?.name).not.toContain('sk-secret-value');
  });

  it('rejects unknown tables, unknown functions, and non-dispatchable functions', async () => {
    const badTable = await executeFunction(ctx, 'list_rows', { table: 'ghosts' });
    expect(badTable.ok).toBe(false);
    expect(badTable.error).toMatch(/unknown table/i);

    const badFn = await executeFunction(ctx, 'nuke_everything', {});
    expect(badFn.ok).toBe(false);
    expect(badFn.error).toMatch(/unknown function/i);

    // create_entity is wired, but reports unavailable when the server didn't
    // supply a createEntity callback (the capability is opt-in per context).
    const noCallback = await executeFunction(ctx, 'create_entity', { name: 'x' });
    expect(noCallback.ok).toBe(false);
    expect(noCallback.error).toMatch(/not available/i);
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

  describe('deterministic list_rows ordering', () => {
    it('returns a stable, sorted-by-id order across repeated reads (no created_at)', async () => {
      // Insert out of id order; without an ORDER BY the engine could return these
      // in any order, and a different order each read is what made the assistant
      // report conflicting values for the same record.
      for (const [id, name] of [
        ['s3', 'Charlie'],
        ['s1', 'Alpha'],
        ['s2', 'Bravo'],
        ['s5', 'Echo'],
        ['s4', 'Delta'],
      ] as const) {
        await executeFunction(ctx, 'create_row', { table: 'people', values: { id, name } });
      }
      const first = (await executeFunction(ctx, 'list_rows', { table: 'people' })).result as {
        id: string;
      }[];
      const second = (await executeFunction(ctx, 'list_rows', { table: 'people' })).result as {
        id: string;
      }[];
      const ids1 = first.map((r) => r.id);
      expect(ids1).toEqual(['s1', 's2', 's3', 's4', 's5']); // sorted by id (no created_at column)
      expect(second.map((r) => r.id)).toEqual(ids1); // reproducible across reads
    });

    it('orders by created_at when that column exists', async () => {
      await db.defineLate('events', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', created_at: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: 'events.md',
      });
      const c: DispatchCtx = {
        ...ctx,
        validTables: new Set([...ctx.validTables, 'events']),
        softDeletable: new Set([...ctx.softDeletable, 'events']),
      };
      // id order (a < z) is deliberately the OPPOSITE of created_at order.
      await executeFunction(c, 'create_row', {
        table: 'events',
        values: { id: 'z', name: 'early', created_at: '2026-01-01T00:00:00Z' },
      });
      await executeFunction(c, 'create_row', {
        table: 'events',
        values: { id: 'a', name: 'late', created_at: '2026-01-03T00:00:00Z' },
      });
      const r1 = (await executeFunction(c, 'list_rows', { table: 'events' })).result as {
        id: string;
      }[];
      const r2 = (await executeFunction(c, 'list_rows', { table: 'events' })).result as {
        id: string;
      }[];
      expect(r1.map((x) => x.id)).toEqual(['z', 'a']); // created_at asc, NOT id asc
      expect(r2.map((x) => x.id)).toEqual(r1.map((x) => x.id));
    });

    it('handles empty and single-row tables without error', async () => {
      const empty = await executeFunction(ctx, 'list_rows', { table: 'people' });
      expect(empty.ok).toBe(true);
      expect((empty.result as unknown[]).length).toBe(0);
      await executeFunction(ctx, 'create_row', {
        table: 'people',
        values: { id: 's1', name: 'Alpha' },
      });
      const one = await executeFunction(ctx, 'list_rows', { table: 'people' });
      expect((one.result as { id: string }[]).map((r) => r.id)).toEqual(['s1']);
    });
  });

  describe('schema creation (create_entity / create_relationship)', () => {
    /** A ctx whose createEntity/createJunction actually build live tables. */
    function withSchemaCreation(): DispatchCtx {
      const createEntity = async (name: string, columns: string[]): Promise<string | null> => {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || ctx.validTables.has(name)) return null;
        const cols: Record<string, string> = { id: 'TEXT PRIMARY KEY' };
        for (const c of columns) if (/^[a-z][a-z0-9_]*$/.test(c)) cols[c] = 'TEXT';
        cols.deleted_at = 'TEXT';
        await db.defineLate(name, { columns: cols, render: () => '', outputFile: `${name}.md` });
        return name;
      };
      const createJunction = async (a: string, b: string) => {
        const junction = `${a}_${b}`;
        const aFk = `${a}_id`;
        const bFk = `${b}_id`;
        await db.defineLate(junction, {
          columns: { id: 'TEXT PRIMARY KEY', [aFk]: 'TEXT', [bFk]: 'TEXT' },
          render: () => '',
          outputFile: `${junction}.md`,
        });
        return { junction, tableA: a, aFk, tableB: b, bFk };
      };
      return { ...ctx, createEntity, createJunction };
    }

    it('creates a new table, then rows can be inserted into it', async () => {
      const c = withSchemaCreation();
      const made = await executeFunction(c, 'create_entity', {
        name: 'projects',
        columns: ['title', 'status'],
      });
      expect(made.ok).toBe(true);
      expect((made.result as { entity: string }).entity).toBe('projects');
      // The new table is immediately usable by a later tool call (same turn).
      const row = await executeFunction(c, 'create_row', {
        table: 'projects',
        values: { id: 'pr1', title: 'Legal AI Training', status: 'open' },
      });
      expect(row.ok).toBe(true);
      const got = await executeFunction(c, 'get_row', { table: 'projects', id: 'pr1' });
      expect((got.result as { title: string }).title).toBe('Legal AI Training');
    });

    it('creates a relationship junction, then link uses the returned FK columns', async () => {
      const c = withSchemaCreation();
      await executeFunction(c, 'create_entity', { name: 'projects', columns: ['title'] });
      const rel = await executeFunction(c, 'create_relationship', {
        table_a: 'projects',
        table_b: 'people',
      });
      expect(rel.ok).toBe(true);
      const { junction, link_columns } = rel.result as {
        junction: string;
        link_columns: Record<string, string>;
      };
      expect(junction).toBe('projects_people');
      expect(Object.keys(link_columns).sort()).toEqual(['people_id', 'projects_id']);

      await executeFunction(c, 'create_row', { table: 'projects', values: { id: 'pr1' } });
      await executeFunction(c, 'create_row', {
        table: 'people',
        values: { id: 'p1', name: 'Ada' },
      });
      const link = await executeFunction(c, 'link', {
        table: junction,
        values: { projects_id: 'pr1', people_id: 'p1' },
      });
      expect(link.ok).toBe(true);
      const links = await executeFunction(c, 'list_rows', { table: junction });
      expect((links.result as unknown[]).length).toBe(1);
    });
  });

  describe('search tool', () => {
    it('finds rows by content across the allowlisted tables', async () => {
      await executeFunction(ctx, 'create_row', {
        table: 'people',
        values: { id: 'p1', name: 'Ada Lovelace' },
      });
      await executeFunction(ctx, 'create_row', {
        table: 'people',
        values: { id: 'p2', name: 'Linus' },
      });

      const res = await executeFunction(ctx, 'search', { query: 'Lovelace' });
      expect(res.ok).toBe(true);
      const groups = (res.result as { groups: { table: string; hits: { id: string }[] }[] }).groups;
      const peopleHits = groups.find((g) => g.table === 'people')?.hits ?? [];
      expect(peopleHits.some((h) => h.id === 'p1')).toBe(true);
      expect(peopleHits.some((h) => h.id === 'p2')).toBe(false);
    });

    it('requires a query argument', async () => {
      const res = await executeFunction(ctx, 'search', {});
      expect(res.ok).toBe(false);
    });
  });

  describe('delete_entity tool (relay)', () => {
    it('reports unavailable when no deleteEntity handler is wired', async () => {
      const res = await executeFunction(ctx, 'delete_entity', { name: 'people' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not available/i);
    });

    it('relays needsResolution back to the model without deleting', async () => {
      const c: DispatchCtx = {
        ...ctx,
        deleteEntity: () =>
          Promise.resolve({ needsResolution: true, rowCount: 3, message: 'ask the user' }),
      };
      const res = await executeFunction(c, 'delete_entity', { name: 'people' });
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ needsResolution: true, rowCount: 3 });
    });

    it('passes a delete_data resolution through and drops the table from the allowlist', async () => {
      let seen: unknown;
      const c: DispatchCtx = {
        ...ctx,
        validTables: new Set(['people']),
        deleteEntity: (name, resolution) => {
          seen = { name, resolution };
          return Promise.resolve({ ok: true, deleted: name });
        },
      };
      const res = await executeFunction(c, 'delete_entity', {
        name: 'people',
        resolution: 'delete_data',
      });
      expect(res.ok).toBe(true);
      expect(seen).toEqual({ name: 'people', resolution: 'delete_data' });
      expect(c.validTables.has('people')).toBe(false);
    });

    it('parses move_to into a resolution object', async () => {
      let seen: unknown;
      const c: DispatchCtx = {
        ...ctx,
        deleteEntity: (name, resolution) => {
          seen = resolution;
          return Promise.resolve({ ok: true, deleted: name });
        },
      };
      await executeFunction(c, 'delete_entity', { name: 'people', move_to: 'contacts' });
      expect(seen).toEqual({ move_to: 'contacts' });
    });
  });
});
