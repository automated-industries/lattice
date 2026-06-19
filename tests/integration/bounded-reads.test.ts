import { describe, it, expect } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import type { StorageAdapter } from '../../src/db/adapter.js';

/**
 * v4.0: getActive + queryTable accept an optional { limit, offset } bound. Omitting
 * it is byte-identical to the prior unbounded read (every existing caller is
 * unchanged); a bound caps the read in SQL (parameterized) so a consumer can avoid
 * pulling a whole table. (The GUI hot-path listings are already bounded at the
 * route layer via parsePageParam; this adds the capability to the read API itself.)
 */
async function makeDb(): Promise<Lattice> {
  const db = new Lattice(':memory:');
  db.define('items', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();
  for (const n of ['a', 'b', 'c', 'd', 'e']) await db.insert('items', { id: n, name: n });
  return db;
}

describe('bounded reads — getActive / queryTable optional limit/offset', () => {
  it('returns all rows when no bound is given (default unchanged)', async () => {
    const db = await makeDb();
    expect((await db.getActive('items')).length).toBe(5);
    db.close();
  });

  it('caps with limit', async () => {
    const db = await makeDb();
    const rows = await db.getActive('items', 'name', { limit: 2 });
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
    db.close();
  });

  it('paginates with limit + offset', async () => {
    const db = await makeDb();
    const rows = await db.getActive('items', 'name', { limit: 2, offset: 2 });
    expect(rows.map((r) => r.name)).toEqual(['c', 'd']);
    db.close();
  });

  it('ignores a bare offset (SQL OFFSET requires LIMIT) — returns all rows', async () => {
    const db = await makeDb();
    expect((await db.getActive('items', 'name', { offset: 3 })).length).toBe(5);
    db.close();
  });

  it('rejects a non-integer / negative limit (no silent NaN/coercion)', async () => {
    const db = await makeDb();
    await expect(db.getActive('items', 'name', { limit: -1 })).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(db.getActive('items', 'name', { limit: 1.5 })).rejects.toThrow(
      /non-negative integer/,
    );
    db.close();
  });

  it('queryTable honors the bound + is unbounded by default', async () => {
    const db = await makeDb();
    const schema = (
      db as unknown as {
        _schema: {
          queryTable: (
            a: StorageAdapter,
            n: string,
            r?: (t: string) => string,
            o?: { limit?: number; offset?: number },
          ) => Promise<unknown[]>;
        };
      }
    )._schema;
    const adapter = (db as unknown as { _adapter: StorageAdapter })._adapter;
    expect((await schema.queryTable(adapter, 'items', undefined, { limit: 3 })).length).toBe(3);
    expect((await schema.queryTable(adapter, 'items')).length).toBe(5);
    db.close();
  });
});
