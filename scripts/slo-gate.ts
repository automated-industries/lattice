/**
 * ADVISORY latency SLO gate.
 *
 *   npm run slo:gate
 *
 * Runs the REAL benchmark harness at the committed scale and checks the observed
 * p95 latencies against committed thresholds (tests/fixtures/slo-thresholds.json).
 *
 * This is ADVISORY, never build-blocking: shared CI runners are too latency-noisy
 * to gate a merge on, so the CI job runs it with `continue-on-error: true`. The
 * thresholds are generous headroom over real, locally-measured numbers (see the
 * fixture's `_comment`) — tuned to surface a GROSS regression, not normal jitter.
 *
 * Honesty: every number printed is MEASURED by running the benchmark now; nothing
 * is fabricated. The benchmark report's `vectorIndexed` flag is printed so the
 * reader knows whether `vector.p95` reflects a native index or the in-process
 * scan — on a runner with no vector extension it is the scan, and we say so
 * rather than presenting the scan as an indexed number.
 *
 * Exit code: non-zero if any threshold is exceeded (so a human running it locally
 * sees the failure), 0 otherwise. In CI the `continue-on-error` wrapper means a
 * non-zero exit is reported but does not fail the build.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Lattice } from '../src/lattice.js';
import { benchmarkRetrieval, checkSlos } from '../src/search/benchmark.js';
import type { BenchmarkScale, RetrievalSlo } from '../src/search/benchmark.js';

interface SloFixture {
  scale: BenchmarkScale;
  slos: RetrievalSlo[];
}

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'slo-thresholds.json',
);

function loadFixture(): SloFixture {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SloFixture;
  return { scale: raw.scale, slos: raw.slos };
}

async function main(): Promise<void> {
  const { scale, slos } = loadFixture();

  // Measure against a real backend. Use the provisioned Postgres when present
  // (so a CI/Postgres run measures the Postgres path); otherwise an in-memory
  // SQLite, which is always measurable on any runner.
  const pgUrl = process.env.LATTICE_TEST_PG_URL;
  const db = new Lattice(pgUrl ?? ':memory:');
  await db.init();

  let report;
  try {
    report = await benchmarkRetrieval(db.adapter, { scale });
  } finally {
    db.close();
  }

  console.log(
    `SLO gate (ADVISORY) — dialect=${report.dialect}, vectorIndexed=${String(report.vectorIndexed)}`,
  );
  console.log(
    `  scale: rows=${String(report.scale.rows)} queries=${String(report.scale.queries)} dim=${String(report.scale.dim)}`,
  );
  console.log('  observed p95 (ms):');
  console.log(`    query.p95     = ${report.query.p95.toFixed(3)}`);
  console.log(`    fts.p95       = ${report.fts.p95.toFixed(3)}`);
  console.log(
    `    vector.p95    = ${report.vector.p95.toFixed(3)}` +
      (report.vectorIndexed
        ? ' (native index)'
        : ' (in-process scan — no native vector extension)'),
  );
  console.log(`    aggregate.p95 = ${report.aggregate.p95.toFixed(3)}`);

  const violations = checkSlos(report, slos);
  if (violations.length > 0) {
    console.error('\nADVISORY SLO violations (NOT build-blocking):');
    for (const v of violations) {
      console.error(
        `  ${v.metric}: observed ${v.observedMs.toFixed(3)}ms > threshold ${String(v.maxMs)}ms`,
      );
    }
    console.error(
      '\nThis is advisory. If it is real (not runner noise), investigate the latency ' +
        'regression. To retune for this hardware, widen the thresholds in ' +
        'tests/fixtures/slo-thresholds.json and note the measured numbers.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nPASS — all observed p95 latencies are within the advisory thresholds.');
}

await main();
