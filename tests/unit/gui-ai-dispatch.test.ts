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
    it('returns a stable order across repeated reads; newest-first by id (no date column)', async () => {
      // Insert out of id order; without an ORDER BY the engine could return these
      // in any order, and a different order each read is what made the assistant
      // report conflicting values for the same record. Default direction is desc.
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
      expect(ids1).toEqual(['s5', 's4', 's3', 's2', 's1']); // by id, DESC (no date column)
      expect(second.map((r) => r.id)).toEqual(ids1); // reproducible across reads
    });

    it('orders by created_at NEWEST-first when that column exists', async () => {
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
      expect(r1.map((x) => x.id)).toEqual(['a', 'z']); // created_at DESC (late first), NOT id
      expect(r2.map((x) => x.id)).toEqual(r1.map((x) => x.id));
    });

    it('prefers a domain event-time column (start_at) over created_at, newest-first', async () => {
      // The bug: a meeting for July 2 that SYNCED in April carries an April
      // created_at, so a created_at sort buried it. start_at is the real event time.
      await db.defineLate('meetings', {
        columns: {
          id: 'TEXT PRIMARY KEY',
          title: 'TEXT',
          start_at: 'TEXT',
          created_at: 'TEXT',
          deleted_at: 'TEXT',
        },
        render: () => '',
        outputFile: 'meetings.md',
      });
      const c: DispatchCtx = {
        ...ctx,
        validTables: new Set([...ctx.validTables, 'meetings']),
        softDeletable: new Set([...ctx.softDeletable, 'meetings']),
      };
      // created_at is INVERTED vs start_at: the July-2 meeting was created EARLIEST.
      await executeFunction(c, 'create_row', {
        table: 'meetings',
        values: {
          id: 'm_today',
          title: 'today',
          start_at: '2026-07-02T15:00:00Z',
          created_at: '2026-04-01T00:00:00Z',
        },
      });
      await executeFunction(c, 'create_row', {
        table: 'meetings',
        values: {
          id: 'm_april',
          title: 'april',
          start_at: '2026-04-09T14:55:00Z',
          created_at: '2026-06-01T00:00:00Z',
        },
      });
      const rows = (await executeFunction(c, 'list_rows', { table: 'meetings' })).result as {
        id: string;
      }[];
      // Today's meeting comes FIRST — sorted by start_at desc, not created_at.
      expect(rows.map((x) => x.id)).toEqual(['m_today', 'm_april']);

      // The model can still ask for oldest-first with orderDir:'asc'.
      const asc = (await executeFunction(c, 'list_rows', { table: 'meetings', orderDir: 'asc' }))
        .result as { id: string }[];
      expect(asc.map((x) => x.id)).toEqual(['m_april', 'm_today']);

      // ...and filter by a date range (today only).
      const todayOnly = (
        await executeFunction(c, 'list_rows', {
          table: 'meetings',
          filter: [{ col: 'start_at', op: 'gte', val: '2026-07-01T00:00:00Z' }],
        })
      ).result as { id: string }[];
      expect(todayOnly.map((x) => x.id)).toEqual(['m_today']);
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

  describe('read_file_text (single-file paging)', () => {
    // A files table + one big row, so we can page a body larger than one window.
    async function seedBigFile(chars: number): Promise<string> {
      await db.defineLate('files', {
        columns: {
          id: 'TEXT PRIMARY KEY',
          original_name: 'TEXT',
          extracted_text: 'TEXT',
          source_json: 'TEXT',
          deleted_at: 'TEXT',
        },
        render: () => '',
        outputFile: 'files.md',
      });
      const id = 'file-1';
      // Distinct content per 10k block so we can prove windows are contiguous.
      let body = '';
      while (body.length < chars) body += `[block@${body.length}]` + 'x'.repeat(9970);
      body = body.slice(0, chars);
      await db.insert('files', { id, original_name: 'big.html', extracted_text: body });
      ctx = { ...ctx, validTables: new Set([...ctx.validTables, 'files']) };
      return id;
    }

    it('returns the first window with totalChars and a nextOffset for a big file', async () => {
      const id = await seedBigFile(150_000);
      const r = await executeFunction(ctx, 'read_file_text', { id });
      expect(r.ok).toBe(true);
      const res = r.result as {
        totalChars: number;
        offset: number;
        returnedChars: number;
        nextOffset: number | null;
        text: string;
      };
      expect(res.totalChars).toBe(150_000);
      expect(res.offset).toBe(0);
      expect(res.returnedChars).toBe(60_000);
      expect(res.nextOffset).toBe(60_000);
      expect(res.text.startsWith('[block@0]')).toBe(true);
    });

    it('pages to the end: following nextOffset covers the whole file exactly once', async () => {
      const id = await seedBigFile(150_000);
      let offset: number | null = 0;
      let assembled = '';
      let calls = 0;
      while (offset !== null && calls < 10) {
        const r = await executeFunction(ctx, 'read_file_text', { id, offset });
        const res = r.result as { text: string; nextOffset: number | null };
        assembled += res.text;
        offset = res.nextOffset;
        calls++;
      }
      expect(calls).toBe(3); // 150k / 60k → 3 windows
      expect(assembled.length).toBe(150_000);
      expect(offset).toBeNull();
    });

    it('a small file returns everything in one window with a null nextOffset', async () => {
      const id = await seedBigFile(500);
      const r = await executeFunction(ctx, 'read_file_text', { id });
      const res = r.result as { returnedChars: number; nextOffset: number | null };
      expect(res.returnedChars).toBe(500);
      expect(res.nextOffset).toBeNull();
    });

    it('errors clearly for a missing file id', async () => {
      await seedBigFile(500);
      const r = await executeFunction(ctx, 'read_file_text', { id: 'nope' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Row not found');
    });
  });
});
