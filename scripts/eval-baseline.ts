/**
 * Generate (and optionally commit) the retrieval-quality baseline.
 *
 *   npm run eval:baseline          # run the eval, print the metrics
 *   npm run eval:baseline -- --write  # also overwrite the committed fixture
 *
 * The numbers are produced by running the REAL `search()` over the golden corpus
 * (see eval-corpus.ts) — never hand-authored. The committed baseline is the
 * reference the gate (eval:gate) compares against; regenerate it deliberately
 * (with `--write`) only when you intend to move the quality bar, so the diff is
 * reviewable.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runEval, toBaseline } from './eval-corpus.js';

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'eval-baseline.json',
);

async function main(): Promise<void> {
  const summary = await runEval();
  const baseline = toBaseline(summary);

  console.log('Retrieval-quality baseline (generated from the real search()):');
  console.log(JSON.stringify(baseline, null, 2));
  console.log(
    `\nmrr=${baseline.mrr.toFixed(4)}  ndcg@${String(baseline.k)}=${baseline.ndcgAtK.toFixed(4)}  ` +
      `map=${baseline.map.toFixed(4)}  precision@${String(baseline.k)}=${baseline.precisionAtK.toFixed(4)}  ` +
      `recall@${String(baseline.k)}=${baseline.recallAtK.toFixed(4)}`,
  );

  if (baseline.mrr >= 1) {
    console.error(
      '\nERROR: baseline MRR is at the perfect ceiling (1.0). A baseline with no ' +
        'headroom cannot detect a retrieval regression. Expand/strengthen the golden ' +
        'corpus so the real search scores below 1.',
    );
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\nWrote committed baseline → ${BASELINE_PATH}`);
  } else {
    console.log('\n(dry run — pass `--write` to overwrite the committed baseline)');
  }
}

await main();
