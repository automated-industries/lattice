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
 * Isolate the workspace-registry ROOT the same way. A lattice install exports
 * LATTICE_ROOT pointing at the real ~/.lattice, and findLatticeRoot() treats it
 * as an override that ALWAYS wins — ignoring the path it's asked about. So a test
 * that builds an isolated temp workspace tree and then hits a server path which
 * re-derives the root (migrate-to-cloud → updateActiveWorkspaceToCloud →
 * findLatticeRoot(configPath)) would resolve to the real ~/.lattice and register
 * its throwaway cloud workspaces (lattice_mig_*, duplicated names) into the
 * developer's live registry.json — which then shows up as junk in the GUI
 * switcher. Deleting (not repointing) the inherited value makes root resolution
 * walk UP from the actual temp configPath to that tree's own .lattice, which is
 * correct even when a test uses several temp roots at once (owner + member).
 * Tests that need a specific root still set LATTICE_ROOT in their own hooks.
 */
delete process.env.LATTICE_ROOT;

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

/**
 * Per-fork database isolation.
 *
 * The `*-postgres.test.ts` files historically all shared ONE database
 * (`lattice_test`). The cloud suites isolate themselves into per-test schemas,
 * but the non-cloud suites open it directly (`new Lattice(PG_URL)` /
 * `startGuiServer({ db: PG_URL })`) and mutate shared, NON-row-scoped state — the
 * schema/entity config, the changelog/audit log, the embeddings table. Vitest
 * runs test FILES across parallel forks, so two files opening independent
 * "workspaces" on that one database race each other: a GUI server's schema
 * rewrite clobbers another's config (an undo/redo then 400s), and a vector search
 * loses rows another file's writes/index touched. The victim VARIES by which
 * files happen to overlap — the classic shared-state-race signature, not flake.
 *
 * Fix: give each fork its OWN database. Files within a single fork execute
 * SERIALLY, so sharing one db across a fork's files is safe; distinct forks get
 * distinct dbs, so nothing runs concurrently against the same database. We
 * recreate the fork db once per fork (the first setup call) for a clean slate,
 * and pin pgcrypto/pgvector into it (extensions are per-database). On any failure
 * we stay LOUD and fall back to the shared db rather than break the whole suite.
 */
const baseFromEnv = process.env.LATTICE_TEST_PG_URL;
if (baseFromEnv && !process.env.LATTICE_TEST_PG_BASE_URL) {
  process.env.LATTICE_TEST_PG_BASE_URL = baseFromEnv; // remember the real cluster url
}
const clusterUrl = process.env.LATTICE_TEST_PG_BASE_URL;
if (clusterUrl) {
  const forkId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0';
  const forkDb = `lattice_test_fork_${forkId}`;
  const forkUrl = (() => {
    const u = new URL(clusterUrl);
    u.pathname = `/${forkDb}`;
    return u.toString();
  })();
  if (!process.env.__LATTICE_FORK_DB_READY) {
    try {
      const pgmod = (await import('pg')).default;
      const admin = new pgmod.Client(clusterUrl);
      await admin.connect();
      try {
        // Drop a leftover from a prior run (terminate stragglers first), then
        // recreate fresh. No-op on the first run against a clean cluster.
        await admin
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [forkDb],
          )
          .catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS "${forkDb}"`);
        await admin.query(`CREATE DATABASE "${forkDb}"`);
      } finally {
        await admin.end();
      }
      // Extensions are per-database — pin them into the fresh fork db's public
      // schema (mirrors the global setup's pin on the base db).
      const ext = new pgmod.Client(forkUrl);
      await ext.connect();
      try {
        await ext.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await ext.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => undefined);
      } finally {
        await ext.end();
      }
      process.env.__LATTICE_FORK_DB_READY = '1';
      process.env.LATTICE_TEST_PG_URL = forkUrl;
    } catch (e) {
      console.warn(
        `[test] per-fork PG isolation failed (${(e as Error).message}); ` +
          `falling back to the shared database — parallel PG tests may contend.`,
      );
    }
  } else {
    process.env.LATTICE_TEST_PG_URL = forkUrl;
  }
}
