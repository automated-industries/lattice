/**
 * Postgres integration test for `Lattice.estimatedCount()`.
 *
 * estimatedCount reads pg_class.reltuples (O(1), no table scan) so the GUI can
 * size ~95 entities without firing one COUNT(*) per table — that fan-out
 * exhausted the 15-slot Supabase session pooler (EMAXCONN). This test proves:
 *   1. after ANALYZE the estimate matches the real row count;
 *   2. a populated-but-never-analyzed table (reltuples = -1) falls back to
 *      exact COUNT instead of reporting 0.
 *
 * Skips without LATTICE_TEST_PG_URL; CI provides a postgres:16 service.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice.estimatedCount (Postgres reltuples)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const analyzed = `__lattice_test_${runId}_estcount_a`;
  const fresh = `__lattice_test_${runId}_estcount_b`;
  const empty = `__lattice_test_${runId}_estcount_empty`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    for (const t of [analyzed, fresh, empty]) {
      db.define(t, {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: () => '',
        outputFile: '/dev/null',
      });
    }
    await db.init();

    for (let i = 0; i < 25; i++) {
      await db.insert(analyzed, { id: `a${i.toString()}`, name: `row ${i.toString()}` });
      await db.insert(fresh, { id: `b${i.toString()}`, name: `row ${i.toString()}` });
    }
    // Force a real estimate on the first table; leave the second un-analyzed.
    await db.adapter.runAsync?.(`ANALYZE "${analyzed}"`);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      for (const t of [analyzed, fresh, empty]) {
        await db.adapter.runAsync?.(`DROP TABLE IF EXISTS "${t}"`);
      }
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('matches the real count after ANALYZE', async () => {
    const est = await db.estimatedCount(analyzed);
    // A small, fully-scanned table gets reltuples set exactly by ANALYZE.
    expect(est).toBe(25);
  });

  it('falls back to exact COUNT when never analyzed (reltuples <= 0)', async () => {
    // Newly created + populated but un-analyzed: reltuples is -1 (PG14+),
    // so estimatedCount must not report 0 — it falls back to exact count.
    const est = await db.estimatedCount(fresh);
    expect(est).toBe(25);
  });

  it('falls back to exact COUNT for an empty table', async () => {
    expect(await db.estimatedCount(empty)).toBe(0);
  });
});
