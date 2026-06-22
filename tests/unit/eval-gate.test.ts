import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { evaluateRetrieval, detectRetrievalRegressions } from '../../src/search/eval.js';
import type { RetrievalEvalSummary } from '../../src/search/eval.js';

/**
 * The retrieval-quality regression GATE.
 *
 * `evaluateRetrieval` + `detectRetrievalRegressions` are only a gate if something
 * actually runs them against a committed baseline and fails the build on a drop.
 * This test is that gate: it evaluates the REAL `search()` over a fixed golden set
 * with a deterministic embedder, and fails if any metric regresses past tolerance
 * below the committed baseline — so a change that silently lowers retrieval
 * quality cannot land green. It runs in the normal suite, so CI enforces it.
 *
 * To intentionally move the baseline (a real, justified quality change), update
 * BASELINE below in the same PR — the diff makes the change reviewable.
 */

/** Deterministic token-hash embedder — identical text always yields identical vectors. */
function tokenEmbed(dim = 64) {
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

const CORPUS: Record<string, string> = {
  d1: 'finance budget revenue accounting fiscal quarter',
  d2: 'logistics shipping warehouse inventory freight cargo',
  d3: 'engineering software code deployment architecture release',
  d4: 'marketing campaign brand audience advertising outreach',
  d5: 'legal contract compliance regulation policy clause',
  d6: 'people hiring recruiting onboarding culture team',
};

const GOLDEN = [
  { id: 'q1', query: 'revenue accounting fiscal', relevant: ['d1'] },
  { id: 'q2', query: 'shipping freight inventory', relevant: ['d2'] },
  { id: 'q3', query: 'software deployment release', relevant: ['d3'] },
  { id: 'q4', query: 'brand advertising campaign', relevant: ['d4'] },
  { id: 'q5', query: 'contract compliance policy', relevant: ['d5'] },
  { id: 'q6', query: 'hiring onboarding team', relevant: ['d6'] },
];

/**
 * Committed baseline — the quality the current `search()` achieves on the golden
 * set (every query's relevant doc ranks first → perfect on this set). The gate
 * fails if a future change drops any metric more than TOLERANCE below these.
 */
const BASELINE: RetrievalEvalSummary = {
  k: 3,
  queryCount: 6,
  precisionAtK: 1 / 3, // 1 relevant in top-3 → 1/3 per query
  recallAtK: 1, // the 1 relevant doc is always retrieved
  mrr: 1, // relevant doc is rank 1
  ndcgAtK: 1,
  map: 1,
  perQuery: [],
};
const TOLERANCE = 0.05;

describe('retrieval-quality regression gate', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('the real search() meets the committed quality baseline (no regression)', async () => {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      embeddings: { fields: ['body'], embed: tokenEmbed(64) },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    for (const [id, body] of Object.entries(CORPUS)) await db.insert('docs', { id, body });

    const retriever = async (query: string): Promise<string[]> => {
      const hits = await db!.search('docs', query, { topK: 6 });
      return hits.map((h) => String(h.row.id));
    };

    const summary = await evaluateRetrieval(GOLDEN, retriever, { k: 3, ks: [1, 3] });

    // The gate: no metric may regress past tolerance below the committed baseline.
    const regressions = detectRetrievalRegressions(BASELINE, summary, TOLERANCE);
    expect(
      regressions,
      `retrieval quality regressed vs baseline: ${JSON.stringify(regressions)}`,
    ).toEqual([]);

    // Sanity floor (independent of the baseline diff): the search is actually good.
    expect(summary.mrr).toBeGreaterThanOrEqual(0.9);
    expect(summary.ndcgAtK).toBeGreaterThanOrEqual(0.9);
  });
});
