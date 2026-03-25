import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

describe('Expanded query filters', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        score: 'INTEGER DEFAULT 0',
        tag: 'TEXT',
        note: 'TEXT',
      },
      render: () => '',
      outputFile: 'items.md',
    });
    await db.init();

    // Seed rows
    await db.insert('items', { id: 'a', name: 'Alpha', score: 10, tag: 'bug' });
    await db.insert('items', { id: 'b', name: 'Beta', score: 50, tag: 'feature' });
    await db.insert('items', { id: 'c', name: 'Gamma', score: 80, tag: 'bug' });
    await db.insert('items', {
      id: 'd',
      name: 'Delta',
      score: 80,
      tag: null as unknown as string,
      note: 'annotated',
    });
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Comparison operators
  // -------------------------------------------------------------------------

  it('gt — returns rows with score > 50', async () => {
    const rows = await db.query('items', { filters: [{ col: 'score', op: 'gt', val: 50 }] });
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['c', 'd']));
    expect(rows).toHaveLength(2);
  });

  it('gte — returns rows with score >= 50', async () => {
    const rows = await db.query('items', { filters: [{ col: 'score', op: 'gte', val: 50 }] });
    expect(rows).toHaveLength(3);
  });

  it('lt — returns rows with score < 50', async () => {
    const rows = await db.query('items', { filters: [{ col: 'score', op: 'lt', val: 50 }] });
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('lte — returns rows with score <= 50', async () => {
    const rows = await db.query('items', { filters: [{ col: 'score', op: 'lte', val: 50 }] });
    expect(rows).toHaveLength(2);
  });

  it('ne — excludes the matched value', async () => {
    const rows = await db.query('items', { filters: [{ col: 'tag', op: 'ne', val: 'bug' }] });
    // 'feature' row and NULL row both match != 'bug' in SQLite
    expect(rows.map((r) => r.id)).toContain('b');
  });

  it('eq — same as equality where', async () => {
    const rows = await db.query('items', { filters: [{ col: 'score', op: 'eq', val: 80 }] });
    expect(rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Pattern matching
  // -------------------------------------------------------------------------

  it('like — matches prefix pattern', async () => {
    const rows = await db.query('items', { filters: [{ col: 'name', op: 'like', val: 'A%' }] });
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('like — matches substring pattern', async () => {
    const rows = await db.query('items', { filters: [{ col: 'name', op: 'like', val: '%a%' }] });
    // Alpha (a), Beta (a), Gamma (a), Delta (a) — SQLite LIKE is case-insensitive for ASCII
    expect(rows).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // IN list
  // -------------------------------------------------------------------------

  it('in — returns rows whose column value is in the list', async () => {
    const rows = await db.query('items', {
      filters: [{ col: 'tag', op: 'in', val: ['bug', 'feature'] }],
    });
    expect(rows).toHaveLength(3);
  });

  it('in — empty array produces no clause (all rows returned)', async () => {
    const rows = await db.query('items', { filters: [{ col: 'tag', op: 'in', val: [] }] });
    expect(rows).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // NULL checks
  // -------------------------------------------------------------------------

  it('isNull — returns rows where the column IS NULL', async () => {
    const rows = await db.query('items', { filters: [{ col: 'tag', op: 'isNull' }] });
    expect(rows.map((r) => r.id)).toEqual(['d']);
  });

  it('isNotNull — returns rows where the column IS NOT NULL', async () => {
    const rows = await db.query('items', { filters: [{ col: 'tag', op: 'isNotNull' }] });
    expect(rows).toHaveLength(3);
  });

  it('isNull — works on a text column with some NULL, some values', async () => {
    const rows = await db.query('items', { filters: [{ col: 'note', op: 'isNull' }] });
    expect(rows).toHaveLength(3); // a, b, c have no note
  });

  it('isNotNull — picks up the single row with a note', async () => {
    const rows = await db.query('items', { filters: [{ col: 'note', op: 'isNotNull' }] });
    expect(rows.map((r) => r.id)).toEqual(['d']);
  });

  // -------------------------------------------------------------------------
  // Combining where + filters (AND semantics)
  // -------------------------------------------------------------------------

  it('where + filters are ANDed together', async () => {
    const rows = await db.query('items', {
      where: { tag: 'bug' },
      filters: [{ col: 'score', op: 'gt', val: 50 }],
    });
    // tag='bug' AND score>50 → only Gamma
    expect(rows.map((r) => r.id)).toEqual(['c']);
  });

  it('multiple filters are ANDed', async () => {
    const rows = await db.query('items', {
      filters: [
        { col: 'score', op: 'gte', val: 50 },
        { col: 'score', op: 'lte', val: 80 },
        { col: 'tag', op: 'eq', val: 'bug' },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['c']);
  });

  // -------------------------------------------------------------------------
  // count() with filters
  // -------------------------------------------------------------------------

  it('count() respects filters', async () => {
    const n = await db.count('items', { filters: [{ col: 'score', op: 'gt', val: 20 }] });
    expect(n).toBe(3); // b (50), c (80), d (80)
  });

  it('count() combines where + filters', async () => {
    const n = await db.count('items', {
      where: { tag: 'bug' },
      filters: [{ col: 'score', op: 'lt', val: 80 }],
    });
    expect(n).toBe(1); // only Alpha (tag=bug, score=10)
  });

  // -------------------------------------------------------------------------
  // Backward compat — existing where still works without filters
  // -------------------------------------------------------------------------

  it('where-only query still works identically to pre-v0.2', async () => {
    const rows = await db.query('items', { where: { tag: 'bug' } });
    expect(rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Column name validation — read path security (MEDIUM finding, 2026-03-25)
  // -------------------------------------------------------------------------

  it('query() rejects unknown column in where', async () => {
    await expect(db.query('items', { where: { nonexistent: 'x' } })).rejects.toThrow(
      'unknown column "nonexistent" in table "items"',
    );
  });

  it('query() rejects unknown column in filters', async () => {
    await expect(
      db.query('items', { filters: [{ col: 'ghost', op: 'eq', val: 1 }] }),
    ).rejects.toThrow('unknown column "ghost" in table "items"');
  });

  it('query() rejects unknown column in orderBy', async () => {
    await expect(db.query('items', { orderBy: 'missing' })).rejects.toThrow(
      'unknown column "missing" in table "items"',
    );
  });

  it('count() rejects unknown column in where', async () => {
    await expect(db.count('items', { where: { nonexistent: 'x' } })).rejects.toThrow(
      'unknown column "nonexistent" in table "items"',
    );
  });

  it('count() rejects unknown column in filters', async () => {
    await expect(
      db.count('items', { filters: [{ col: 'ghost', op: 'gt', val: 0 }] }),
    ).rejects.toThrow('unknown column "ghost" in table "items"');
  });

  it('query() with valid columns succeeds after column validation added', async () => {
    const rows = await db.query('items', {
      where: { tag: 'bug' },
      filters: [{ col: 'score', op: 'gt', val: 5 }],
      orderBy: 'name',
    });
    expect(rows).toHaveLength(2);
  });
});
