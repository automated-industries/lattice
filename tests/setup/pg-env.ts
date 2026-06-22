import { inject } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { EventEmitter } from 'node:events';

/**
 * Guard every raw `pg.Pool` / `pg.Client` a test opens against the shared
 * embedded Postgres. The integration suite opens ~130 throwaway connections
 * (member roles, an admin, second-connection RLS checks). A teardown's
 * `pg_terminate_backend(... WHERE datname = <db>)`, or the embedded-PG shutdown,
 * drops those connections, and pg then emits an `'error'` EVENT on the dropped
 * Pool / Client. An EventEmitter that emits `'error'` with NO listener makes Node
 * raise an UNCAUGHT EXCEPTION — which vitest counts as a run failure EVEN WHEN
 * EVERY TEST PASSED. Because forked workers run many files each, the uncaught
 * fires against whichever unguarded connection is live when some test terminates a
 * backend, so the victim test varies run to run (the "intermittent" PG failure).
 *
 * The product guards its OWN connections (PostgresAdapter's `pool.on('error')`,
 * the realtime broker's client error handler); this only covers the raw
 * connections tests open directly. It attaches a default `'error'` listener so a
 * benign teardown termination is LOGGED, never uncaught — it does not swallow real
 * query errors, which still reject the awaited `query()` call. Test-only (this
 * setup file never runs in production).
 */
const logHandled = (kind: string, err: Error): void => {
  // Benign: a test connection terminated out-of-band. Surfaced, not swallowed.
  console.warn(`[test] pg ${kind} connection error (handled):`, err.message);
};
type PgCtor = new (...args: never[]) => EventEmitter;
const mutablePg = pg as unknown as { Pool: PgCtor; Client: PgCtor };
const BaseClient = mutablePg.Client;
const BasePool = mutablePg.Pool;

// Standalone `new pg.Client()` self-guards.
class GuardedClient extends BaseClient {
  constructor(...args: never[]) {
    super(...args);
    this.on('error', (e: Error) => {
      logHandled('client', e);
    });
  }
}
// `new pg.Pool()` self-guards AND forces its INTERNAL clients to be guarded too —
// pg.Pool creates connections via `options.Client` (default: its own pg.Client,
// which our `pg.Client` reassignment does NOT reach), and only re-emits a client's
// error while it is IDLE in the pool, not during connect / end. Injecting
// GuardedClient means every internal connection has its own 'error' listener, so a
// teardown termination mid-connect/mid-end can't escape as an uncaught exception.
class GuardedPool extends BasePool {
  constructor(...args: never[]) {
    const cfg = (args[0] ?? {}) as { Client?: unknown };
    super({ ...cfg, Client: cfg.Client ?? GuardedClient } as never);
    this.on('error', (e: Error) => {
      logHandled('pool', e);
    });
  }
}
mutablePg.Client = GuardedClient as unknown as PgCtor;
mutablePg.Pool = GuardedPool as unknown as PgCtor;

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
