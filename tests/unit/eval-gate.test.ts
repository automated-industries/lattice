import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRetrievalRegressions } from '../../src/search/eval.js';
import type { RetrievalEvalSummary } from '../../src/search/eval.js';
import { runEval, TOLERANCE, type EvalBaseline } from '../../scripts/eval-corpus.js';

/**
 * The retrieval-quality regression GATE.
 *
 * `evaluateRetrieval` + `detectRetrievalRegressions` are only a gate if something
 * runs them against a committed baseline and fails on a drop. This test is that
 * gate inside the normal suite: it evaluates the REAL `search()` over the golden
 * corpus (scripts/eval-corpus.ts — the SAME corpus the `eval:baseline` /
 * `eval:gate` scripts use) and compares to the committed baseline fixture.
 *
 * The corpus has deliberate CROSS-TOPIC LEXICAL OVERLAP, so the real search
 * scores good-but-imperfect — the committed baseline is sub-perfect (mrr < 1).
 * That headroom is what makes the gate able to FAIL: a baseline pinned at the
 * 1.0 ceiling can only catch a catastrophic break. The `baseline.mrr < 1`
 * assertion below guards the headroom itself — if a future corpus change pushed
 * the baseline back to 1.0, this test fails and tells you the gate went blind.
 *
 * To move the baseline intentionally (a real, justified quality change), run
 * `npm run eval:baseline -- --write` in the same PR — the fixture diff makes the
 * change reviewable.
 */

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'eval-baseline.json',
);

function loadBaseline(): EvalBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EvalBaseline;
}

describe('retrieval-quality regression gate', () => {
  it('the committed baseline has headroom (sub-perfect — so a regression is detectable)', () => {
    const baseline = loadBaseline();
    // A baseline at the perfect ceiling cannot detect a regression. These prove
    // the golden corpus scores below 1, so the gate has something to catch.
    expect(baseline.mrr).toBeLessThan(1);
    expect(baseline.ndcgAtK).toBeLessThan(1);
    expect(baseline.map).toBeLessThan(1);
  });

  it('the real search() meets the committed quality baseline (no regression)', async () => {
    const baseline = loadBaseline();
    const summary = await runEval();

    const baselineSummary = {
      ...baseline,
      byK: undefined,
      perQuery: [],
    } as RetrievalEvalSummary;

    const regressions = detectRetrievalRegressions(baselineSummary, summary, TOLERANCE);
    expect(
      regressions,
      `retrieval quality regressed vs committed baseline: ${JSON.stringify(regressions)}`,
    ).toEqual([]);

    // Sanity floor (independent of the baseline diff): search is actually good,
    // and the corpus is genuinely imperfect (not a green-by-construction ceiling).
    expect(summary.mrr).toBeGreaterThanOrEqual(0.85);
    expect(summary.mrr).toBeLessThan(1);
    expect(summary.queryCount).toBe(20);
  });
});
