import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { BoundedReadError } from '../../src/query/core.js';

/**
 * p2 — Query primitives I: bounded reads, projection, OR/AND + jsonPath filters,
 * and SQL-side aggregation (SQLite).
 */
describe('p2 query primitives (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(opts?: { defaultMaxRows?: number }): Promise<Lattice> {
    db = opts?.defaultMaxRows
      ? new Lattice(':memory:', { defaultMaxRows: opts.defaultMaxRows })
      : new Lattice(':memory:');
    db.define('items', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        status: 'TEXT',
        priority: 'INTEGER',
        total: 'REAL',
        meta: 'TEXT', // JSON blob
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'i.md',
    });
    await db.init();
    return db;
  }

  // --- P-BOUND ------------------------------------------------------------
  describe('bounded reads', () => {
    it('throws BoundedReadError when a query exceeds maxRows with no explicit limit', async () => {
      const d = await setup();
      for (let i = 0; i < 5; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      await expect(d.query('items', { maxRows: 3 })).rejects.toBeInstanceOf(BoundedReadError);
    });

    it('returns rows when within maxRows', async () => {
      const d = await setup();
      for (let i = 0; i < 3; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      const rows = await d.query('items', { maxRows: 5 });
      expect(rows).toHaveLength(3);
    });

    it('an explicit limit opts out of the cap', async () => {
      const d = await setup();
      for (let i = 0; i < 10; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      const rows = await d.query('items', { maxRows: 3, limit: 5 });
      expect(rows).toHaveLength(5);
    });

    it('LatticeOptions.defaultMaxRows applies the cap globally', async () => {
      const d = await setup({ defaultMaxRows: 2 });
      for (let i = 0; i < 4; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      await expect(d.query('items', {})).rejects.toBeInstanceOf(BoundedReadError);
      // explicit limit still escapes the default cap
      expect(await d.query('items', { limit: 4 })).toHaveLength(4);
    });
  });

  // --- P-PROJECT ----------------------------------------------------------
  describe('projection', () => {
    it('returns only included columns (array form)', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', name: 'a', status: 'open', priority: 5 });
      const rows = await d.query('items', { projection: ['id', 'name'] });
      expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'name']);
    });

    it('supports { include } and { exclude }', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', name: 'a', status: 'open', priority: 5 });
      const inc = await d.query('items', { projection: { include: ['id', 'status'] } });
      expect(Object.keys(inc[0]!).sort()).toEqual(['id', 'status']);
      const exc = await d.query('items', { projection: { exclude: ['meta', 'deleted_at'] } });
      expect(Object.keys(exc[0]!)).not.toContain('meta');
      expect(Object.keys(exc[0]!)).toContain('name');
    });
  });

  // --- P-FILTER -----------------------------------------------------------
  describe('OR / AND groups + jsonPath', () => {
    it('matches an OR group', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', status: 'open', priority: 1 });
      await d.insert('items', { id: 'i2', status: 'closed', priority: 9 });
      await d.insert('items', { id: 'i3', status: 'pending', priority: 2 });
      const rows = await d.query('items', {
        filters: [
          {
            or: [
              { col: 'status', op: 'eq', val: 'open' },
              { col: 'priority', op: 'gte', val: 9 },
            ],
          },
        ],
        orderBy: 'id',
      });
      expect(rows.map((r) => r.id)).toEqual(['i1', 'i2']);
    });

    it('combines top-level AND with a nested OR', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', status: 'open', priority: 5 });
      await d.insert('items', { id: 'i2', status: 'open', priority: 1 });
      await d.insert('items', { id: 'i3', status: 'closed', priority: 5 });
      const rows = await d.query('items', {
        filters: [
          { col: 'status', op: 'eq', val: 'open' },
          {
            or: [
              { col: 'priority', op: 'gte', val: 5 },
              { col: 'priority', op: 'eq', val: 1 },
            ],
          },
        ],
        orderBy: 'id',
      });
      expect(rows.map((r) => r.id)).toEqual(['i1', 'i2']);
    });

    it('filters by a jsonPath into a JSON column', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', meta: JSON.stringify({ tier: 'gold', n: 3 }) });
      await d.insert('items', { id: 'i2', meta: JSON.stringify({ tier: 'silver', n: 7 }) });
      const gold = await d.query('items', {
        filters: [{ col: 'meta', jsonPath: 'tier', op: 'eq', val: 'gold' }],
      });
      expect(gold.map((r) => r.id)).toEqual(['i1']);
      const highN = await d.query('items', {
        filters: [{ col: 'meta', jsonPath: 'n', op: 'gte', val: 5 }],
      });
      expect(highN.map((r) => r.id)).toEqual(['i2']);
    });
  });

  // --- P-AGG --------------------------------------------------------------
  describe('aggregate', () => {
    it('computes grouped count + sum + avg', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', status: 'open', total: 10 });
      await d.insert('items', { id: 'i2', status: 'open', total: 30 });
      await d.insert('items', { id: 'i3', status: 'closed', total: 5 });
      const rows = await d.aggregate('items', {
        groupBy: ['status'],
        aggregates: [
          { fn: 'count', as: 'n' },
          { fn: 'sum', col: 'total', as: 'revenue' },
          { fn: 'avg', col: 'total', as: 'avg_total' },
        ],
        orderBy: 'status',
      });
      expect(rows).toHaveLength(2);
      const open = rows.find((r) => r.status === 'open')!;
      expect(open.n).toBe(2);
      expect(open.revenue).toBe(40);
      expect(open.avg_total).toBe(20);
    });

    it('applies a HAVING clause on an aggregate output', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', status: 'open' });
      await d.insert('items', { id: 'i2', status: 'open' });
      await d.insert('items', { id: 'i3', status: 'closed' });
      const rows = await d.aggregate('items', {
        groupBy: ['status'],
        aggregates: [{ fn: 'count', as: 'n' }],
        having: [{ aggregate: 'n', op: 'gt', val: 1 }],
      });
      expect(rows.map((r) => r.status)).toEqual(['open']);
    });

    it('supports COUNT(DISTINCT col) and a grand total (no groupBy)', async () => {
      const d = await setup();
      await d.insert('items', { id: 'i1', status: 'open' });
      await d.insert('items', { id: 'i2', status: 'open' });
      await d.insert('items', { id: 'i3', status: 'closed' });
      const total = await d.aggregate('items', {
        aggregates: [
          { fn: 'count', as: 'rows' },
          { fn: 'count', col: 'status', as: 'statuses', distinct: true },
        ],
      });
      expect(total[0]!.rows).toBe(3);
      expect(total[0]!.statuses).toBe(2);
    });

    it('throws when no aggregate is specified', async () => {
      const d = await setup();
      await expect(d.aggregate('items', { aggregates: [] })).rejects.toThrow(/at least one/);
    });
  });

  // --- P-BOUNDED-COUNT ----------------------------------------------------
  // The pagination total: bounded so it never becomes an O(table) COUNT, exact
  // below the cap, and respects the same WHERE/filters as the row fetch.
  describe('boundedCount', () => {
    it('returns the exact count when below the cap', async () => {
      const d = await setup();
      for (let i = 0; i < 7; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      expect(await d.boundedCount('items', { cap: 100 })).toBe(7);
    });

    it('stops at cap + 1 for a table larger than the cap', async () => {
      const d = await setup();
      for (let i = 0; i < 12; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      // 12 rows, cap 5 → the scan stops after 6 (cap+1); the caller renders "5+".
      expect(await d.boundedCount('items', { cap: 5 })).toBe(6);
    });

    it('honors a filter (e.g. the deleted_at soft-delete clause)', async () => {
      const d = await setup();
      for (let i = 0; i < 4; i++) await d.insert('items', { id: `live${String(i)}`, name: 'x' });
      await d.insert('items', { id: 'gone', name: 'x', deleted_at: '2026-01-01' });
      const live = await d.boundedCount('items', {
        cap: 100,
        filters: [{ col: 'deleted_at', op: 'isNull' }],
      });
      expect(live).toBe(4); // the soft-deleted row is excluded, same as the row fetch
    });

    it('defaults the cap to 1000 when none is given', async () => {
      const d = await setup();
      for (let i = 0; i < 3; i++) await d.insert('items', { id: `i${String(i)}`, name: 'x' });
      expect(await d.boundedCount('items')).toBe(3);
    });
  });
});
