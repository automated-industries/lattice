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
    // HNSW index for approximate nearest neighbor on cosine distance.
    await runAsyncOrSync(
      adapter,
      `CREATE INDEX "${idx}_hnsw" ON "${idx}" USING hnsw (embedding vector_cosine_ops)`,
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
    for (const r of stored) {
      // Unit-normalize so the vec0 L2 distance is cosine-equivalent at query time.
      const vec = normalizeVector(JSON.parse(String(r.embedding)) as number[]);
      await runAsyncOrSync(
        adapter,
        `INSERT INTO "${idx}" (row_pk, chunk_index, embedding) VALUES (?, ?, ?)`,
        [r.row_pk, r.chunk_index, JSON.stringify(vec)],
      );
    }
  }

  const count = await getAsyncOrSync(adapter, `SELECT count(*) AS n FROM "${idx}"`);
  return Number(count?.n ?? 0);
}

/** Drop a table's native vector index. */
export async function dropVectorIndex(adapter: StorageAdapter, table: string): Promise<void> {
  await runAsyncOrSync(adapter, `DROP TABLE IF EXISTS "${vectorIndexName(table)}"`);
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
): Promise<VectorHit[]> {
  const idx = vectorIndexName(table);
  const qjson = JSON.stringify(queryVector);

  if (adapter.dialect === 'postgres') {
    // `<=>` is cosine distance in [0,2]; similarity = 1 − distance.
    const rows = await allAsyncOrSync(
      adapter,
      `SELECT row_pk, chunk_index, content, 1 - (embedding <=> (?)::vector) AS score
         FROM "${idx}"
        ORDER BY embedding <=> (?)::vector
        LIMIT ${String(limit)}`,
      [qjson, qjson],
    );
    return rows
      .map((r) => ({
        pk: r.row_pk as string,
        chunkIndex: Number(r.chunk_index ?? 0),
        content: (r.content as string | null) ?? null,
        score: Number(r.score ?? 0),
      }))
      .filter((h) => h.score >= minScore);
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
