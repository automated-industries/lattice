/**
 * Shared golden corpus + harness for the retrieval-quality regression gate.
 *
 * This is the SINGLE SOURCE OF TRUTH used by three callers:
 *   - `scripts/eval-baseline.ts` — runs the eval and (with `--write`) regenerates
 *     the committed baseline fixture from the REAL `search()`.
 *   - `scripts/eval-gate.ts`     — the CI gate: evaluates the current `search()`
 *     and fails if any metric drops past tolerance below the committed baseline.
 *   - `tests/unit/eval-gate.test.ts` — runs the same eval in the normal suite.
 *
 * The corpus is deliberately ~20 docs with CROSS-TOPIC LEXICAL OVERLAP: many
 * terms recur across topics (a "budget" lives in finance AND project planning; a
 * "team" in people AND engineering; "review" in legal AND engineering, etc.).
 * With the deterministic token-hash embedder below, those shared tokens give
 * distractor docs a real, non-zero similarity to each query — so the relevant
 * doc does NOT always rank first, and the aggregate metrics land STRICTLY below
 * a perfect 1.0. That headroom is the whole point: a baseline pinned at 1.0
 * can only catch a catastrophic break, whereas a sub-perfect baseline lets the
 * gate detect a smaller regression too.
 *
 * The embedder is intentionally weak (a bag-of-token-hashes onto a small `dim`),
 * NOT contrived to look bad — it is the same shape of deterministic embedder the
 * other retrieval tests use. The imperfection comes from genuine lexical overlap
 * in natural-reading text, not from rigging the numbers.
 */

import { Lattice } from '../src/lattice.js';
import { evaluateRetrieval } from '../src/search/eval.js';
import type { EvalQuery, RetrievalEvalSummary } from '../src/search/eval.js';

/** Deterministic token-hash embedder — identical text always yields identical vectors. */
export function tokenEmbed(dim = 64) {
  return (text: string): Promise<number[]> => {
    const v = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) % dim;
      v[h] = (v[h] ?? 0) + 1;
    }
    return Promise.resolve(v);
  };
}

/**
 * ~20 short documents across six topics, with heavy shared vocabulary across
 * topics (budget / plan / review / team / report / quarterly / update / risk /
 * schedule / cost recur everywhere). Each query below targets exactly one doc,
 * but its terms appear in several — so retrieval is good but imperfect.
 */
export const CORPUS: Record<string, string> = {
  // finance — the three finance docs share budget/revenue/cost/quarter/report
  d1: 'finance budget revenue accounting fiscal quarter report review forecast',
  d2: 'quarterly budget forecast revenue cost projection finance update report',
  d3: 'expense report cost reconciliation budget review accounting forecast team',
  // logistics — share shipping/warehouse/inventory/freight/schedule
  d4: 'logistics shipping warehouse inventory freight cargo schedule cost route',
  d5: 'inventory restocking warehouse shipping schedule report freight update route',
  d6: 'freight carrier cost shipping route schedule logistics warehouse risk review',
  // engineering — share code/deployment/release/architecture/pipeline/review
  d7: 'engineering software code deployment architecture release review team pipeline',
  d8: 'software release schedule deployment pipeline engineering update report code',
  d9: 'code review architecture refactor engineering team risk deployment pipeline',
  // marketing — share brand/campaign/audience/advertising/outreach
  d10: 'marketing campaign brand audience advertising outreach budget report launch',
  d11: 'brand campaign launch advertising audience schedule marketing update outreach',
  d12: 'audience growth campaign report marketing review outreach budget advertising',
  // legal — share contract/compliance/regulation/policy/review
  d13: 'legal contract compliance regulation policy clause review risk audit',
  d14: 'contract negotiation compliance policy review legal schedule update clause',
  d15: 'regulation compliance audit policy legal report risk review contract',
  // people — share hiring/recruiting/onboarding/team/culture
  d16: 'people hiring recruiting onboarding culture team review report performance',
  d17: 'hiring pipeline recruiting onboarding team schedule people update culture',
  d18: 'culture team performance review people onboarding report risk hiring',
  // two cross-cutting planning docs that reuse every topic's vocabulary
  d19: 'quarterly planning budget schedule risk review report team update forecast',
  d20: 'project plan milestone schedule cost risk review report deployment pipeline',
};

/**
 * Each query targets one specific doc. The relevant doc is the best lexical
 * match, but the shared vocabulary means distractors score close behind (and
 * sometimes ahead at this embedder's resolution), so MRR/nDCG land below 1.
 */
export const GOLDEN: EvalQuery[] = [
  { id: 'q1', query: 'revenue accounting fiscal quarter', relevant: ['d1'] },
  { id: 'q2', query: 'quarterly forecast revenue projection', relevant: ['d2'] },
  { id: 'q3', query: 'expense reconciliation report', relevant: ['d3'] },
  { id: 'q4', query: 'warehouse inventory freight cargo', relevant: ['d4'] },
  { id: 'q5', query: 'restocking inventory warehouse', relevant: ['d5'] },
  { id: 'q6', query: 'freight carrier route', relevant: ['d6'] },
  { id: 'q7', query: 'software code deployment architecture', relevant: ['d7'] },
  { id: 'q8', query: 'release pipeline deployment', relevant: ['d8'] },
  { id: 'q9', query: 'code refactor architecture', relevant: ['d9'] },
  { id: 'q10', query: 'brand audience advertising outreach', relevant: ['d10'] },
  { id: 'q11', query: 'brand launch advertising', relevant: ['d11'] },
  { id: 'q12', query: 'audience growth outreach', relevant: ['d12'] },
  { id: 'q13', query: 'contract regulation clause', relevant: ['d13'] },
  { id: 'q14', query: 'contract negotiation policy', relevant: ['d14'] },
  { id: 'q15', query: 'regulation audit compliance', relevant: ['d15'] },
  { id: 'q16', query: 'hiring recruiting onboarding culture', relevant: ['d16'] },
  { id: 'q17', query: 'recruiting pipeline onboarding', relevant: ['d17'] },
  { id: 'q18', query: 'culture performance people', relevant: ['d18'] },
  { id: 'q19', query: 'quarterly planning milestone', relevant: ['d19'] },
  { id: 'q20', query: 'project plan milestone deployment', relevant: ['d20'] },
];

/** The metric cutoff the gate (and committed baseline) are computed at. */
export const EVAL_K = 3;
export const EVAL_KS = [1, 3];

/**
 * Max allowed drop (per metric) below the committed baseline before the gate
 * fails. The committed baseline is deterministic (fixed corpus + embedder), so
 * the tolerance only needs to absorb nothing — a strict 0 would also work — but
 * a small slack avoids a spurious failure from any future floating-point
 * reassociation in the metric math.
 */
export const TOLERANCE = 0.02;

/**
 * Build a fresh in-memory Lattice over the golden corpus and evaluate the REAL
 * `search()` against the golden query set. No fixtures, no hand-authored
 * numbers — every metric here is produced by the production retrieval path.
 */
export async function runEval(): Promise<RetrievalEvalSummary> {
  const db = new Lattice(':memory:');
  db.define('docs', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    embeddings: { fields: ['body'], embed: tokenEmbed(64) },
    render: () => '',
    outputFile: 'd.md',
  });
  await db.init();
  try {
    for (const [id, body] of Object.entries(CORPUS)) await db.insert('docs', { id, body });

    const retriever = async (query: string): Promise<string[]> => {
      const hits = await db.search('docs', query, { topK: Object.keys(CORPUS).length });
      return hits.map((h) => String(h.row.id));
    };

    return await evaluateRetrieval(GOLDEN, retriever, { k: EVAL_K, ks: EVAL_KS });
  } finally {
    db.close();
  }
}

/** The headline metrics the gate compares (a stable, serializable subset). */
export interface EvalBaseline {
  k: number;
  queryCount: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  map: number;
}

/** Project a full summary down to the committed-baseline shape. */
export function toBaseline(summary: RetrievalEvalSummary): EvalBaseline {
  return {
    k: summary.k,
    queryCount: summary.queryCount,
    precisionAtK: summary.precisionAtK,
    recallAtK: summary.recallAtK,
    mrr: summary.mrr,
    ndcgAtK: summary.ndcgAtK,
    map: summary.map,
  };
}
