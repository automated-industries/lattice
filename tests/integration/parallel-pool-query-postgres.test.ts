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

  it('the pool overlaps concurrent queries (server-side sleeps, not wall-clock noise)', async () => {
    const adapter = db.adapter;
    if (!adapter.getAsync) throw new Error('async Postgres adapter required for this test');
    const getAsync = adapter.getAsync.bind(adapter);

    // Each query sleeps a FIXED 50ms server-side (`pg_sleep`). This replaces the
    // previous design, which compared two ~12ms wall-clock measurements of
    // sub-millisecond loopback `count()` queries — where the concurrency signal
    // was smaller than scheduler/GC noise, so the < assertion was a coin-flip
    // (the "expected 13 to be less than 12" flake). With a deterministic 50ms
    // floor per query the concurrency benefit is an order of magnitude larger
    // than any timing jitter, so the comparison is robust.
    const SLEEP_MS = 50;
    const sleepQuery = (): Promise<unknown> =>
      getAsync(`SELECT pg_sleep(${SLEEP_MS / 1000}) AS slept`);

    // N below the default pool size (10) so all N overlap in a single wave.
    const N = 8;

    // Warm the pool first so connection handshakes aren't timed.
    await Promise.all(Array.from({ length: N }, () => db.count(tableName)));

    // Serialized baseline: N sequential 50ms sleeps ≈ N × 50ms (= 400ms). This
    // is the synckit worst case the async rewrite eliminated — every query
    // waits for the previous one.
    const tSerial = Date.now();
    for (let i = 0; i < N; i++) await sleepQuery();
    const serial = Date.now() - tSerial;

    // Concurrent: N simultaneous 50ms sleeps. With a pool of ≥ N they overlap in
    // one wave ≈ 50ms — so parallel should land near serial / N, not near serial.
    const tParallel = Date.now();
    await Promise.all(Array.from({ length: N }, () => sleepQuery()));
    const parallel = Date.now() - tParallel;

    // A serialization regression (the old synckit single-worker path) makes the
    // concurrent batch ≈ serial; pg.Pool overlaps them. Half the serial time is
    // a deliberately conservative bar — the real ratio is ~N : 1 — so this never
    // races on jitter while still failing hard if concurrency is lost.
    expect(parallel).toBeLessThan(serial / 2);
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
