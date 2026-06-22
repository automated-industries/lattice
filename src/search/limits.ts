/**
 * Shared bounds for the search / retrieval hot paths. Centralizing the caps keeps
 * a caller-supplied `topK` from fanning out into an unbounded index/scan read: the
 * indexed arm over-fetches `topK * N` candidates before fusion, so without a cap a
 * single large `topK` turns one query into an effectively whole-table read.
 */

/** Upper bound on a single search's `topK`, applied before any `topK * N`
 *  candidate fan-out. Generous enough for real result pages; finite so a caller
 *  can never request an unbounded candidate pull. */
export const SEARCH_TOPK_MAX = 1000;

/** Clamp a caller-supplied `topK` to `[1, SEARCH_TOPK_MAX]`. */
export function clampTopK(topK: number): number {
  if (!Number.isFinite(topK)) return 1;
  return Math.min(Math.max(1, Math.floor(topK)), SEARCH_TOPK_MAX);
}
