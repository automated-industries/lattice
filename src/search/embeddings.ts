import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import type { Row, EmbeddingsConfig, SearchResult } from '../types.js';

/** Internal table that stores one embedding vector per (table, row). */
export const EMBEDDINGS_TABLE = '_lattice_embeddings';

/**
 * Ensure the internal embeddings storage table exists.
 */
export async function ensureEmbeddingsTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${EMBEDDINGS_TABLE}" (
    "table_name" TEXT NOT NULL,
    "row_pk"     TEXT NOT NULL,
    "embedding"  TEXT NOT NULL,
    PRIMARY KEY ("table_name", "row_pk")
  )`,
  );
}

/**
 * Compute and store an embedding for a row.
 */
export async function storeEmbedding(
  adapter: StorageAdapter,
  table: string,
  pk: string,
  row: Row,
  config: EmbeddingsConfig,
): Promise<void> {
  const text = config.fields
    .map((f) => {
      const v = row[f];
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return JSON.stringify(v);
    })
    .filter((s) => s.length > 0)
    .join(' ');

  if (text.length === 0) return;

  const vector = await config.embed(text);
  // Portable upsert: `INSERT OR REPLACE` is SQLite-only (the Postgres adapter
  // refuses to translate it), so use the `ON CONFLICT ... DO UPDATE` form, which
  // both engines accept and which keys on the (table_name, row_pk) primary key.
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${EMBEDDINGS_TABLE}" ("table_name", "row_pk", "embedding") VALUES (?, ?, ?)
     ON CONFLICT ("table_name", "row_pk") DO UPDATE SET "embedding" = excluded."embedding"`,
    [table, pk, JSON.stringify(vector)],
  );
}

/**
 * Remove a stored embedding.
 */
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

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Search for rows by semantic similarity.
 *
 * 1. Embed the query text
 * 2. Load all stored embeddings for the table
 * 3. Compute cosine similarity
 * 4. Return top-K results above minScore
 */
export async function searchByEmbedding(
  adapter: StorageAdapter,
  table: string,
  queryText: string,
  config: EmbeddingsConfig,
  topK: number,
  minScore: number,
  pkColumn = 'id',
): Promise<SearchResult[]> {
  const queryVector = await config.embed(queryText);

  const stored = await allAsyncOrSync(
    adapter,
    `SELECT "row_pk", "embedding" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ?`,
    [table],
  );

  const scored: { pk: string; score: number }[] = [];
  for (const entry of stored) {
    const vec = JSON.parse(entry.embedding as string) as number[];
    const score = cosineSimilarity(queryVector, vec);
    if (score >= minScore) {
      scored.push({ pk: entry.row_pk as string, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, topK);

  // Fetch full rows using the table's primary key column
  const results: SearchResult[] = [];
  for (const { pk, score } of topResults) {
    const row = await getAsyncOrSync(adapter, `SELECT * FROM "${table}" WHERE "${pkColumn}" = ?`, [
      pk,
    ]);
    if (row) {
      results.push({ row, score });
    }
  }

  return results;
}
