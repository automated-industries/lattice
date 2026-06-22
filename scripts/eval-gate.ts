/**
 * Retrieval-quality regression GATE (CI step).
 *
 *   npm run eval:gate
 *
 * Evaluates the CURRENT `search()` over the golden corpus and compares it to the
 * committed baseline (tests/fixtures/eval-baseline.json). Exits NON-ZERO if any
 * headline metric drops more than TOLERANCE below the baseline — so a change
 * that silently lowers retrieval quality fails the build. Exits 0 when quality
 * holds (an improvement is fine; only regressions fail).
 *
 * This is the engine reused, not reinvented: it calls `detectRetrievalRegressions`
 * over the same `evaluateRetrieval` summary the test and the baseline generator use.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRetrievalRegressions } from '../src/search/eval.js';
import type { RetrievalEvalSummary } from '../src/search/eval.js';
import { runEval, TOLERANCE, type EvalBaseline } from './eval-corpus.js';

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'eval-baseline.json',
);

function loadBaseline(): EvalBaseline {
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  return JSON.parse(raw) as EvalBaseline;
}

async function main(): Promise<void> {
  const baseline = loadBaseline();
  const summary = await runEval();

  // detectRetrievalRegressions reads the headline-metric fields; the committed
  // baseline carries exactly those, so widen it to the summary shape it expects.
  const baselineSummary = { ...baseline, byK: undefined, perQuery: [] } as RetrievalEvalSummary;
  const regressions = detectRetrievalRegressions(baselineSummary, summary, TOLERANCE);

  console.log('Retrieval-quality gate:');
  console.log(
    `  baseline : mrr=${baseline.mrr.toFixed(4)} ndcg@${String(baseline.k)}=${baseline.ndcgAtK.toFixed(4)} ` +
      `map=${baseline.map.toFixed(4)} precision@${String(baseline.k)}=${baseline.precisionAtK.toFixed(4)} ` +
      `recall@${String(baseline.k)}=${baseline.recallAtK.toFixed(4)}`,
  );
  console.log(
    `  current  : mrr=${summary.mrr.toFixed(4)} ndcg@${String(summary.k)}=${summary.ndcgAtK.toFixed(4)} ` +
      `map=${summary.map.toFixed(4)} precision@${String(summary.k)}=${summary.precisionAtK.toFixed(4)} ` +
      `recall@${String(summary.k)}=${summary.recallAtK.toFixed(4)}`,
  );
  console.log(`  tolerance: ${String(TOLERANCE)}`);

  if (regressions.length > 0) {
    console.error('\nFAIL — retrieval quality regressed past tolerance:');
    for (const r of regressions) {
      console.error(
        `  ${r.metric}: baseline ${r.baseline.toFixed(4)} → current ${r.candidate.toFixed(4)} ` +
          `(Δ ${r.delta.toFixed(4)})`,
      );
    }
    console.error(
      '\nIf this is an intentional quality change, regenerate the baseline with ' +
        '`npm run eval:baseline -- --write` in the same PR so the diff is reviewable.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nPASS — no metric regressed past tolerance.');
}

await main();
