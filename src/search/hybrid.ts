/**
 * Hybrid search — fuse semantic (vector) retrieval with lexical (full-text)
 * retrieval so the result set has both the recall of embeddings and the
 * precision of exact-term matching. Neither arm alone is enough: vectors miss
 * rare exact tokens (names, ids, codes), keywords miss paraphrases.
 *
 * Fusion is Reciprocal Rank Fusion (RRF): a document's score is the sum over the
 * arms it appears in of `1 / (k + rank)`, with `k = 60` by default. RRF needs
 * only the per-arm *ranks*, so the two arms' incomparable score scales (cosine
 * similarity vs ts_rank/bm25) never have to be normalized against each other.
 *
 * Optional post-fusion stages: deterministic ranking signals (recency / reward /
 * custom) and a bring-your-own reranker. Results carry a full score breakdown
 * for `--explain`.
 */

import type { StorageAdapter } from '../db/adapter.js';
import type { Row, EmbeddingsConfig } from '../types.js';
import { searchByEmbedding, fetchLiveRows } from './embeddings.js';
import { fullTextSearch } from './fts.js';
import { rankingBoost, type RankingOptions } from './ranking.js';
import { applyReranker, type RerankerFn } from './rerank.js';
import { clampTopK } from './limits.js';

export interface HybridSearchOptions {
  /** Final number of results. Default 10. */
  topK?: number;
  /** RRF constant — larger flattens the rank contribution. Default 60. */
  rrfK?: number;
  /** Candidates pulled from each arm before fusion. Default max(topK*4, 20). */
  poolSize?: number;
  /** Minimum cosine similarity for the vector arm. Default 0. */
  minVectorScore?: number;
  /** Embeddings config — enables the vector arm. Omit for FTS-only fusion. */
  embeddingsConfig?: EmbeddingsConfig;
  /** Primary-key column of the base table. Default 'id'. */
  pkColumn?: string;
  /** Deterministic post-fusion ranking signals. */
  ranking?: RankingOptions;
  /** Optional reranker over the fused top candidates (graceful fallback). */
  reranker?: RerankerFn;
  /**
   * Caller is a scoped cloud member (no grant on the internal embeddings store /
   * vector index). Routes the vector arm and row materialization through the
   * member-safe, row-visibility-filtered paths. Default false (owner / local).
   */
  isCloudMember?: boolean;
}

/** Per-result score breakdown (the `--explain` payload). */
export interface HybridScoreBreakdown {
  /** Final score used for ordering. */
  final: number;
  /** Reciprocal-rank-fusion score before ranking/rerank. */
  rrf: number;
  /** 1-based rank in the vector arm, or null if absent. */
  vectorRank: number | null;
  /** Cosine similarity from the vector arm, or null. */
  vectorScore: number | null;
  /** 1-based rank in the FTS arm, or null if absent. */
  ftsRank: number | null;
  /** FTS relevance score (ts_rank / -bm25), or null. */
  ftsScore: number | null;
  /** Multiplicative ranking boost applied (0 when no ranking signals). */
  rankingBoost: number;
  /** Reranker score, when a reranker actually scored this row. */
  rerankerScore?: number;
}

export interface HybridSearchResult {
  row: Row;
  score: number;
  explain: HybridScoreBreakdown;
  /** Best-matching chunk text from the vector arm, when available. */
  matchedContent?: string;
}

interface ArmEntry {
  rank: number;
  score: number;
}

/**
 * Run a hybrid (vector + full-text) search over one table and return fused,
 * optionally ranked + reranked results with a per-result score breakdown.
 * Soft-deleted rows are excluded (both arms honor `deleted_at`).
 */
export async function hybridSearch(
  adapter: StorageAdapter,
  table: string,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchResult[]> {
  // Clamp before the `topK * 4` pool fan-out below so a large caller topK can't
  // pull an effectively unbounded candidate set from each arm.
  const topK = clampTopK(opts.topK ?? 10);
  const rrfK = opts.rrfK ?? 60;
  const pool = opts.poolSize ?? Math.max(topK * 4, 20);
  const pkColumn = opts.pkColumn ?? 'id';
  const isMember = opts.isCloudMember ?? false;

  // --- Vector arm ---------------------------------------------------------
  const vectorArm = new Map<string, ArmEntry>();
  const rowById = new Map<string, Row>();
  const contentById = new Map<string, string>();
  if (opts.embeddingsConfig) {
    const vres = await searchByEmbedding(
      adapter,
      table,
      query,
      opts.embeddingsConfig,
      pool,
      opts.minVectorScore ?? 0,
      pkColumn,
      isMember,
    );
    vres.forEach((r, i) => {
      const id = String(r.row[pkColumn]);
      vectorArm.set(id, { rank: i + 1, score: r.score });
      rowById.set(id, r.row);
      if (r.matchedContent) contentById.set(id, r.matchedContent);
    });
  }

  // --- FTS arm ------------------------------------------------------------
  const ftsArm = new Map<string, ArmEntry>();
  const ftsResult = await fullTextSearch(adapter, [table], { query, limitPerTable: pool });
  const ftsGroup = ftsResult.groups.find((g) => g.table === table);
  if (ftsGroup) {
    ftsGroup.hits.forEach((h, i) => {
      if (h.id) ftsArm.set(h.id, { rank: i + 1, score: h.score ?? 0 });
    });
  }

  // --- Reciprocal Rank Fusion --------------------------------------------
  const allIds = new Set<string>([...vectorArm.keys(), ...ftsArm.keys()]);
  if (allIds.size === 0) return [];

  // Fetch rows for ids the vector arm didn't already supply (FTS-only ids).
  const missing = [...allIds].filter((id) => !rowById.has(id));
  const fetched = await fetchLiveRows(adapter, table, missing, pkColumn, isMember);
  for (const [id, row] of fetched) rowById.set(id, row);

  const now = opts.ranking?.now;
  const fused: HybridSearchResult[] = [];
  for (const id of allIds) {
    const row = rowById.get(id);
    if (!row) continue; // soft-deleted or not fetchable
    const v = vectorArm.get(id);
    const f = ftsArm.get(id);
    const rrf = (v ? 1 / (rrfK + v.rank) : 0) + (f ? 1 / (rrfK + f.rank) : 0);
    const boost = opts.ranking
      ? rankingBoost(row, now !== undefined ? { ...opts.ranking, now } : opts.ranking)
      : 0;
    const final = rrf * (1 + boost);
    const result: HybridSearchResult = {
      row,
      score: final,
      explain: {
        final,
        rrf,
        vectorRank: v ? v.rank : null,
        vectorScore: v ? v.score : null,
        ftsRank: f ? f.rank : null,
        ftsScore: f ? f.score : null,
        rankingBoost: boost,
      },
    };
    const content = contentById.get(id);
    if (content) result.matchedContent = content;
    fused.push(result);
  }

  fused.sort((a, b) => b.score - a.score);

  // --- Optional reranker (graceful fallback) ------------------------------
  if (opts.reranker) {
    const candidates = fused.slice(0, pool).map((r) => ({
      id: String(r.row[pkColumn]),
      content: r.matchedContent ?? rowText(r.row),
      result: r,
    }));
    const { order, applied, scores } = await applyReranker(query, candidates, opts.reranker);
    if (applied) {
      const reranked = order.map((c) => {
        const s = scores.get(c.id);
        if (s !== undefined) {
          c.result.explain.rerankerScore = s;
          c.result.score = s;
          c.result.explain.final = s;
        }
        return c.result;
      });
      const tail = fused.slice(pool);
      return [...reranked, ...tail].slice(0, topK);
    }
  }

  return fused.slice(0, topK);
}

/** Fallback text for reranking when the vector arm provided no chunk content. */
function rowText(row: Row): string {
  return Object.entries(row)
    .filter(([k]) => !k.startsWith('_') && k !== 'deleted_at')
    .map(([, v]) =>
      typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '',
    )
    .filter((s) => s.length > 0)
    .join(' ');
}
