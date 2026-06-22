/**
 * Reranking — an optional second-stage scorer applied to the top candidates of
 * a first-stage retrieval (vector / FTS / hybrid). A cross-encoder reranker
 * typically lifts precision@k meaningfully over bi-encoder similarity, at the
 * cost of one model call over the (small) candidate set.
 *
 * Bring your own reranker: Lattice never calls a model. The reranker is given
 * the query and the candidate texts and returns a score per candidate; higher =
 * more relevant. If it throws or returns nothing usable, retrieval falls back to
 * the first-stage order — a reranker is an enhancement, never a hard dependency.
 */

/** A candidate handed to a reranker: an id and the text to score against the query. */
export interface RerankCandidate {
  id: string;
  content: string;
}

/** A reranker's verdict for one candidate. */
export interface RerankScore {
  id: string;
  score: number;
}

/**
 * Rerank `candidates` for `query`, returning a score per id (higher = better).
 * May be sync or async. Ids absent from the result keep their prior order after
 * any that were scored.
 */
export type RerankerFn = (
  query: string,
  candidates: RerankCandidate[],
) => Promise<RerankScore[]> | RerankScore[];

/** Runtime guard for a single reranker result entry (the reranker is BYO JS). */
function isRerankScore(x: unknown): x is RerankScore {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.score === 'number';
}

/**
 * Apply a reranker to an ordered list of items, returning a new order. Each item
 * supplies its `id` and the `content` to rerank on. On any reranker failure (or
 * an empty/garbage result) the original order is returned unchanged — reranking
 * never breaks retrieval.
 *
 * Returns `{ order, applied }`: `order` is the reordered items, `applied` is true
 * only when the reranker actually contributed scores. Items the reranker didn't
 * score retain their relative first-stage order, after the scored ones.
 */
export async function applyReranker<T extends { id: string; content: string }>(
  query: string,
  items: T[],
  reranker: RerankerFn,
): Promise<{ order: T[]; applied: boolean; scores: Map<string, number> }> {
  if (items.length === 0) return { order: items, applied: false, scores: new Map() };
  // The reranker is user-supplied JS — treat its result as untrusted and
  // validate each entry, so a malformed return degrades gracefully.
  let raw: unknown;
  try {
    raw = await reranker(
      query,
      items.map((i) => ({ id: i.id, content: i.content })),
    );
  } catch {
    return { order: items, applied: false, scores: new Map() };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { order: items, applied: false, scores: new Map() };
  }
  const scoreById = new Map<string, number>();
  for (const s of raw) {
    if (isRerankScore(s)) scoreById.set(s.id, s.score);
  }
  if (scoreById.size === 0) return { order: items, applied: false, scores: new Map() };

  // Stable sort: scored items by descending reranker score; unscored items keep
  // their original relative order, placed after all scored ones.
  const indexed = items.map((item, idx) => ({ item, idx }));
  indexed.sort((a, b) => {
    const sa = scoreById.get(a.item.id);
    const sb = scoreById.get(b.item.id);
    if (sa === undefined && sb === undefined) return a.idx - b.idx;
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sb !== sa) return sb - sa;
    return a.idx - b.idx;
  });
  return { order: indexed.map((x) => x.item), applied: true, scores: scoreById };
}
