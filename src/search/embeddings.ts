import type { StorageAdapter } from '../db/adapter.js';
import {
  runAsyncOrSync,
  getAsyncOrSync,
  allAsyncOrSync,
  introspectColumnsAsyncOrSync,
} from '../db/adapter.js';
import type { Row, EmbeddingsConfig, SearchResult } from '../types.js';
import { chunkText } from './chunking.js';
import {
  vectorIndexAvailable,
  hasVectorIndex,
  vectorIndexFresh,
  searchVectorIndex,
  syncIndexAfterBulk,
  invalidateVectorTypeCache,
} from './vector-index.js';
import { clampTopK } from './limits.js';

/** Internal table that stores one embedding vector per (table, row, chunk). */
export const EMBEDDINGS_TABLE = '_lattice_embeddings';

/**
 * Ensure the internal embeddings storage table exists with the chunk-aware
 * schema, migrating an older two-key (table_name, row_pk) layout forward.
 *
 * The embeddings table is a DERIVED cache — every vector can be recomputed from
 * its source row — so when an older schema is detected it is rebuilt rather than
 * preserved bit-for-bit. The migration is idempotent: once `chunk_index` exists
 * the function is a no-op.
 */
export async function ensureEmbeddingsTable(adapter: StorageAdapter): Promise<void> {
  let cols: string[] = [];
  try {
    cols = await introspectColumnsAsyncOrSync(adapter, EMBEDDINGS_TABLE);
  } catch {
    cols = [];
  }

  if (cols.length === 0) {
    // Fresh — create with the full chunk-aware schema.
    await runAsyncOrSync(
      adapter,
      `CREATE TABLE IF NOT EXISTS "${EMBEDDINGS_TABLE}" (
         "table_name"      TEXT NOT NULL,
         "row_pk"          TEXT NOT NULL,
         "chunk_index"     INTEGER NOT NULL DEFAULT 0,
         "content"         TEXT,
         "embedding"       TEXT NOT NULL,
         "embedding_model" TEXT,
         "embedded_at"     TEXT,
         "vec_dim"         INTEGER,
         PRIMARY KEY ("table_name", "row_pk", "chunk_index")
       )`,
    );
    return;
  }

  if (cols.includes('chunk_index')) return; // already migrated

  // Migrate the legacy (table_name, row_pk, embedding) layout forward.
  if (adapter.dialect === 'postgres') {
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD COLUMN IF NOT EXISTS "chunk_index" INTEGER NOT NULL DEFAULT 0`,
    );
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD COLUMN IF NOT EXISTS "content" TEXT`,
    );
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT`,
    );
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD COLUMN IF NOT EXISTS "embedded_at" TEXT`,
    );
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD COLUMN IF NOT EXISTS "vec_dim" INTEGER`,
    );
    // Repoint the primary key to include chunk_index (existing rows default to 0,
    // so the (table_name,row_pk,chunk_index) triple stays unique).
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" DROP CONSTRAINT IF EXISTS "${EMBEDDINGS_TABLE}_pkey"`,
    );
    await runAsyncOrSync(
      adapter,
      `ALTER TABLE "${EMBEDDINGS_TABLE}" ADD PRIMARY KEY ("table_name", "row_pk", "chunk_index")`,
    );
    return;
  }

  // SQLite can't repoint a primary key in place — rebuild the (derived) table.
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE "${EMBEDDINGS_TABLE}_v2" (
       "table_name"      TEXT NOT NULL,
       "row_pk"          TEXT NOT NULL,
       "chunk_index"     INTEGER NOT NULL DEFAULT 0,
       "content"         TEXT,
       "embedding"       TEXT NOT NULL,
       "embedding_model" TEXT,
       "embedded_at"     TEXT,
       "vec_dim"         INTEGER,
       PRIMARY KEY ("table_name", "row_pk", "chunk_index")
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${EMBEDDINGS_TABLE}_v2" ("table_name", "row_pk", "chunk_index", "embedding")
       SELECT "table_name", "row_pk", 0, "embedding" FROM "${EMBEDDINGS_TABLE}"`,
  );
  await runAsyncOrSync(adapter, `DROP TABLE "${EMBEDDINGS_TABLE}"`);
  await runAsyncOrSync(
    adapter,
    `ALTER TABLE "${EMBEDDINGS_TABLE}_v2" RENAME TO "${EMBEDDINGS_TABLE}"`,
  );
}

/** Concatenate the configured fields of a row into a single embeddable string. */
export function concatRowText(row: Row, fields: string[]): string {
  return fields
    .map((f) => {
      const v = row[f];
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return JSON.stringify(v);
    })
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Compute and store the embedding(s) for a row. When the config supplies a
 * `chunker`, the row text is split and each chunk is embedded + stored under its
 * own `chunk_index`; otherwise the whole text is one chunk (index 0). The row's
 * prior chunks are replaced atomically-per-row (delete then insert).
 */
export async function storeEmbedding(
  adapter: StorageAdapter,
  table: string,
  pk: string,
  row: Row,
  config: EmbeddingsConfig,
): Promise<void> {
  const text = concatRowText(row, config.fields);
  if (text.length === 0) {
    await removeEmbedding(adapter, table, pk);
    return;
  }

  const prefix = config.contextPrefix?.(row);
  const chunks = chunkText(text, config.chunker, prefix);
  const at = new Date().toISOString();
  const model = config.modelId ?? null;

  // Replace this row's chunks wholesale so a shrinking chunk count never leaves
  // stale higher-index chunks behind.
  await removeEmbedding(adapter, table, pk);
  for (const ch of chunks) {
    const vector = await config.embed(ch.content);
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${EMBEDDINGS_TABLE}"
         ("table_name", "row_pk", "chunk_index", "content", "embedding", "embedding_model", "embedded_at", "vec_dim")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT ("table_name", "row_pk", "chunk_index")
         DO UPDATE SET "content" = excluded."content",
                       "embedding" = excluded."embedding",
                       "embedding_model" = excluded."embedding_model",
                       "embedded_at" = excluded."embedded_at",
                       "vec_dim" = excluded."vec_dim"`,
      [table, pk, ch.chunkIndex, ch.content, JSON.stringify(vector), model, at, vector.length],
    );
  }
}

/** Remove all stored embedding chunks for a row. */
export async function removeEmbedding(
  adapter: StorageAdapter,
  table: string,
  pk: string,
): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ? AND "row_pk" = ?`,
    [table, pk],
  );
}

/** Coerce a primary-key cell to a string, or null when it isn't a scalar. */
function pkToString(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

interface RankedChunk {
  pk: string;
  score: number;
  chunkIndex: number;
  content: string | null;
}

/**
 * Error thrown when a stored vector's dimensionality does not match the query
 * vector's — almost always a sign the embedding model changed without a
 * re-embed. Surfaced loudly rather than silently scoring mismatched vectors.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly table: string,
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `Embedding dimension mismatch on "${table}": query is ${String(expected)}-d but a stored vector is ${String(found)}-d. ` +
        `Re-embed the table (refreshEmbeddings) after changing the embedding model.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * Thrown by `searchByEmbedding` when the no-index fallback cosine scan would read
 * more stored chunk vectors than the configured `maxScanChunks`. The scan is
 * never silently truncated (that would return incomplete, wrong results) — it
 * fails loudly so the caller adds a native vector index or raises the cap.
 */
export class EmbeddingScanTooLargeError extends Error {
  constructor(
    readonly table: string,
    readonly found: number,
    readonly limit: number,
  ) {
    super(
      `Embedding scan on "${table}" would read ${String(found)} stored chunk vectors, ` +
        `over the configured maxScanChunks of ${String(limit)}. Add a native vector index ` +
        `(pgvector) for this table or raise maxScanChunks — Lattice will not silently ` +
        `truncate the scan, which would return incomplete results.`,
    );
    this.name = 'EmbeddingScanTooLargeError';
  }
}

/**
 * Search rows by semantic similarity. Uses a native vector index (pgvector) when
 * one exists for the table; otherwise an in-process cosine scan over the stored
 * chunk vectors. Either way results respect `deleted_at IS NULL` on the base
 * table and are de-duplicated to the best-scoring chunk per row.
 */
export async function searchByEmbedding(
  adapter: StorageAdapter,
  table: string,
  queryText: string,
  config: EmbeddingsConfig,
  topK: number,
  minScore: number,
  pkColumn = 'id',
  isCloudMember = false,
  efSearch?: number,
): Promise<SearchResult[]> {
  const queryVector = await config.embed(queryText);
  // Bound the candidate fan-out: the indexed arm over-fetches `k * 4` below, so
  // clamp before that multiply rather than trust a caller-supplied topK.
  const k = clampTopK(topK);

  let ranked: RankedChunk[];
  if (isCloudMember) {
    // A cloud member has no grant on the internal embeddings store or the native
    // index, so it can use neither the index nor a direct scan. Read only the
    // chunks for rows it may see (via a SECURITY DEFINER function) and score them
    // in-process — exact (no recall loss) and visibility-correct, with no
    // over-fetch channel by which a member could infer rows hidden from it.
    ranked = await scanVisibleChunks(adapter, table, queryVector, minScore, config.maxScanChunks);
  } else if (
    // Native-index fast path (pgvector). The index is used only when it exists AND
    // is in sync with the stored vectors; a drifted index falls back to the exact
    // in-process scan so search never serves results from a stale index (the scan
    // reads the source-of-truth store directly).
    (await vectorIndexAvailable(adapter)) &&
    (await hasVectorIndex(adapter, table)) &&
    (await vectorIndexFresh(adapter, table))
  ) {
    try {
      const hits = await searchVectorIndex(adapter, table, queryVector, k * 4, minScore, efSearch);
      ranked = hits.map((h) => ({
        pk: h.pk,
        score: h.score,
        chunkIndex: h.chunkIndex,
        content: h.content,
      }));
    } catch {
      // A native-index query can fail if this connection's cached column type drifted
      // from the actual index (e.g. another connection rebuilt it as halfvec, so the
      // cached `::vector` cast no longer matches). Drop the stale cache and fall back
      // to the exact in-process scan — correct results, never a thrown query.
      invalidateVectorTypeCache(adapter, table);
      ranked = await scanChunks(adapter, table, queryVector, minScore, config.maxScanChunks);
    }
  } else {
    ranked = await scanChunks(adapter, table, queryVector, minScore, config.maxScanChunks);
  }

  // Best chunk per row, then sort rows by their best score.
  const bestByRow = new Map<string, RankedChunk>();
  for (const r of ranked) {
    const cur = bestByRow.get(r.pk);
    if (!cur || r.score > cur.score) bestByRow.set(r.pk, r);
  }
  const rankedRows = [...bestByRow.values()].sort((a, b) => b.score - a.score);
  if (rankedRows.length === 0) return [];

  // Fetch the candidate rows, excluding soft-deleted ones, then assemble the
  // top-K in ranked order from the live set. (Row-level RLS on the base relation
  // independently re-checks visibility for a member — defense in depth.)
  const live = await fetchLiveRows(
    adapter,
    table,
    rankedRows.map((r) => r.pk),
    pkColumn,
    isCloudMember,
  );
  const results: SearchResult[] = [];
  for (const r of rankedRows) {
    const row = live.get(r.pk);
    if (!row) continue;
    const result: SearchResult = { row, score: r.score };
    if (r.chunkIndex > 0 || r.content !== null) {
      result.chunkIndex = r.chunkIndex;
      if (r.content !== null) {
        // The stored chunk content is NOT column-masked, so for a cloud member it
        // could echo an owner-audience field's cleartext (the row object is masked
        // via <table>_v, but the raw chunk is not). Re-derive matchedContent from
        // the already-masked row so masked fields drop out; owners/local callers
        // keep the exact matched chunk.
        result.matchedContent = isCloudMember ? concatRowText(row, config.fields) : r.content;
      }
    }
    results.push(result);
    if (results.length >= k) break;
  }
  return results;
}

/** Cosine-score already-fetched chunk rows against the query, keeping those ≥ minScore. */
function scoreStoredChunks(
  table: string,
  stored: Row[],
  queryVector: number[],
  minScore: number,
): RankedChunk[] {
  const out: RankedChunk[] = [];
  for (const entry of stored) {
    const vec = JSON.parse(entry.embedding as string) as number[];
    if (vec.length !== queryVector.length) {
      throw new EmbeddingDimensionMismatchError(table, queryVector.length, vec.length);
    }
    const score = cosineSimilarity(queryVector, vec);
    if (score >= minScore) {
      out.push({
        pk: entry.row_pk as string,
        score,
        chunkIndex: Number(entry.chunk_index ?? 0),
        content: (entry.content as string | null) ?? null,
      });
    }
  }
  return out;
}

/** Generous default bound on the no-index scan when the caller didn't set one — high
 *  enough never to affect realistic tables, low enough to refuse a pathological
 *  whole-table vector load rather than exhaust memory. Override via maxScanChunks. */
const DEFAULT_MAX_SCAN_CHUNKS = 100_000;

/** In-process cosine scan over the stored chunk vectors for a table. */
async function scanChunks(
  adapter: StorageAdapter,
  table: string,
  queryVector: number[],
  minScore: number,
  maxScanChunks?: number,
): Promise<RankedChunk[]> {
  // Always bound the scan (defaulting when not opted in): count first and refuse
  // loudly rather than load an unbounded vector set into memory. Never silently
  // truncate — a partial cosine scan would return wrong results.
  const cap = maxScanChunks ?? DEFAULT_MAX_SCAN_CHUNKS;
  {
    const countRows = await allAsyncOrSync(
      adapter,
      `SELECT COUNT(*) AS n FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
      [table],
    );
    const n = Number(countRows[0]?.n ?? 0); // pg returns COUNT(*) as a string
    if (n > cap) throw new EmbeddingScanTooLargeError(table, n, cap);
  }
  const stored = await allAsyncOrSync(
    adapter,
    `SELECT "row_pk", "chunk_index", "content", "embedding", "vec_dim" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
    [table],
  );
  return scoreStoredChunks(table, stored, queryVector, minScore);
}

/**
 * Member-scoped cosine scan. A cloud member has no grant on the internal
 * embeddings store, so it reads only the chunk vectors for rows it may see via the
 * `lattice_visible_embeddings` SECURITY DEFINER function (filtered by
 * `lattice_row_visible`, keyed on the member's role) and scores them in-process.
 * Identical scoring to {@link scanChunks}; the `maxScanChunks` bound counts the
 * member-visible set (its `lattice_visible_embedding_count` companion).
 */
async function scanVisibleChunks(
  adapter: StorageAdapter,
  table: string,
  queryVector: number[],
  minScore: number,
  maxScanChunks?: number,
): Promise<RankedChunk[]> {
  if (maxScanChunks !== undefined) {
    const countRow = await getAsyncOrSync(
      adapter,
      `SELECT lattice_visible_embedding_count(?) AS n`,
      [table],
    );
    const n = Number(countRow?.n ?? 0);
    if (n > maxScanChunks) throw new EmbeddingScanTooLargeError(table, n, maxScanChunks);
  }
  const stored = await allAsyncOrSync(adapter, `SELECT * FROM lattice_visible_embeddings(?)`, [
    table,
  ]);
  return scoreStoredChunks(table, stored, queryVector, minScore);
}

/**
 * The relation a caller should read a table's rows FROM. Owners (and all local /
 * non-cloud callers) read the base table. A cloud member reads the `<table>_v`
 * audience view when one exists (masked tables revoke a member's base SELECT and
 * expose the view instead); otherwise the base table, which carries the member's
 * row-level RLS filter. Either way the read is visibility-filtered for the member.
 */
async function readRelation(
  adapter: StorageAdapter,
  table: string,
  isCloudMember: boolean,
): Promise<string> {
  if (!isCloudMember || adapter.dialect !== 'postgres') return table;
  const row = await getAsyncOrSync(adapter, `SELECT to_regclass(?) AS reg`, [`${table}_v`]);
  return row && (row as { reg?: unknown }).reg != null ? `${table}_v` : table;
}

/**
 * Fetch the given pks that are not soft-deleted, keyed by pk. Shared by semantic
 * and hybrid search. For a cloud member the read goes through the member-readable
 * relation (audience view or RLS-filtered base table), so row visibility is
 * re-enforced here independently of how the candidate pks were produced.
 */
export async function fetchLiveRows(
  adapter: StorageAdapter,
  table: string,
  pks: string[],
  pkColumn: string,
  isCloudMember = false,
): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (pks.length === 0) return out;
  const relation = await readRelation(adapter, table, isCloudMember);
  let cols: string[] = [];
  try {
    cols = await introspectColumnsAsyncOrSync(adapter, relation);
  } catch {
    cols = [];
  }
  const hasDeletedAt = cols.includes('deleted_at');
  const placeholders = pks.map(() => '?').join(', ');
  const where = `"${pkColumn}" IN (${placeholders})${hasDeletedAt ? ' AND "deleted_at" IS NULL' : ''}`;
  const rows = await allAsyncOrSync(adapter, `SELECT * FROM "${relation}" WHERE ${where}`, pks);
  for (const row of rows) {
    const key = pkToString(row[pkColumn]);
    if (key !== null) out.set(key, row);
  }
  return out;
}

export interface RefreshEmbeddingsOptions {
  /** Only re-embed rows whose stored model differs from `config.modelId`. */
  staleModelOnly?: boolean;
  /** Embed rows that have no stored embedding. Default true. */
  backfillMissing?: boolean;
  /** Re-embed rows whose source changed since `embedded_at` (caller decides via `changedSince`). */
  changedSince?: string;
  /** Page size for the base-table scan. Default 500. */
  batchSize?: number;
}

export interface EmbeddingRefreshResult {
  /** Rows that were (re-)embedded. */
  embedded: number;
  /** Rows skipped because they were already current. */
  skipped: number;
  /** Orphaned embeddings removed (their source row no longer exists). */
  removed: number;
}

/**
 * Backfill / re-embed a table's vectors incrementally — embed only what's
 * missing or stale, rather than re-embedding everything. Honors `deleted_at`
 * and sweeps embeddings whose source row is gone.
 */
export async function refreshEmbeddings(
  adapter: StorageAdapter,
  table: string,
  config: EmbeddingsConfig,
  pkColumn = 'id',
  opts: RefreshEmbeddingsOptions = {},
): Promise<EmbeddingRefreshResult> {
  await ensureEmbeddingsTable(adapter);
  const batchSize = opts.batchSize ?? 500;
  const backfillMissing = opts.backfillMissing ?? true;

  let cols: string[] = [];
  try {
    cols = await introspectColumnsAsyncOrSync(adapter, table);
  } catch {
    cols = [];
  }
  const hasDeletedAt = cols.includes('deleted_at');

  // Existing embedding metadata per row (one entry per row — chunk 0 suffices
  // for model/timestamp).
  const meta = new Map<string, { model: string | null; at: string | null }>();
  const metaRows = await allAsyncOrSync(
    adapter,
    `SELECT "row_pk", "embedding_model", "embedded_at" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ? AND "chunk_index" = 0`,
    [table],
  );
  for (const r of metaRows) {
    meta.set(r.row_pk as string, {
      model: (r.embedding_model as string | null) ?? null,
      at: (r.embedded_at as string | null) ?? null,
    });
  }

  let embedded = 0;
  let skipped = 0;
  const livePks = new Set<string>();

  // Page through the base table.
  let offset = 0;
  for (;;) {
    const where = hasDeletedAt ? `WHERE "deleted_at" IS NULL` : '';
    const rows = await allAsyncOrSync(
      adapter,
      `SELECT * FROM "${table}" ${where} ORDER BY "${pkColumn}" LIMIT ${String(batchSize)} OFFSET ${String(offset)}`,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const pk = pkToString(row[pkColumn]);
      if (pk === null) continue;
      livePks.add(pk);

      const existing = meta.get(pk);
      const needsBackfill = backfillMissing && !existing;
      const staleModel =
        opts.staleModelOnly && existing ? existing.model !== (config.modelId ?? null) : false;
      const staleByTime =
        opts.changedSince && existing?.at ? existing.at < opts.changedSince : false;

      if (
        needsBackfill ||
        staleModel ||
        staleByTime ||
        (!opts.staleModelOnly && !opts.changedSince && !existing)
      ) {
        await storeEmbedding(adapter, table, pk, row, config);
        embedded++;
      } else {
        skipped++;
      }
    }
    if (rows.length < batchSize) break;
    offset += batchSize;
  }

  // Sweep orphaned embeddings (source row deleted/absent).
  let removed = 0;
  const embeddedPks = await allAsyncOrSync(
    adapter,
    `SELECT DISTINCT "row_pk" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
    [table],
  );
  for (const r of embeddedPks) {
    const pk = r.row_pk as string;
    if (!livePks.has(pk)) {
      await removeEmbedding(adapter, table, pk);
      removed++;
    }
  }

  // Keep an existing native index in step with the refreshed vectors so semantic
  // search keeps using the index (not the scan fallback) after a bulk backfill.
  await syncIndexAfterBulk(adapter, table);

  return { embedded, skipped, removed };
}
