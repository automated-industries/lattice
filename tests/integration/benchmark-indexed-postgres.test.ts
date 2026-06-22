/**
 * The benchmark's vector phase must time the NATIVE indexed path, not the O(n)
 * in-process scan — otherwise `vector.p95` mislabels the scan baseline as the
 * "vector" number a buyer would compare you on.
 *
 * This is the honest version of that check: it runs the REAL benchmark harness
 * against a REAL Postgres with pgvector and asserts the harness BUILT the native
 * index BEFORE the timing loop (`report.vectorIndexed === true`) — i.e. the
 * numbers reflect the index. It is deliberately NOT run on `:memory:` SQLite,
 * where no extension loads and `vectorIndexed` is `false` by construction (the
 * unit benchmark test covers the SQLite scan-fallback path and the helper math;
 * it cannot prove a real index because none exists there).
 *
 * Availability is established at runtime against the cluster:
 *   - pgvector present (CI's pgvector/pgvector image, or a local cluster with the
 *     extension) → the test runs and asserts a real index.
 *   - pgvector absent (the disposable embedded-postgres used for local runs ships
 *     no `vector` extension) → the test SKIPS with a clear message rather than
 *     passing green-by-construction. It is honestly unmeasurable there, and a
 *     skip says so; it does not fabricate a pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { benchmarkRetrieval } from '../../src/search/benchmark.js';
import {
  buildVectorIndex,
  hasVectorIndex,
  vectorIndexAvailable,
  dropVectorIndex,
  resetVectorAvailabilityCache,
} from '../../src/search/vector-index.js';
import { ensureEmbeddingsTable, storeEmbedding } from '../../src/search/embeddings.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import type { EmbeddingsConfig } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('benchmark indexed vector path (Postgres + pgvector)', () => {
  let db: Lattice;
  let pgvector = false;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    await db.init();
    // buildVectorIndex auto-runs `CREATE EXTENSION IF NOT EXISTS vector`; probe by
    // attempting a build on a throwaway table, then checking availability.
    await ensureEmbeddingsTable(db.adapter);
    await buildVectorIndex(db.adapter, '_lattice_bench_probe', 8).catch(() => 0);
    resetVectorAvailabilityCache(db.adapter);
    pgvector = await vectorIndexAvailable(db.adapter);
    await dropVectorIndex(db.adapter, '_lattice_bench_probe').catch(() => undefined);
  });

  afterAll(() => {
    db.close();
  });

  it('builds a real native index BEFORE timing the vector phase', async (ctx) => {
    if (!pgvector) {
      ctx.skip(
        'pgvector is not available on this cluster (the disposable embedded-postgres ' +
          'ships no `vector` extension); the indexed-vector benchmark is honestly ' +
          'unmeasurable here and runs in CI against the pgvector image instead.',
      );
      return;
    }

    const report = await benchmarkRetrieval(db.adapter, {
      scale: { rows: 80, queries: 8, dim: 16 },
    });

    expect(report.dialect).toBe('postgres');
    // The whole point: the vector numbers reflect the NATIVE index, not the scan.
    // The harness builds the index (vector-index.ts) before the vector timing loop
    // (benchmark.ts) and searchByEmbedding uses the index when present — so a true
    // flag here means the timed phase ran against a real pgvector HNSW index.
    expect(report.vectorIndexed).toBe(true);
    expect(report.vector.count).toBe(8);
    expect(report.vector.p95).toBeGreaterThanOrEqual(report.vector.p50);
  });

  it('the native index actually exists between build and search (not a no-op)', async (ctx) => {
    if (!pgvector) {
      ctx.skip('pgvector unavailable on this cluster — see the sibling test.');
      return;
    }

    // Reproduce the harness ordering directly so the index existence is observable
    // (the harness drops its index on the way out). Build → assert present → only
    // then would a timing loop run. This proves "index before timing", not
    // "timing then maybe an index".
    const table = '_lattice_bench_indexed_assert';
    const dim = 12;
    const embed = (text: string): Promise<number[]> => {
      const v = new Array<number>(dim).fill(0);
      for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const ch of tok) h = (h + ch.charCodeAt(0)) % dim;
        v[h] = (v[h] ?? 0) + 1;
      }
      return Promise.resolve(v);
    };
    const config: EmbeddingsConfig = { fields: ['body'], embed };

    await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}"`);
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, body TEXT, deleted_at TEXT)`,
    );
    try {
      for (let i = 0; i < 20; i++) {
        const id = `r${String(i)}`;
        const body = `alpha bravo charlie ${String(i % 5)}`;
        await runAsyncOrSync(db.adapter, `INSERT INTO "${table}" (id, body) VALUES (?, ?)`, [
          id,
          body,
        ]);
        await storeEmbedding(db.adapter, table, id, { id, body }, config);
      }

      // Before timing: there is no index yet.
      expect(await hasVectorIndex(db.adapter, table)).toBe(false);

      // Build the native index (the harness does this BEFORE the vector loop).
      const indexed = await buildVectorIndex(db.adapter, table, dim, /* requireExtension */ true);
      expect(indexed).toBeGreaterThan(0);

      // After build, the index exists — so the subsequent (timed) searches run
      // against the index, not the scan.
      expect(await hasVectorIndex(db.adapter, table)).toBe(true);
    } finally {
      await dropVectorIndex(db.adapter, table).catch(() => undefined);
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
      await runAsyncOrSync(db.adapter, `DELETE FROM "_lattice_embeddings" WHERE table_name = ?`, [
        table,
      ]).catch(() => undefined);
    }
  });
});
