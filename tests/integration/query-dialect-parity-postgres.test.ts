/**
 * Cross-dialect parity: the query primitives whose SQL differs between SQLite and
 * Postgres (jsonPath extraction, aggregation, distinctOn, keyset pagination) must
 * return the SAME logical result on both. The existing per-dialect suites assert
 * each dialect against hardcoded expectations independently; this asserts the two
 * dialects against EACH OTHER on identical data, so a divergence (e.g. distinctOn
 * row order, jsonb-vs-json_extract typing, aggregate coercion) can't slip through.
 *
 * Numeric values are normalized before comparison (Postgres returns numeric/bigint
 * as strings; SQLite as numbers) — the comparison is of logical equality, applied
 * identically to both sides.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import type { QueryOptions, AggregateOptions, QueryPageOptions } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const ROWS = [
  {
    id: 'r1',
    name: 'alpha',
    category: 'a',
    score: 5,
    total: 1.5,
    meta: JSON.stringify({ tier: 'gold', n: 7 }),
  },
  {
    id: 'r2',
    name: 'bravo',
    category: 'b',
    score: 9,
    total: 2.5,
    meta: JSON.stringify({ tier: 'silver', n: 3 }),
  },
  {
    id: 'r3',
    name: 'charlie',
    category: 'a',
    score: 7,
    total: 3.5,
    meta: JSON.stringify({ tier: 'gold', n: 9 }),
  },
  {
    id: 'r4',
    name: 'delta',
    category: 'c',
    score: 2,
    total: 4.5,
    meta: JSON.stringify({ tier: 'bronze', n: 1 }),
  },
  {
    id: 'r5',
    name: 'echo',
    category: 'b',
    score: 8,
    total: 5.5,
    meta: JSON.stringify({ tier: 'silver', n: 5 }),
  },
  {
    id: 'r6',
    name: 'foxtrot',
    category: 'a',
    score: 6,
    total: 6.5,
    meta: JSON.stringify({ tier: 'gold', n: 2 }),
  },
];

/** Logical-equality normal form: numeric strings → numbers, keys sorted; optionally row-sorted. */
function norm(rows: Record<string, unknown>[], sortRows: boolean): string {
  const fixVal = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return v;
  };
  const mapped = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r).sort()) o[k] = fixVal(r[k]);
    return o;
  });
  const ordered = sortRows
    ? [...mapped].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : mapped;
  return JSON.stringify(ordered);
}

describe.skipIf(!PG_URL)('query primitives — SQLite vs Postgres parity', () => {
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_parity_${runId}`;
  let lite: Lattice;
  let pg: Lattice;

  async function seed(db: Lattice): Promise<void> {
    db.define(table, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        category: 'TEXT',
        score: 'INTEGER',
        total: 'REAL',
        meta: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    for (const r of ROWS) await db.insert(table, r);
  }

  beforeAll(async () => {
    lite = new Lattice(':memory:');
    pg = new Lattice(PG_URL!);
    await seed(lite);
    await seed(pg);
  });

  afterAll(async () => {
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    try {
      await runAsyncOrSync(pg.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
    } catch {
      /* best effort */
    }
    lite.close();
    pg.close();
  });

  async function bothQuery(opts: QueryOptions, sortRows = false): Promise<void> {
    const a = await lite.query(table, opts);
    const b = await pg.query(table, opts);
    expect(norm(a, sortRows)).toEqual(norm(b, sortRows));
    expect(a.length).toBeGreaterThan(0); // guard against both-empty false parity
  }

  it('filtered query (OR + numeric) is identical, ordered', async () => {
    await bothQuery({
      filters: [
        {
          or: [
            { col: 'score', op: 'gte', val: 7 },
            { col: 'category', op: 'eq', val: 'c' },
          ],
        },
      ],
      orderBy: 'id',
    });
  });

  it('jsonPath filter (string + numeric) is identical, ordered', async () => {
    await bothQuery({
      filters: [{ col: 'meta', jsonPath: 'tier', op: 'eq', val: 'gold' }],
      orderBy: 'id',
    });
    await bothQuery({
      filters: [{ col: 'meta', jsonPath: 'n', op: 'gte', val: 5 }],
      orderBy: 'id',
    });
  });

  it('aggregate (GROUP BY + count/sum/avg, ordered) is identical', async () => {
    const opts: AggregateOptions = {
      groupBy: ['category'],
      aggregates: [
        { fn: 'count', as: 'n' },
        { fn: 'sum', col: 'score', as: 'total_score' },
        { fn: 'avg', col: 'total', as: 'avg_total' },
      ],
      orderBy: 'category',
    };
    const a = await lite.aggregate(table, opts);
    const b = await pg.aggregate(table, opts);
    expect(norm(a, false)).toEqual(norm(b, false));
  });

  it('distinctOn returns the same row set on both dialects', async () => {
    // One row per category, picking the highest score. Output ORDER is not
    // guaranteed equal across dialects without a final sort, so compare as a set.
    const opts: QueryOptions = { distinctOn: 'category', orderBy: 'score', orderDir: 'desc' };
    await (async () => {
      const a = await lite.query(table, opts);
      const b = await pg.query(table, opts);
      expect(norm(a, true)).toEqual(norm(b, true));
      expect(a.map((r) => r.category).sort()).toEqual(['a', 'b', 'c']);
    })();
  });

  it('keyset pagination (queryPage) walks identically across dialects', async () => {
    const opts: QueryPageOptions = { orderBy: 'score', orderDir: 'asc', limit: 2 };
    let curLite: string | null = null;
    let curPg: string | null = null;
    for (let page = 0; page < 4; page++) {
      const pa = await lite.queryPage(table, { ...opts, ...(curLite ? { cursor: curLite } : {}) });
      const pb = await pg.queryPage(table, { ...opts, ...(curPg ? { cursor: curPg } : {}) });
      expect(norm(pa.rows, false)).toEqual(norm(pb.rows, false)); // ordered: keyset is a total order
      expect(pa.hasMore).toBe(pb.hasMore);
      curLite = pa.nextCursor;
      curPg = pb.nextCursor;
      if (!pa.hasMore) break;
    }
  });
});
