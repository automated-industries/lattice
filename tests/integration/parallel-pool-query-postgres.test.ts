/**
 * Postgres integration test for concurrent `Lattice.query()` calls.
 *
 * Why this exists:
 *   This is the regression test for the original symptom that motivated
 *   the entire async-adapter rewrite. Pre-PR-2, every lattice query went
 *   through the sync adapter surface, which on Postgres meant the synckit
 *   bridge plus a single shared `pg.Client` worker. The Node main thread
 *   blocked on `Atomics.wait` for the duration of every query, and queries
 *   serialized through the worker — there was no concurrency to be had,
 *   even though `pg.Pool` was available.
 *
 *   Post-PR-2, queries route through `pg.Pool` natively. Firing N queries
 *   in parallel should take roughly `max(individual durations)` rather than
 *   `sum(individual durations)`. This test asserts that.
 *
 * The shape of the assertion:
 *   - Warm the *whole* pool first (a concurrent batch) so every pool client
 *     has established its TCP + auth connection. This is essential: the
 *     earlier version warmed only a single client, so the first parallel
 *     batch silently paid one-time connection handshakes for the other N-1
 *     clients — inflating its wall time and making an absolute-millisecond
 *     threshold flake on fast loopback connections (single-call ≈ 0ms, but
 *     the cold parallel batch ≈ 60ms+).
 *   - Measure a serialized baseline (N sequential calls) and a concurrent
 *     batch (N at once), both against the now-warm pool.
 *   - Assert the concurrent batch is faster than the serialized baseline.
 *     This is a *relative* comparison — it states the actual property under
 *     test (pg.Pool parallelizes; the synckit regression serializes, making
 *     parallel ≈ serial) without depending on absolute query latency, which
 *     is what made the old `< max((N-2)*single, 50)` assertion flaky.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice.query parallel pool (Postgres async integration)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const tableName = `__lattice_test_${runId}_parallel`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(tableName, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    // Seed enough rows that the per-query work is non-trivial but bounded.
    for (let i = 0; i < 25; i++) {
      await db.insert(tableName, { id: `${runId}-${String(i)}`, name: `row-${String(i)}` });
    }
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const adapter = db.adapter;
      if (adapter.runAsync) await adapter.runAsync(`DROP TABLE IF EXISTS "${tableName}"`);
      else adapter.run(`DROP TABLE IF EXISTS "${tableName}"`);
    } catch {
      /* swallow */
    }
    db.close();
  });

  it('a concurrent query batch beats the serialized baseline (proves pg.Pool concurrency)', async () => {
    const N = 20;

    // Warm the WHOLE pool: fire N concurrent queries so every pool client
    // establishes its TCP + auth connection now. Without this, the first
    // measured parallel batch pays one-time connection handshakes for every
    // client beyond the one a single-call warm-up touched — which inflated
    // its wall time and made the old absolute-threshold assertion flaky on
    // fast loopback connections.
    await Promise.all(Array.from({ length: N }, () => db.count(tableName)));

    // Serialized baseline: N sequential calls against the warm pool. This is
    // the synckit worst case the rewrite eliminated — every query waits for
    // the previous one.
    const tSerial = Date.now();
    for (let i = 0; i < N; i++) await db.count(tableName);
    const serial = Date.now() - tSerial;

    // Concurrent batch against the same warm pool.
    const tParallel = Date.now();
    await Promise.all(Array.from({ length: N }, () => db.count(tableName)));
    const parallel = Date.now() - tParallel;

    // pg.Pool parallelizes across clients, so N concurrent queries complete in
    // a few waves rather than N back-to-back round-trips — the concurrent
    // batch must be strictly faster than the serialized baseline. A synckit-
    // style serialization regression makes parallel ≈ serial (or worse) and
    // fails here. Relative comparison, so it doesn't depend on absolute query
    // latency (the source of the previous flake).
    expect(parallel).toBeLessThan(serial);
  });

  it('large concurrent reads return correct row counts', async () => {
    // Sanity check: even when many queries fire at once, each one returns
    // the right answer. Catches a class of bugs where pool clients leak
    // state across queries (e.g. shared prepared-statement names colliding
    // across concurrent transactions, missing result-row buffering, etc.).
    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () => db.count(tableName)));
    expect(results).toHaveLength(N);
    for (const r of results) {
      expect(r).toBe(25);
    }
  });
});
