# Retrieval, query & data primitives (v4.1)

latticesql 4.1 turns the library into a measurable, production-grade retrieval and
data substrate. Everything here is **additive and opt-in** — absent the opt-in,
`query()` / `count()` / `search()` behave byte-identically to 4.0. Every primitive
ships with unit (`:memory:` SQLite) + integration (real Postgres) + dialect-parity
tests.

## Measurable retrieval

### `evaluateRetrieval(queries, retriever, opts?)`

Standard IR metrics over **any** ranked retriever — `(query) => rankedRowIds`, so
it grades semantic, full-text, hybrid, graph, or an external service.

```ts
const summary = await db.evaluateRetrieval(
  [{ query: 'budget', relevant: ['doc1', 'doc7'] }],
  async (q) => (await db.search('docs', q, { topK: 10 })).map((r) => String(r.row.id)),
  { k: 10, ks: [1, 5, 10] },
);
// summary.precisionAtK / recallAtK / mrr / ndcgAtK / map (+ perQuery, byK)
```

`detectRetrievalRegressions(baseline, candidate, tolerance)` turns it into a CI
gate — a retrieval change that lowers any metric past tolerance fails the build.

> **v4.2 — the gate can actually fail.** The golden corpus is now ~20 docs with
> deliberate cross-topic lexical overlap, so the real `search()` scores
> good-but-imperfect; the committed baseline is **generated** by running the real
> search (`npm run eval:baseline`) and is sub-perfect (`mrr ≈ 0.92`,
> `ndcg@3 ≈ 0.94`), never hand-authored. `npm run eval:gate` evaluates the current
> `search()` against that baseline and exits non-zero on any metric dropping past
> tolerance; it runs as a required CI step, and a suite test asserts the baseline
> still has headroom (`mrr < 1`) so the gate can't silently go blind.

### `lattice doctor` / `diagnoseRetrieval(opts?)`

Read-only health: per-table FTS + embedding coverage (soft-deleted rows excluded),
extension availability (FTS5, sqlite-vec, pgvector, pg_trgm), and severity-ranked
issues. `lattice doctor [--json]` exits non-zero on any error (deploy gate).

### `benchmarkRetrieval(opts?)` / `checkSlos(report, slos)`

Reproducible p50/p95/p99 latency for filtered query, FTS, vector, and aggregate,
plus ingest throughput + peak memory — on both dialects, at a configurable scale
(`LATTICE_BENCH_ROWS/QUERIES/DIM`). Ships in the package so buyers reproduce the
numbers; wire `checkSlos` as a CI SLO gate.

> **v4.2 — honest vector timing + an advisory SLO gate.** A Postgres integration
> test runs the benchmark against a real pgvector cluster and asserts the harness
> built the **native index before** the vector timing loop
> (`report.vectorIndexed === true`), so `vector.p95` reflects the indexed path,
> not the O(n) in-process scan; where pgvector is unavailable the test skips with a
> clear message rather than passing green-by-construction. `npm run slo:gate` runs
> the real benchmark at a committed scale and checks observed p95 latencies against
> committed thresholds — it is **advisory, never build-blocking** (shared CI
> runners are too latency-noisy to gate a merge on), and the output marks whether
> `vector.p95` reflects a native index or the in-process scan.

## Better search

### Chunked + contextual embeddings

```ts
db.define('docs', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' },
  embeddings: {
    fields: ['title', 'body'],
    embed: myEmbedder,
    chunker: semanticChunker({ maxChars: 1000, overlap: 100 }),
    contextPrefix: (row) => String(row.title), // prepended to every chunk
    modelId: 'text-embedding-3-small',
  },
});
```

Each row is embedded as several boundary-aware chunks → higher precision@k and
fewer tokens to a correct answer. `search()` returns the best-matching chunk
(`chunkIndex` + `matchedContent`), excludes soft-deleted rows, and throws
`EmbeddingDimensionMismatchError` if the model dimension changed without a re-embed.
`refreshEmbeddings(table, opts)` backfills missing / re-embeds stale / sweeps orphans.

### Indexed vector search

```ts
await db.buildVectorIndex('docs'); // pgvector HNSW (PG) / sqlite-vec (SQLite)
```

Opt-in per-table approximate-nearest-neighbor index built from the stored vectors;
`search()` uses it automatically when present, else the in-process scan (which
`doctor` reports). Requires the extension server-side (pgvector) or loaded
(sqlite-vec).

Once built, the index is **kept in sync with writes** — you don't rebuild it by
hand after every change. On Postgres each insert/update/delete mirrors the row
into the index incrementally (on the same fire-and-forget path as the embedding
write), and `refreshEmbeddings` reconciles the index after a bulk backfill. As a
universal safety net across backends, `search()` **verifies the index is in sync
with the stored vectors before trusting it** (a cheap count-parity check); if the
index has drifted it transparently falls back to the exact in-process scan over
the source-of-truth store, so a stale index is never silently served — it only
ever costs a slower query, never a wrong result. (Incremental per-row maintenance
is currently Postgres-only; a `sqlite-vec` index falls back to the scan after a
write until it is rebuilt — correct either way.)

**Cloud members.** In a multi-member cloud, a scoped member has no grant on the
internal embeddings store or the native index, so its `search()` / `hybridSearch()`
reach the vectors only through a `SECURITY DEFINER` function that returns just the
chunks for rows the member may see (filtered by the same row-visibility rule that
governs every other read, keyed on the member's role) and scores them in-process.
The member scan is exact and has no over-fetch by which a member could infer hidden
rows; result rows are re-checked by row-level security on the base relation. Owners
and local (non-cloud) callers are unaffected — the routing is automatic.

**Tuning & operations.** The HNSW index can be tuned at build time via
`embeddings.index = { m, efConstruction }` and per query via `search(..., { efSearch })`
(`hybridSearch` too); all default to pgvector's own values, so omitting them builds
and queries exactly as before. `lattice index status` shows per-table index health
(dimension, params, build time, staleness) from an internal `__lattice_vector_index`
registry; `lattice reindex <table>` rebuilds one table's index, and `lattice doctor
--fix` rebuilds any index it reports stale. An auto-rebuild after a bulk
`refreshEmbeddings` reuses the recorded build params.

> **v4.2 — bounded retrieval reads.** `search()` / `hybridSearch()` clamp the
> caller's `topK` (`clampTopK`, `SEARCH_TOPK_MAX = 1000`) **before** the indexed
> arm over-fetches `topK * N` candidates, so a single large `topK` can't fan out
> into a whole-table read. For a table with **no** native index, the in-process
> cosine scan can be capped per-table with `embeddings.maxScanChunks`: when the
> scan would read more than that many stored chunk vectors it throws
> `EmbeddingScanTooLargeError` (telling you to add a pgvector index or raise the
> cap) rather than load them all into memory. It is **off by default** (unbounded
> scan — the historical behavior) and is **never silently truncated**, because a
> partial cosine scan would return incomplete, wrong results.

### Hybrid search + ranking + reranker

```ts
const results = await db.hybridSearch('docs', 'q4 budget', {
  topK: 10,
  ranking: {
    recency: { column: 'created_at', halfLifeDays: 30, weight: 1 },
    reward: { weight: 0.5 },
  },
  reranker: myCrossEncoder, // optional; graceful fallback on failure
});
// each result carries .explain { rrf, vectorRank/Score, ftsRank/Score, rankingBoost, rerankerScore }
```

Reciprocal Rank Fusion (k=60) of the vector + full-text arms. `lattice search
"<q>" --table <t> --explain` shows the score breakdown. Full-text is now
relevance-ranked (`ts_rank` / `bm25`).

### Graph-augmented retrieval

```ts
await db.addEdge({ srcTable: 'docs', srcId: 'a', dstTable: 'docs', dstId: 'b', type: 'cites' });
await db.extractEdges({ srcTable: 'docs', fkColumn: 'parent_id', dstTable: 'docs' }); // zero-LLM
const results = await db.graphSearch('docs', 'q', { anchors: [{ table: 'docs', id: 'a' }] });
```

A typed-edge graph (`__lattice_edges`) with bounded BFS (`traverseGraph`, depth ≤ 5,
node-capped) and adjacency boosting — relationship-aware retrieval that lifts rows
connected to your current-context entities.

## Query primitives

```ts
// Bounded reads — guard against unbounded full-table loads
await db.query('t', { maxRows: 1000 }); // throws BoundedReadError if more match
new Lattice(path, { defaultMaxRows: 1000 }); // global default

// Projection — return only the columns you need
await db.query('t', { projection: ['id', 'name'] });

// OR/AND groups + jsonPath
await db.query('t', {
  filters: [
    { col: 'status', op: 'eq', val: 'open' },
    {
      or: [
        { col: 'priority', op: 'gte', val: 3 },
        { col: 'pinned', op: 'eq', val: true },
      ],
    },
    { col: 'meta', jsonPath: 'tier', op: 'eq', val: 'gold' },
  ],
});

// SQL-side aggregation
await db.aggregate('orders', {
  groupBy: ['status'],
  aggregates: [
    { fn: 'count', as: 'n' },
    { fn: 'sum', col: 'total', as: 'revenue' },
  ],
  having: [{ aggregate: 'n', op: 'gt', val: 10 }],
});

// Keyset pagination — fast arbitrarily deep
const page = await db.queryPage('t', { orderBy: 'created_at', limit: 50, cursor });

// distinctOn — one row per group; include — batched relation expansion
await db.query('events', { distinctOn: 'user_id', orderBy: 'ts', orderDir: 'desc' });
await db.query('posts', { include: ['author'] }); // belongsTo → row; hasMany → array
```

## Governance, reliability, computed columns, cloud files

```ts
// Immutable provenance + trust gate
db.define('docs', { columns: {...}, provenance: true, trust: true });
await db.verifyRow('docs', id, 'alice');          // markRowForReview / rowsNeedingReview / verifiedRows

// Durable retry + online resumable migrations
await withRetry(() => db.insert(...));            // idempotent ops only
await applyChunkedMigration(db.adapter, { id, table, apply, batchSize: 1000 });

// Computed columns + materialized rollups
db.define('people', { columns: {...}, computed: {
  full_name: { deps: ['first', 'last'], compute: (r) => `${r.first} ${r.last}` },
}});
db.define('posts', { columns: {...}, materializedRollups: {
  comment_count: { sourceTable: 'comments', foreignKey: 'post_id', fn: 'count' },
}});

// Keyless cloud file-byte access (Postgres cloud)
await db.enableCloudFilePresigning({ bucket, region, accessKey, secretKey });
// members fetch bytes with zero config; the owner key never leaves the database.
```

See [CHANGELOG.md](../CHANGELOG.md) for the full 4.1 list.
