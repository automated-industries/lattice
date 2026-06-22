/**
 * Retrieval evaluation — measure the quality of any ranked-retrieval function
 * against a labeled query set, with the standard information-retrieval metrics:
 * Precision@k, Recall@k, Mean Reciprocal Rank (MRR), normalized Discounted
 * Cumulative Gain (nDCG@k), and Mean Average Precision (MAP).
 *
 * The evaluator is deliberately decoupled from any specific search
 * implementation: you hand it a {@link Retriever} — a function that maps a query
 * string to a best-first list of row ids — plus the ground-truth relevant ids
 * per query. That makes it usable to grade semantic search, full-text search, a
 * hybrid fusion, a graph-augmented retriever, or an external service, and to
 * regression-gate any of them in CI so an upgrade can't silently lower quality.
 *
 * All metric math is computed in-process from the ranked id lists; nothing here
 * touches the database, so it is dialect-agnostic and side-effect free.
 */

/**
 * A graded relevance label. `gain` is the graded usefulness of the row for the
 * query (used by nDCG); omit it for binary relevance (treated as gain 1).
 */
export interface RelevanceLabel {
  id: string;
  /** Graded relevance gain (default 1). Higher = more useful. */
  gain?: number;
}

/**
 * A single labeled evaluation query: the query text plus the ground-truth set
 * of ids that *should* be retrieved. Order of `relevant` is irrelevant — it is
 * a set; ranking quality is judged against the order the retriever returns.
 */
export interface EvalQuery {
  /** Stable identifier for per-query reporting. Defaults to the query text. */
  id?: string;
  /** Natural-language query text passed to the retriever. */
  query: string;
  /** Ground-truth relevant ids — bare ids (binary) or graded labels. */
  relevant: string[] | RelevanceLabel[];
}

/**
 * Maps a query to a ranked, best-first list of row ids. May be sync or async.
 * Returning more than `k` ids is fine — the evaluator applies the cutoff.
 */
export type Retriever = (query: string) => Promise<string[]> | string[];

export interface RetrievalEvalOptions {
  /** Primary cutoff for P@k / Recall@k / nDCG@k. Default 10. */
  k?: number;
  /**
   * Additional cutoffs to also report (e.g. `[1, 3, 5, 10]`). Each appears in
   * {@link RetrievalEvalSummary.byK}. The primary `k` is always reported.
   */
  ks?: number[];
}

/** Per-query metric breakdown. */
export interface PerQueryEval {
  id: string;
  query: string;
  /** Relevant ids found in the top-k, divided by k. */
  precisionAtK: number;
  /** Relevant ids found in the top-k, divided by total relevant. */
  recallAtK: number;
  /** 1 / (rank of the first relevant id), 0 if none were returned. */
  reciprocalRank: number;
  /** DCG@k / ideal-DCG@k, in [0, 1]. */
  ndcgAtK: number;
  /** Average precision over the full returned list (the AP that MAP averages). */
  averagePrecision: number;
  /** Number of ids the retriever returned. */
  retrieved: number;
  /** Number of ground-truth relevant ids. */
  relevantTotal: number;
}

/** Aggregate metrics across the whole query set, plus per-query detail. */
export interface RetrievalEvalSummary {
  /** The primary cutoff used for the top-level aggregate fields. */
  k: number;
  /** Number of queries evaluated. */
  queryCount: number;
  /** Mean Precision@k. */
  precisionAtK: number;
  /** Mean Recall@k. */
  recallAtK: number;
  /** Mean Reciprocal Rank. */
  mrr: number;
  /** Mean nDCG@k. */
  ndcgAtK: number;
  /** Mean Average Precision. */
  map: number;
  /** Per-cutoff means, present when `ks` is supplied (always includes `k`). */
  byK?: Record<number, { precisionAtK: number; recallAtK: number; ndcgAtK: number }>;
  /** Per-query metrics, in input order. */
  perQuery: PerQueryEval[];
}

/** Normalize the two accepted `relevant` shapes into an id→gain map. */
function relevanceMap(relevant: string[] | RelevanceLabel[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of relevant) {
    if (typeof r === 'string') {
      m.set(r, 1);
    } else {
      m.set(r.id, r.gain ?? 1);
    }
  }
  return m;
}

/** Precision@k: relevant ids among the first `k` returned, divided by `k`. */
function precisionAtK(ranked: string[], rel: Map<string, number>, k: number): number {
  if (k <= 0) return 0;
  let hits = 0;
  const top = ranked.slice(0, k);
  for (const id of top) if (rel.has(id)) hits++;
  return hits / k;
}

/** Recall@k: relevant ids among the first `k` returned, divided by total relevant. */
function recallAtK(ranked: string[], rel: Map<string, number>, k: number): number {
  if (rel.size === 0) return 0;
  let hits = 0;
  const top = ranked.slice(0, k);
  for (const id of top) if (rel.has(id)) hits++;
  return hits / rel.size;
}

/** Reciprocal rank: 1/(1-based rank of the first relevant id), else 0. */
function reciprocalRank(ranked: string[], rel: Map<string, number>): number {
  for (let i = 0; i < ranked.length; i++) {
    const id = ranked[i];
    if (id !== undefined && rel.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with graded gains and the standard `log2(rank+1)` discount.
 * The ideal DCG sorts all relevant gains descending and discounts the top `k`.
 */
function ndcgAtK(ranked: string[], rel: Map<string, number>, k: number): number {
  let dcg = 0;
  const top = ranked.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    const id = top[i];
    const gain = id !== undefined ? (rel.get(id) ?? 0) : 0;
    if (gain !== 0) dcg += gain / Math.log2(i + 2); // i is 0-based → rank i+1 → log2(i+2)
  }
  const idealGains = [...rel.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i++) {
    idcg += (idealGains[i] ?? 0) / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Average Precision: mean of Precision@r over every rank `r` that holds a
 * relevant id, normalized by the total number of relevant ids. This is the AP
 * that {@link RetrievalEvalSummary.map} averages across queries.
 */
function averagePrecision(ranked: string[], rel: Map<string, number>): number {
  if (rel.size === 0) return 0;
  let hits = 0;
  let sum = 0;
  for (let i = 0; i < ranked.length; i++) {
    const id = ranked[i];
    if (id !== undefined && rel.has(id)) {
      hits++;
      sum += hits / (i + 1);
    }
  }
  return sum / rel.size;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Evaluate a retriever against a labeled query set.
 *
 * @throws Error if `queries` is empty — an eval over no queries would silently
 *   report a meaningless "0 across the board", so it fails loudly instead.
 */
export async function evaluateRetrieval(
  queries: EvalQuery[],
  retriever: Retriever,
  opts: RetrievalEvalOptions = {},
): Promise<RetrievalEvalSummary> {
  if (queries.length === 0) {
    throw new Error('evaluateRetrieval: query set is empty — nothing to evaluate');
  }
  const k = opts.k ?? 10;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`evaluateRetrieval: k must be a positive integer, got ${String(k)}`);
  }
  const allKs = Array.from(new Set([k, ...(opts.ks ?? [])])).filter((x) => x > 0);

  const perQuery: PerQueryEval[] = [];
  // Accumulate per-cutoff sums for the byK report.
  const byKAccum = new Map<number, { p: number[]; r: number[]; n: number[] }>();
  for (const kk of allKs) byKAccum.set(kk, { p: [], r: [], n: [] });

  for (const q of queries) {
    const rel = relevanceMap(q.relevant);
    const ranked = await retriever(q.query);

    for (const kk of allKs) {
      const acc = byKAccum.get(kk);
      if (acc) {
        acc.p.push(precisionAtK(ranked, rel, kk));
        acc.r.push(recallAtK(ranked, rel, kk));
        acc.n.push(ndcgAtK(ranked, rel, kk));
      }
    }

    perQuery.push({
      id: q.id ?? q.query,
      query: q.query,
      precisionAtK: precisionAtK(ranked, rel, k),
      recallAtK: recallAtK(ranked, rel, k),
      reciprocalRank: reciprocalRank(ranked, rel),
      ndcgAtK: ndcgAtK(ranked, rel, k),
      averagePrecision: averagePrecision(ranked, rel),
      retrieved: ranked.length,
      relevantTotal: rel.size,
    });
  }

  const byK: Record<number, { precisionAtK: number; recallAtK: number; ndcgAtK: number }> = {};
  for (const [kk, acc] of byKAccum) {
    byK[kk] = {
      precisionAtK: mean(acc.p),
      recallAtK: mean(acc.r),
      ndcgAtK: mean(acc.n),
    };
  }

  const summary: RetrievalEvalSummary = {
    k,
    queryCount: queries.length,
    precisionAtK: mean(perQuery.map((p) => p.precisionAtK)),
    recallAtK: mean(perQuery.map((p) => p.recallAtK)),
    mrr: mean(perQuery.map((p) => p.reciprocalRank)),
    ndcgAtK: mean(perQuery.map((p) => p.ndcgAtK)),
    map: mean(perQuery.map((p) => p.averagePrecision)),
    perQuery,
  };
  if (opts.ks && opts.ks.length > 0) summary.byK = byK;
  return summary;
}

/**
 * Compare a candidate summary against a baseline and report regressions beyond
 * a tolerance. Designed to drive a CI gate: a retrieval change that lowers any
 * headline metric by more than `tolerance` fails the build.
 */
export interface EvalRegression {
  metric: 'precisionAtK' | 'recallAtK' | 'mrr' | 'ndcgAtK' | 'map';
  baseline: number;
  candidate: number;
  delta: number;
}

export function detectRetrievalRegressions(
  baseline: RetrievalEvalSummary,
  candidate: RetrievalEvalSummary,
  tolerance = 0,
): EvalRegression[] {
  const metrics: EvalRegression['metric'][] = [
    'precisionAtK',
    'recallAtK',
    'mrr',
    'ndcgAtK',
    'map',
  ];
  const out: EvalRegression[] = [];
  for (const m of metrics) {
    const delta = candidate[m] - baseline[m];
    if (delta < -tolerance) {
      out.push({ metric: m, baseline: baseline[m], candidate: candidate[m], delta });
    }
  }
  return out;
}
