/**
 * Native indexed vector search.
 *
 * The in-process cosine scan in `embeddings.ts` loads and scores every stored
 * vector per query — O(n), fine at small n but a disqualifier at enterprise
 * scale. When the database provides an approximate-nearest-neighbor index this
 * module builds and queries it instead, turning vector search into an indexed
 * ~O(log n) lookup that stays flat as n grows.
 *
 * - **Postgres + pgvector:** a per-table `_lattice_vec_<table>` with a
 *   `vector(dim)` column and an HNSW index on cosine distance (`<=>`).
 * - **SQLite + sqlite-vec:** a per-table `vec0` virtual table (used when the
 *   extension has been loaded into the connection).
 *
 * The JSON store in `_lattice_embeddings` remains the portable source of record;
 * this index is a DERIVED accelerator built from it (mirroring how the FTS index
 * derives from the base table). When no extension is present, callers fall back
 * to the in-process scan, and `lattice doctor` reports the missing extension.
 *
 * The index is opt-in: `buildVectorIndex` populates it from the JSON store, and
 * search uses it only when `hasVectorIndex` is true — so the default behavior is
 * unchanged for users who never call it.
 */

import type { StorageAdapter } from '../db/adapter.js';
import {
  runAsyncOrSync,
  getAsyncOrSync,
  allAsyncOrSync,
  introspectColumnsAsyncOrSync,
} from '../db/adapter.js';
import { EMBEDDINGS_TABLE } from './embeddings.js';
import { assertSafeIdentifier } from '../schema/identifier.js';
import type { VectorIndexOptions, Row } from '../types.js';

const VEC_PREFIX = '_lattice_vec_';

/**
 * Unit-normalize a vector (L2). `sqlite-vec` ranks by L2 distance; for that to be
 * cosine-equivalent (`cos = 1 − d²/2`) the stored AND query vectors must be unit
 * length. Postgres `<=>` is cosine distance directly, so it needs no normalize.
 */
function normalizeVector(v: number[]): number[] {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  return mag === 0 ? v : v.map((x) => x / mag);
}

/**
 * Per-table native vector index name. The table is grammar-guarded here because
 * the returned name is interpolated into DDL (`CREATE TABLE "..."`, `DROP`,
 * `INSERT`); every build/drop/search path derives the index name through this
 * one function, so a single guard at the choke point covers them all.
 */
export function vectorIndexName(table: string): string {
  return `${VEC_PREFIX}${assertSafeIdentifier(table, 'table')}`;
}

export interface VectorHit {
  pk: string;
  chunkIndex: number;
  content: string | null;
  /** Cosine similarity in [0, 1] (1 − cosine distance). */
  score: number;
}

// Cache the (expensive) availability probe per adapter — it cannot change for
// the lifetime of a connection.
const availabilityCache = new WeakMap<StorageAdapter, boolean>();

/** Whether this connection has a usable native vector extension. */
export async function vectorIndexAvailable(adapter: StorageAdapter): Promise<boolean> {
  const cached = availabilityCache.get(adapter);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    if (adapter.dialect === 'postgres') {
      const row = await getAsyncOrSync(
        adapter,
        `SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'`,
      );
      available = Number(row?.n ?? 0) > 0;
    } else {
      // sqlite-vec exposes vec_version() once loaded.
      await getAsyncOrSync(adapter, `SELECT vec_version() AS v`);
      available = true;
    }
  } catch {
    available = false;
  }
  availabilityCache.set(adapter, available);
  return available;
}

/** Reset the cached availability probe (used by tests after loading an extension). */
export function resetVectorAvailabilityCache(adapter: StorageAdapter): void {
  availabilityCache.delete(adapter);
}

/** Whether a native vector index table exists for `table`. */
export async function hasVectorIndex(adapter: StorageAdapter, table: string): Promise<boolean> {
  try {
    const cols = await introspectColumnsAsyncOrSync(adapter, vectorIndexName(table));
    return cols.length > 0;
  } catch {
    return false;
  }
}

// Per-(adapter, table) cache of native-index existence, consulted ONLY by the
// write-path maintenance helpers below to avoid an information_schema / PRAGMA
// probe on every embedded-row write. It is a hot-path optimization, NOT a
// correctness mechanism: search independently verifies freshness
// (`vectorIndexFresh`) before trusting the index, so a stale cache entry can at
// worst skip an incremental update — which the freshness check then catches by
// falling back to the exact in-process scan.
const indexExistenceCache = new WeakMap<StorageAdapter, Map<string, boolean>>();

function setIndexExistence(adapter: StorageAdapter, table: string, exists: boolean): void {
  let m = indexExistenceCache.get(adapter);
  if (!m) {
    m = new Map<string, boolean>();
    indexExistenceCache.set(adapter, m);
  }
  m.set(table, exists);
}

async function indexExistsCached(adapter: StorageAdapter, table: string): Promise<boolean> {
  const cached = indexExistenceCache.get(adapter)?.get(table);
  if (cached !== undefined) return cached;
  const exists = await hasVectorIndex(adapter, table);
  setIndexExistence(adapter, table, exists);
  return exists;
}

/**
 * Build (or rebuild) the native vector index for `table` from the JSON store,
 * for vectors of dimension `dim`. No-op when no native extension is available.
 * Returns the number of vectors indexed.
 *
 * @throws when called with an unavailable extension *and* `requireExtension` is
 *   true — surfacing a misconfiguration loudly rather than silently doing
 *   nothing. By default it is a reported no-op (returns 0).
 */
export async function buildVectorIndex(
  adapter: StorageAdapter,
  table: string,
  dim: number,
  requireExtension = false,
  opts: VectorIndexOptions = {},
): Promise<number> {
  // Postgres: pgvector's type/operators don't exist until the extension is
  // enabled in this database. Attempt it idempotently (a server that doesn't ship
  // pgvector throws, which we treat as "unavailable" below); invalidate the
  // availability cache so the freshly-created extension is seen.
  if (adapter.dialect === 'postgres') {
    try {
      await runAsyncOrSync(adapter, `CREATE EXTENSION IF NOT EXISTS vector`);
      availabilityCache.delete(adapter);
    } catch {
      /* pgvector not installed on this server — falls through to no-op/throw */
    }
  }
  if (!(await vectorIndexAvailable(adapter))) {
    if (requireExtension) {
      throw new Error(
        `buildVectorIndex: no native vector extension available on this ${adapter.dialect} connection ` +
          `(install pgvector / load sqlite-vec). Pass requireExtension=false to no-op instead.`,
      );
    }
    setIndexExistence(adapter, table, false);
    return 0;
  }
  const idx = vectorIndexName(table);
  // `dim` is interpolated into DDL (`vector(dim)` / `float[dim]`); coerce to a
  // positive integer so a non-numeric value can never reach the SQL string.
  const d = Math.trunc(dim);
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`buildVectorIndex: invalid vector dimension ${JSON.stringify(dim)}`);
  }

  if (adapter.dialect === 'postgres') {
    await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${idx}"`);
    await runAsyncOrSync(
      adapter,
      `CREATE TABLE "${idx}" (
         row_pk      TEXT NOT NULL,
         chunk_index INTEGER NOT NULL DEFAULT 0,
         content     TEXT,
         embedding   vector(${String(d)}) NOT NULL,
         PRIMARY KEY (row_pk, chunk_index)
       )`,
    );
    // Populate from the JSON store (the text JSON array casts straight to vector).
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${idx}" (row_pk, chunk_index, content, embedding)
         SELECT "row_pk", "chunk_index", "content", ("embedding")::vector
         FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
      [table],
    );
    // HNSW index for approximate nearest neighbor on cosine distance. Optional
    // build tuning (m / ef_construction) when supplied; otherwise pgvector's own
    // defaults — so an untuned build is byte-identical to before.
    const withParams = [
      hnswIntParam('m', opts.m),
      hnswIntParam('ef_construction', opts.efConstruction),
    ].filter((p): p is string => p !== null);
    const withClause = withParams.length ? ` WITH (${withParams.join(', ')})` : '';
    await runAsyncOrSync(
      adapter,
      `CREATE INDEX "${idx}_hnsw" ON "${idx}" USING hnsw (embedding vector_cosine_ops)${withClause}`,
    );
  } else {
    // sqlite-vec vec0 virtual table.
    await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${idx}"`);
    await runAsyncOrSync(
      adapter,
      `CREATE VIRTUAL TABLE "${idx}" USING vec0(row_pk TEXT, chunk_index INTEGER, embedding float[${String(d)}])`,
    );
    const stored = await allAsyncOrSync(
      adapter,
      `SELECT "row_pk", "chunk_index", "embedding" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
      [table],
    );
    // Unit-normalize so the vec0 L2 distance is cosine-equivalent at query time.
    const rows = stored.map(
      (r) =>
        [
          r.row_pk,
          r.chunk_index,
          JSON.stringify(normalizeVector(JSON.parse(String(r.embedding)) as number[])),
        ] as const,
    );
    const insert = `INSERT INTO "${idx}" (row_pk, chunk_index, embedding) VALUES (?, ?, ?)`;
    // Populate inside one transaction so an interrupted build can't leave a
    // half-filled index that looks complete (no native txn → sequential inserts).
    if (adapter.withClient) {
      await adapter.withClient(async (tx) => {
        for (const [rp, ci, v] of rows) await tx.run(insert, [rp, ci, v]);
      });
    } else {
      for (const [rp, ci, v] of rows) await runAsyncOrSync(adapter, insert, [rp, ci, v]);
    }
  }

  const count = await getAsyncOrSync(adapter, `SELECT count(*) AS n FROM "${idx}"`);
  const n = Number(count?.n ?? 0);
  setIndexExistence(adapter, table, true);
  await writeVectorMeta(adapter, table, {
    vecDim: d,
    metric: 'cosine',
    // m / ef_construction are pgvector HNSW build params; recorded only where they apply.
    hnswM: adapter.dialect === 'postgres' ? opts.m : undefined,
    hnswEfConstruction: adapter.dialect === 'postgres' ? opts.efConstruction : undefined,
    sourceCount: n,
    builtAt: new Date().toISOString(),
  });
  return n;
}

/** Drop a table's native vector index (and its registry row). */
export async function dropVectorIndex(adapter: StorageAdapter, table: string): Promise<void> {
  await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${vectorIndexName(table)}"`);
  setIndexExistence(adapter, table, false);
  await deleteVectorMeta(adapter, table);
}

/** Validate + format an HNSW integer build param for DDL interpolation, or null when unset. */
function hnswIntParam(name: string, v: number | undefined): string | null {
  if (v === undefined) return null;
  const i = Math.trunc(v);
  if (!Number.isFinite(i) || i <= 0) {
    throw new Error(`buildVectorIndex: invalid HNSW ${name} ${JSON.stringify(v)}`);
  }
  return `${name} = ${String(i)}`;
}

// ── Index metadata registry ────────────────────────────────────────────────
// A small bookkeeping table recording what was built per table (dim, metric,
// HNSW params, source chunk count, build time) for `lattice index status` and
// `doctor`. Internal (`__lattice_`-prefixed) — never granted to cloud members.

/** Internal registry table of built native vector indexes. */
export const VEC_META_TABLE = '__lattice_vector_index';

export interface VectorIndexMeta {
  table: string;
  vecDim: number;
  metric: string;
  hnswM: number | null;
  hnswEfConstruction: number | null;
  sourceCount: number;
  builtAt: string;
}

async function ensureVectorMetaTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${VEC_META_TABLE}" (
       "table_name"           TEXT PRIMARY KEY,
       "vec_dim"              INTEGER NOT NULL,
       "metric"               TEXT NOT NULL DEFAULT 'cosine',
       "hnsw_m"               INTEGER,
       "hnsw_ef_construction" INTEGER,
       "source_count"         INTEGER NOT NULL DEFAULT 0,
       "built_at"             TEXT NOT NULL
     )`,
  );
}

async function writeVectorMeta(
  adapter: StorageAdapter,
  table: string,
  meta: {
    vecDim: number;
    metric: string;
    hnswM?: number | undefined;
    hnswEfConstruction?: number | undefined;
    sourceCount: number;
    builtAt: string;
  },
): Promise<void> {
  await ensureVectorMetaTable(adapter);
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${VEC_META_TABLE}"
       ("table_name","vec_dim","metric","hnsw_m","hnsw_ef_construction","source_count","built_at")
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT ("table_name") DO UPDATE SET
       "vec_dim" = excluded."vec_dim",
       "metric" = excluded."metric",
       "hnsw_m" = excluded."hnsw_m",
       "hnsw_ef_construction" = excluded."hnsw_ef_construction",
       "source_count" = excluded."source_count",
       "built_at" = excluded."built_at"`,
    [
      table,
      meta.vecDim,
      meta.metric,
      meta.hnswM ?? null,
      meta.hnswEfConstruction ?? null,
      meta.sourceCount,
      meta.builtAt,
    ],
  );
}

async function deleteVectorMeta(adapter: StorageAdapter, table: string): Promise<void> {
  await ensureVectorMetaTable(adapter);
  await runAsyncOrSync(adapter, `DELETE FROM "${VEC_META_TABLE}" WHERE "table_name" = ?`, [table]);
}

/** Read a table's vector-index metadata, or null when none has been recorded. */
export async function getVectorIndexMeta(
  adapter: StorageAdapter,
  table: string,
): Promise<VectorIndexMeta | null> {
  // The registry table may not exist yet (no index ever built) — that's "no
  // metadata", not a failure, so an absent-relation read returns null.
  let row;
  try {
    row = await getAsyncOrSync(
      adapter,
      `SELECT "vec_dim","metric","hnsw_m","hnsw_ef_construction","source_count","built_at"
         FROM "${VEC_META_TABLE}" WHERE "table_name" = ?`,
      [table],
    );
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    table,
    vecDim: Number(row.vec_dim ?? 0),
    metric: typeof row.metric === 'string' ? row.metric : 'cosine',
    hnswM: row.hnsw_m == null ? null : Number(row.hnsw_m),
    hnswEfConstruction: row.hnsw_ef_construction == null ? null : Number(row.hnsw_ef_construction),
    sourceCount: Number(row.source_count ?? 0),
    builtAt: typeof row.built_at === 'string' ? row.built_at : '',
  };
}

/**
 * Whether the native index is in sync with the embeddings store for `table` —
 * i.e. it holds exactly the chunk vectors currently stored. Search consults this
 * before using the index so a drifted index is never silently served: on a
 * mismatch the caller falls back to the in-process scan (which reads the store
 * directly) until the index is rebuilt. Cheap — two COUNTs, negligible beside the
 * per-query embed() call that search already makes.
 *
 * The Postgres write path keeps the index in lock-step incrementally (so this
 * stays true after every write); backends without incremental maintenance rely
 * on this check to degrade to a correct scan rather than serve stale hits.
 */
export async function vectorIndexFresh(adapter: StorageAdapter, table: string): Promise<boolean> {
  const idxRow = await getAsyncOrSync(
    adapter,
    `SELECT count(*) AS n FROM "${vectorIndexName(table)}"`,
  );
  const srcRow = await getAsyncOrSync(
    adapter,
    `SELECT count(*) AS n FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
    [table],
  );
  // Distinct sentinels so a failed/absent read never reports a false "fresh".
  return Number(idxRow?.n ?? -1) === Number(srcRow?.n ?? -2);
}

/**
 * Keep the native index in lock-step with the store for ONE row, after that
 * row's chunks have been (re)written to the store: replace the row's existing
 * index rows with its current chunks. No-op when no native index exists.
 *
 * Incremental maintenance is implemented for Postgres/pgvector, where the index
 * is a plain table whose HNSW index self-maintains on DML. Other backends are
 * left to the search-time freshness check, which falls back to the exact scan
 * when the derived index has drifted — so they stay correct without per-write
 * index mutation (whose semantics differ across vec0 versions).
 */
export async function mirrorVectorIndexRow(
  adapter: StorageAdapter,
  table: string,
  pk: string,
): Promise<void> {
  if (adapter.dialect !== 'postgres') return;
  if (!(await indexExistsCached(adapter, table))) return;
  const idx = vectorIndexName(table);
  await runAsyncOrSync(adapter, `DELETE FROM "${idx}" WHERE "row_pk" = ?`, [pk]);
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${idx}" (row_pk, chunk_index, content, embedding)
       SELECT "row_pk", "chunk_index", "content", ("embedding")::vector
       FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ? AND "row_pk" = ?`,
    [table, pk],
  );
}

/** Remove ONE row's vectors from the native index (after the row's store chunks
 * were removed). No-op when no native index exists. Postgres-incremental; other
 * backends rely on the search-time freshness check (see {@link mirrorVectorIndexRow}). */
export async function removeVectorIndexRow(
  adapter: StorageAdapter,
  table: string,
  pk: string,
): Promise<void> {
  if (adapter.dialect !== 'postgres') return;
  if (!(await indexExistsCached(adapter, table))) return;
  await runAsyncOrSync(adapter, `DELETE FROM "${vectorIndexName(table)}" WHERE "row_pk" = ?`, [pk]);
}

/**
 * Reconcile the native index after a bulk embedding change (refreshEmbeddings).
 * No-op when no index exists; rebuilds it from the refreshed vectors, or drops it
 * when the table has no stored vectors left. Keeps the index usable (and fresh)
 * after a backfill without the caller having to remember to rebuild.
 */
export async function syncIndexAfterBulk(adapter: StorageAdapter, table: string): Promise<void> {
  if (!(await indexExistsCached(adapter, table))) return;
  const dimRow = await getAsyncOrSync(
    adapter,
    `SELECT "vec_dim" AS d FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ? AND "vec_dim" IS NOT NULL LIMIT 1`,
    [table],
  );
  const dim = Number(dimRow?.d ?? 0);
  if (dim <= 0) {
    await dropVectorIndex(adapter, table);
    return;
  }
  // Rebuild with the same tuning the index was originally built with (recorded in
  // the registry), so an auto-rebuild after a bulk refresh preserves the operator's
  // chosen HNSW params without the caller having to re-supply them.
  const meta = await getVectorIndexMeta(adapter, table);
  const rebuildOpts: VectorIndexOptions = {};
  if (meta?.hnswM != null) rebuildOpts.m = meta.hnswM;
  if (meta?.hnswEfConstruction != null) rebuildOpts.efConstruction = meta.hnswEfConstruction;
  await buildVectorIndex(adapter, table, dim, false, rebuildOpts);
}

/**
 * Query the native vector index for the nearest chunks to `queryVector`.
 * Returns up to `limit` hits with cosine similarity scores ≥ `minScore`.
 */
export async function searchVectorIndex(
  adapter: StorageAdapter,
  table: string,
  queryVector: number[],
  limit: number,
  minScore: number,
  efSearch?: number,
): Promise<VectorHit[]> {
  const idx = vectorIndexName(table);
  const qjson = JSON.stringify(queryVector);

  if (adapter.dialect === 'postgres') {
    // `<=>` is cosine distance in [0,2]; similarity = 1 − distance.
    const sql = `SELECT row_pk, chunk_index, content, 1 - (embedding <=> (?)::vector) AS score
         FROM "${idx}"
        ORDER BY embedding <=> (?)::vector
        LIMIT ${String(limit)}`;
    const toHits = (rows: Row[]): VectorHit[] =>
      rows
        .map((r) => ({
          pk: r.row_pk as string,
          chunkIndex: Number(r.chunk_index ?? 0),
          content: (r.content as string | null) ?? null,
          score: Number(r.score ?? 0),
        }))
        .filter((h) => h.score >= minScore);
    // Query-time HNSW breadth: `hnsw.ef_search` is a GUC, so it must be SET on the
    // same connection that runs the query — pin both in one transaction. Omitted →
    // pgvector's default, identical to before.
    if (efSearch !== undefined && adapter.withClient) {
      const ef = Math.trunc(efSearch);
      if (!Number.isFinite(ef) || ef <= 0) {
        throw new Error(`searchVectorIndex: invalid efSearch ${JSON.stringify(efSearch)}`);
      }
      return adapter.withClient(async (tx) => {
        await tx.run(`SET LOCAL hnsw.ef_search = ${String(ef)}`);
        return toHits(await tx.all(sql, [qjson, qjson]));
      });
    }
    return toHits(await allAsyncOrSync(adapter, sql, [qjson, qjson]));
  }

  // sqlite-vec: `distance` is L2 by default; vectors are L2-normalized for
  // cosine use, so similarity ≈ 1 − distance²/2. We expose the raw match and
  // convert to a cosine-comparable score.
  const rows = await allAsyncOrSync(
    adapter,
    `SELECT v.row_pk AS row_pk, v.chunk_index AS chunk_index, e.content AS content, v.distance AS distance
       FROM "${idx}" v
       LEFT JOIN "${EMBEDDINGS_TABLE}" e
         ON e."table_name" = ? AND e."row_pk" = v.row_pk AND e."chunk_index" = v.chunk_index
      WHERE v.embedding MATCH ? AND k = ${String(limit)}
      ORDER BY v.distance`,
    // Normalize the query to match the unit-normalized stored vectors (cosine).
    [table, JSON.stringify(normalizeVector(queryVector))],
  );
  return rows
    .map((r) => {
      const d = Number(r.distance ?? 0);
      const score = Math.max(0, 1 - (d * d) / 2);
      return {
        pk: r.row_pk as string,
        chunkIndex: Number(r.chunk_index ?? 0),
        content: (r.content as string | null) ?? null,
        score,
      };
    })
    .filter((h) => h.score >= minScore);
}
