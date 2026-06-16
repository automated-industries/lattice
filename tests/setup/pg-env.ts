import { inject } from 'vitest';

/**
 * Per-worker setup: make the disposable Postgres URL that the global setup
 * provisioned visible to the gated `*-postgres.test.ts` modules, which read
 * `process.env.LATTICE_TEST_PG_URL` at import time.
 *
 * Forked workers (vitest's default pool) already inherit the env var the global
 * setup exported; this backfills it from the provided value for any pool (e.g.
 * threads) where the env var didn't cross the worker boundary — and runs BEFORE
 * the test modules evaluate, so their `skipIf(!PG_URL)` gate sees the URL.
 */
const provided = inject('latticePgUrl');
if (provided && !process.env.LATTICE_TEST_PG_URL) {
  process.env.LATTICE_TEST_PG_URL = provided;
}
