import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { fullTextSearch } from '../../src/search/fts.js';

/**
 * Full-text search — Phase 1 (LIKE fallback). The engine is read-only: it
 * creates no indexes/tables and adds no write hook, so a bare-Lattice consumer
 * inherits zero overhead (the GUARDRAIL test below locks that in).
 */
describe('fullTextSearch (Phase 1 LIKE fallback)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', summary: 'TEXT' },
      render: () => '',
      outputFile: 't.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', title: 'Quarterly review', body: 'discuss the budget' });
    await db.insert('notes', { id: 'n2', title: 'Grocery list', body: 'milk and eggs' });
    await db.insert('notes', {
      id: 'n3',
      title: 'Old budget note',
      body: 'archived',
      deleted_at: '2020-01-01',
    });
    await db.insert('tasks', { id: 't1', summary: 'Approve the budget' });
    return db;
  }

  it('finds matches across tables, grouped, with snippets', async () => {
    const d = await setup();
    const r = await fullTextSearch(d.adapter, ['notes', 'tasks'], { query: 'budget' });
    const byTable = new Map(r.groups.map((g) => [g.table, g]));
    // n1 (body) matches; n3 is soft-deleted → excluded; t1 (summary) matches.
    expect(byTable.get('notes')?.hits.map((h) => h.id)).toEqual(['n1']);
    expect(byTable.get('tasks')?.hits.map((h) => h.id)).toEqual(['t1']);
    expect(byTable.get('notes')?.hits[0]?.snippet).toContain('budget');
  });

  it('excludes soft-deleted rows', async () => {
    const d = await setup();
    const r = await fullTextSearch(d.adapter, ['notes'], { query: 'archived' });
    expect(r.groups).toEqual([]); // the only "archived" row (n3) is soft-deleted
  });

  it('respects limitPerTable and sets `more`', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    for (let i = 0; i < 5; i++)
      await db.insert('notes', { id: `n${String(i)}`, body: `find me ${String(i)}` });
    const r = await fullTextSearch(db.adapter, ['notes'], { query: 'find me', limitPerTable: 3 });
    expect(r.groups[0]?.count).toBe(3);
    expect(r.groups[0]?.more).toBe(true);
  });

  it('treats LIKE wildcards in the query literally', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'a', body: '100% done' });
    await db.insert('notes', { id: 'b', body: 'nothing here' });
    const hit = await fullTextSearch(db.adapter, ['notes'], { query: '100%' });
    expect(hit.groups[0]?.hits.map((h) => h.id)).toEqual(['a']);
    // A bare '%' is escaped, so it matches the literal '%' in '100% done', not everything.
    const wild = await fullTextSearch(db.adapter, ['notes'], { query: '%' });
    expect(wild.groups[0]?.hits.map((h) => h.id)).toEqual(['a']);
  });

  it('GUARDRAIL: searching a bare Lattice creates no FTS objects', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('notes', { id: 'n1', body: 'hello world' });
    const objects = () =>
      (
        db!.adapter.all(
          "SELECT name FROM sqlite_master WHERE type IN ('table','index','view') ORDER BY name",
        ) as { name: string }[]
      ).map((r) => r.name);
    const before = objects();
    await fullTextSearch(db.adapter, ['notes'], { query: 'hello' });
    // Read-only: the search must not create any FTS5 virtual table / index / view.
    expect(objects()).toEqual(before);
  });
});
