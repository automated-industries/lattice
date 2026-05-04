/**
 * Postgres integration test for `Lattice.query()` going through the async
 * adapter surface end-to-end.
 *
 * Why this exists:
 *   PR 2 of the async-adapter rewrite flips lattice core to prefer the
 *   adapter's async surface over the sync surface when both are present
 *   (the Postgres path). The unit-test suite uses SQLite (sync-only), so it
 *   exercises only the fallback branch. This test runs the same code paths
 *   against a real Postgres so the Postgres dialect translation, the
 *   pool-based query path, and the result-row shape are all validated
 *   together. Mirrors the lesson from
 *   `feedback_test_against_target_dialect.md` — SQLite-only unit tests hid
 *   a Postgres typo that crashed dev. Don't repeat that.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 *
 * Without the env var the suite skips. CI provides a postgres:16 service
 * container so this test always runs there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice.query (Postgres async integration)', () => {
  let db: Lattice;
  // Per-run prefix so parallel CI runs against the same DB don't collide.
  const runId = randomBytes(4).toString('hex');
  const tableName = `__lattice_test_${runId}_query`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(tableName, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        score: 'INTEGER',
        team: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();

    await db.insert(tableName, { id: 'a', name: 'Alice', score: 90, team: 'red' });
    await db.insert(tableName, { id: 'b', name: 'Bob', score: 80, team: 'red' });
    await db.insert(tableName, { id: 'c', name: 'Charlie', score: 70, team: 'blue' });
    await db.insert(tableName, { id: 'd', name: 'Diana', score: null, team: 'blue' });
    await db.insert(tableName, {
      id: 'e',
      name: 'Eve',
      score: 60,
      team: 'red',
      deleted_at: '2026-01-01T00:00:00Z',
    });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // Best-effort drop. adapter is not exposed publicly as a typed handle,
      // but we can use the raw query path with a CREATE/DROP guard via the
      // public `.adapter` getter.
      const adapter = db.adapter;
      if (adapter.runAsync) {
        await adapter.runAsync(`DROP TABLE IF EXISTS "${tableName}"`);
      } else {
        adapter.run(`DROP TABLE IF EXISTS "${tableName}"`);
      }
    } catch {
      /* swallow */
    }
    db.close();
  });

  it('returns all rows when no filter is given', async () => {
    const rows = await db.query(tableName);
    expect(rows).toHaveLength(5);
  });

  it('applies equality `where` shorthand', async () => {
    const rows = await db.query(tableName, { where: { team: 'red' } });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'e']);
  });

  it('applies `eq` filter', async () => {
    const rows = await db.query(tableName, { filters: [{ col: 'team', op: 'eq', val: 'blue' }] });
    expect(rows.map((r) => r.id).sort()).toEqual(['c', 'd']);
  });

  it('applies `in` filter', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'id', op: 'in', val: ['a', 'c'] }],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('applies `like` filter (Postgres LIKE is case-sensitive — content matches)', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'name', op: 'like', val: '%li%' }],
    });
    // Alice (a) and Charlie (c) both contain "li"
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('applies `isNull` filter', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'score', op: 'isNull' }],
    });
    expect(rows.map((r) => r.id)).toEqual(['d']);
  });

  it('applies `isNotNull` filter', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'score', op: 'isNotNull' }],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'e']);
  });

  it('applies numeric `gte` filter', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'score', op: 'gte', val: 80 }],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('applies orderBy + limit', async () => {
    const rows = await db.query(tableName, {
      filters: [{ col: 'score', op: 'isNotNull' }],
      orderBy: 'score',
      orderDir: 'desc',
      limit: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('combines `where` shorthand with `filters` (AND semantics)', async () => {
    const rows = await db.query(tableName, {
      where: { team: 'red' },
      filters: [{ col: 'score', op: 'gt', val: 70 }],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('rejects when WHERE column is unknown to the schema', async () => {
    await expect(
      db.query(tableName, { where: { not_a_column: 'x' } as Record<string, unknown> }),
    ).rejects.toThrow(/unknown column/);
  });
});
