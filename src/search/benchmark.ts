/**
 * Reproducible retrieval benchmark harness.
 *
 * Produces the speed-to-answer numbers a buyer would benchmark you on —
 * p50/p95/p99 latency for filtered query, full-text search, vector search, and
 * SQL aggregation — plus ingest throughput, all on synthetic data at a
 * configurable scale, on either dialect. It exercises the *real* code paths
 * (the same `fullTextSearch` / `searchByEmbedding` / SQL the library serves in
 * production), so the numbers are honest, and it ships in the package so the
 * same harness that gates regressions in CI can be re-run by anyone.
 *
 * Default scale is small so a CI SLO gate runs in seconds; override via the
 * `scale` option (or the `LATTICE_BENCH_ROWS` / `LATTICE_BENCH_QUERIES` /
 * `LATTICE_BENCH_DIM` env vars) to reproduce the large-n published numbers.
 *
 * The default embedder is a dependency-free deterministic token-hash vector —
 * it measures latency/throughput honestly without pulling in a model. Pass your
 * own `embed` to benchmark with real vectors.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import { ensureFtsIndex, fullTextSearch } from './fts.js';
import { ensureEmbeddingsTable, storeEmbedding, searchByEmbedding } from './embeddings.js';
import { buildVectorIndex, hasVectorIndex, dropVectorIndex } from './vector-index.js';
import type { EmbeddingsConfig } from '../types.js';

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface BenchmarkScale {
  /** Rows inserted into the synthetic table. */
  rows: number;
  /** Distinct queries timed for each measured operation. */
  queries: number;
  /** Embedding dimensionality. */
  dim: number;
}

export interface BenchmarkReport {
  dialect: 'sqlite' | 'postgres';
  scale: BenchmarkScale;
  ingest: { rows: number; ms: number; rowsPerSec: number };
  query: LatencyStats;
  fts: LatencyStats;
  vector: LatencyStats;
  aggregate: LatencyStats;
  /** Peak resident-set bytes observed during the vector-search phase. */
  peakRssBytes: number;
  /**
   * Whether the `vector` numbers reflect the NATIVE index (pgvector/sqlite-vec)
   * or the in-process O(n) scan fallback. `false` means no extension was present,
   * so `vector.p95` is the scan baseline — not the indexed number. Surfaced so a
   * published benchmark can never present the scan as the index.
   */
  vectorIndexed: boolean;
}

export interface BenchmarkOptions {
  scale?: Partial<BenchmarkScale>;
  /** Embedder; defaults to a deterministic dependency-free token-hash vector. */
  embed?: (text: string) => Promise<number[]>;
  /** Table name for the synthetic data (dropped + recreated). Default `_lattice_bench`. */
  table?: string;
}

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
];

/** Deterministic pseudo-random in [0, 1) from an integer seed (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    if (w) out.push(w);
  }
  return out.join(' ');
}

/** Dependency-free deterministic embedder: token-hash bag mapped onto `dim`. */
function hashEmbedder(dim: number): (text: string) => Promise<number[]> {
  return (text: string) => {
    const vec = new Array<number>(dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = (h >>> 0) % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    // L2 normalize so cosine similarity is well-conditioned.
    let mag = 0;
    for (const v of vec) mag += v * v;
    mag = Math.sqrt(mag) || 1;
    return Promise.resolve(vec.map((v) => v / mag));
  };
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
}

export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function now(): number {
  // performance.now() when available (sub-ms), else Date.now via hrtime-free path.
  return typeof performance !== 'undefined'
    ? performance.now()
    : Number(process.hrtime.bigint()) / 1e6;
}

function resolveScale(opts: BenchmarkOptions): BenchmarkScale {
  const envRows = process.env.LATTICE_BENCH_ROWS;
  const envQ = process.env.LATTICE_BENCH_QUERIES;
  const envDim = process.env.LATTICE_BENCH_DIM;
  return {
    rows: opts.scale?.rows ?? (envRows ? Number(envRows) : 500),
    queries: opts.scale?.queries ?? (envQ ? Number(envQ) : 25),
    dim: opts.scale?.dim ?? (envDim ? Number(envDim) : 32),
  };
}

/**
 * Run the benchmark against an adapter. Creates a synthetic table, populates it,
 * builds an FTS index + embeddings, times each operation, and drops the table.
 */
export async function benchmarkRetrieval(
  adapter: StorageAdapter,
  opts: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const scale = resolveScale(opts);
  const table = opts.table ?? '_lattice_bench';
  const embed = opts.embed ?? hashEmbedder(scale.dim);
  const config: EmbeddingsConfig = { fields: ['title', 'body'], embed };
  const rng = seeded(1234);

  // Self-contained: ensure the embeddings store exists (the harness may run on a
  // bare connection that never registered an embeddings-enabled table).
  await ensureEmbeddingsTable(adapter);

  // Fresh table.
  await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${table}"`);
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE "${table}" (
       id TEXT PRIMARY KEY,
       title TEXT,
       body TEXT,
       category TEXT,
       score INTEGER,
       deleted_at TEXT
     )`,
  );

  // --- Ingest -------------------------------------------------------------
  const ingestStart = now();
  for (let i = 0; i < scale.rows; i++) {
    const id = `row-${String(i)}`;
    const title = sentence(rng, 3);
    const body = sentence(rng, 20);
    const category = WORDS[i % 8] ?? 'misc';
    const score = Math.floor(rng() * 100);
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${table}" (id, title, body, category, score) VALUES (?, ?, ?, ?, ?)`,
      [id, title, body, category, score],
    );
    await storeEmbedding(adapter, table, id, { id, title, body }, config);
  }
  const ingestMs = now() - ingestStart;

  await ensureFtsIndex(adapter, table, ['title', 'body']);

  // Build the native vector index so the vector phase times the INDEXED path when
  // an extension is available (else it no-ops and the scan baseline is timed). The
  // report's `vectorIndexed` flag records which one the numbers reflect.
  await buildVectorIndex(adapter, table, scale.dim);
  const vectorIndexed = await hasVectorIndex(adapter, table);

  // Build a fixed pool of query strings.
  const queryStrings: string[] = [];
  for (let i = 0; i < scale.queries; i++) queryStrings.push(sentence(rng, 3));

  // --- Filtered query -----------------------------------------------------
  const querySamples: number[] = [];
  for (const _q of queryStrings) {
    const cat = WORDS[Math.floor(rng() * 8)] ?? 'misc';
    const t0 = now();
    await allAsyncOrSync(
      adapter,
      `SELECT * FROM "${table}" WHERE category = ? AND deleted_at IS NULL ORDER BY score DESC LIMIT 10`,
      [cat],
    );
    querySamples.push(now() - t0);
  }

  // --- Full-text search ---------------------------------------------------
  const ftsSamples: number[] = [];
  for (const q of queryStrings) {
    const t0 = now();
    await fullTextSearch(adapter, [table], { query: q, limitPerTable: 10 });
    ftsSamples.push(now() - t0);
  }

  // --- Vector search (peak RSS observed here) -----------------------------
  const vectorSamples: number[] = [];
  let peakRss = 0;
  for (const q of queryStrings) {
    const t0 = now();
    await searchByEmbedding(adapter, table, q, config, 10, 0, 'id');
    vectorSamples.push(now() - t0);
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }

  // --- Aggregate ----------------------------------------------------------
  const aggSamples: number[] = [];
  for (let i = 0; i < scale.queries; i++) {
    const t0 = now();
    await getAsyncOrSync(
      adapter,
      `SELECT category, count(*) AS n, avg(score) AS s FROM "${table}" WHERE deleted_at IS NULL GROUP BY category`,
    );
    aggSamples.push(now() - t0);
  }

  await dropVectorIndex(adapter, table);
  await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${table}"`);
  await runAsyncOrSync(adapter, `DELETE FROM "_lattice_embeddings" WHERE table_name = ?`, [table]);

  return {
    dialect: adapter.dialect,
    scale,
    ingest: { rows: scale.rows, ms: ingestMs, rowsPerSec: (scale.rows / ingestMs) * 1000 },
    query: latencyStats(querySamples),
    fts: latencyStats(ftsSamples),
    vector: latencyStats(vectorSamples),
    aggregate: latencyStats(aggSamples),
    peakRssBytes: peakRss,
    vectorIndexed,
  };
}

/** A service-level objective for a single latency metric, in milliseconds. */
export interface RetrievalSlo {
  metric: 'query.p95' | 'fts.p95' | 'vector.p95' | 'aggregate.p95';
  maxMs: number;
}

export interface SloViolation extends RetrievalSlo {
  observedMs: number;
}

/** Check a report against SLOs; returns the violations (empty = all pass). */
export function checkSlos(report: BenchmarkReport, slos: RetrievalSlo[]): SloViolation[] {
  const lookup: Record<RetrievalSlo['metric'], number> = {
    'query.p95': report.query.p95,
    'fts.p95': report.fts.p95,
    'vector.p95': report.vector.p95,
    'aggregate.p95': report.aggregate.p95,
  };
  const out: SloViolation[] = [];
  for (const slo of slos) {
    const observed = lookup[slo.metric];
    if (observed > slo.maxMs) out.push({ ...slo, observedMs: observed });
  }
  return out;
}
