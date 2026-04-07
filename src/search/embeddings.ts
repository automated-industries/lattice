import type { StorageAdapter } from '../db/adapter.js';
import type { Row, EmbeddingsConfig, SearchResult } from '../types.js';

const EMBEDDINGS_TABLE = '_lattice_embeddings';

/**
 * Ensure the internal embeddings storage table exists.
 */
export function ensureEmbeddingsTable(adapter: StorageAdapter): void {
  adapter.run(`CREATE TABLE IF NOT EXISTS "${EMBEDDINGS_TABLE}" (
    "table_name" TEXT NOT NULL,
    "row_pk"     TEXT NOT NULL,
    "embedding"  TEXT NOT NULL,
    PRIMARY KEY ("table_name", "row_pk")
  )`);
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
      return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    })
    .filter((s) => s.length > 0)
    .join(' ');

  if (text.length === 0) return;

  const vector = await config.embed(text);
  adapter.run(
    `INSERT OR REPLACE INTO "${EMBEDDINGS_TABLE}" ("table_name", "row_pk", "embedding") VALUES (?, ?, ?)`,
    [table, pk, JSON.stringify(vector)],
  );
}

/**
 * Remove a stored embedding.
 */
export function removeEmbedding(adapter: StorageAdapter, table: string, pk: string): void {
  adapter.run(`DELETE FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = ? AND "row_pk" = ?`, [
    table,
    pk,
  ]);
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
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) * (a[i] ?? 0);
    magB += (b[i] ?? 0) * (b[i] ?? 0);
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

  const stored = adapter.all(
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
    const row = adapter.get(`SELECT * FROM "${table}" WHERE "${pkColumn}" = ?`, [pk]);
    if (row) {
      results.push({ row, score });
    }
  }

  return results;
}
