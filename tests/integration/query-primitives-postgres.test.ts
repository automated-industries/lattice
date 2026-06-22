/**
 * Postgres dialect-parity for p2 query primitives: bounded reads, projection,
 * OR/AND + jsonPath filters (the jsonb `#>>` path with numeric casting), and
 * SQL-side aggregation (string→number coercion).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import { BoundedReadError } from '../../src/query/core.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('p2 query primitives (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_items`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        status: 'TEXT',
        priority: 'INTEGER',
        total: 'REAL',
        meta: 'JSONB',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('bounded read throws on overflow', async () => {
    for (let i = 0; i < 4; i++) await db.insert(table, { id: `b${String(i)}`, name: 'x' });
    await expect(db.query(table, { maxRows: 2, where: { name: 'x' } })).rejects.toBeInstanceOf(
      BoundedReadError,
    );
  });

  it('projection returns only requested columns', async () => {
    await db.insert(table, { id: 'p1', name: 'a', status: 'open' });
    const rows = await db.query(table, { projection: ['id', 'name'], where: { id: 'p1' } });
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'name']);
  });

  it('OR group + numeric jsonPath on jsonb', async () => {
    await db.insert(table, { id: 'j1', status: 'open', priority: 1, meta: { tier: 'gold', n: 3 } });
    await db.insert(table, {
      id: 'j2',
      status: 'closed',
      priority: 9,
      meta: { tier: 'silver', n: 7 },
    });

    const or = await db.query(table, {
      filters: [
        {
          or: [
            { col: 'id', op: 'eq', val: 'j1' },
            { col: 'priority', op: 'gte', val: 9 },
          ],
        },
      ],
      orderBy: 'id',
    });
    // j1 (id match) + j2 (priority 9)
    expect(
      or
        .map((r) => r.id)
        .filter((x) => x === 'j1' || x === 'j2')
        .sort(),
    ).toEqual(['j1', 'j2']);

    const highN = await db.query(table, {
      filters: [{ col: 'meta', jsonPath: 'n', op: 'gte', val: 5 }],
      orderBy: 'id',
    });
    expect(highN.map((r) => r.id)).toContain('j2');
    expect(highN.map((r) => r.id)).not.toContain('j1');

    const gold = await db.query(table, {
      filters: [{ col: 'meta', jsonPath: 'tier', op: 'eq', val: 'gold' }],
    });
    expect(gold.map((r) => r.id)).toEqual(['j1']);
  });

  it('aggregate coerces sum/count/avg to numbers on Postgres', async () => {
    const t2 = `__lattice_test_${runId}_orders`;
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "${t2}" (id TEXT PRIMARY KEY, status TEXT, total REAL, deleted_at TEXT)`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "${t2}" (id,status,total) VALUES ('o1','open',10)`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "${t2}" (id,status,total) VALUES ('o2','open',30)`,
    );
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "${t2}" (id,status,total) VALUES ('o3','closed',5)`,
    );

    const rows = await db.aggregate(t2, {
      groupBy: ['status'],
      aggregates: [
        { fn: 'count', as: 'n' },
        { fn: 'sum', col: 'total', as: 'revenue' },
      ],
      having: [{ aggregate: 'n', op: 'gt', val: 1 }],
      orderBy: 'status',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.n).toBe(2);
    expect(rows[0]!.revenue).toBe(40);
    await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t2}" CASCADE`);
  });
});
