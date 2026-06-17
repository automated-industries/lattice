import { inject } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Isolate each worker's machine-local config dir (credential store + master key)
 * to a throwaway temp dir. Integration tests that boot a GUI heal a raw `db:`
 * URL into the encrypted credential store on open; without isolation those writes
 * would land in the developer's real `~/.lattice` (and collide across parallel
 * workers). Tests that need a specific dir still set their own in `beforeEach`.
 */
if (!process.env.LATTICE_CONFIG_DIR) {
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-test-cfg-'));
}

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
