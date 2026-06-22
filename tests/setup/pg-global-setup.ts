import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * Vitest global setup for the Postgres integration suite.
 *
 * The `*-postgres.test.ts` files gate on `LATTICE_TEST_PG_URL` and otherwise
 * skip — they need a real Postgres cluster (each test creates its own database
 * and mints scoped roles, which SQLite / in-memory shims can't do). This setup
 * removes the "silently skipped locally" gap WITHOUT making every contributor
 * stand up Postgres by hand:
 *
 *   1. If `LATTICE_TEST_PG_URL` is already set, use it untouched — this is how
 *      CI runs (a real `postgres:16` service) and how a dev points at their own
 *      cluster. We never provision a second one.
 *   2. If we're in CI with no URL (e.g. the Windows smoke job, which intentionally
 *      runs only the non-Postgres tests), leave the suite skipped — CI decides
 *      where Postgres runs; we don't boot one implicitly.
 *   3. Otherwise (a local run with no Postgres) stand up a DISPOSABLE embedded
 *      Postgres in a temp dir, run the suite against it, and tear it down +
 *      delete the data dir when the run finishes.
 *
 * Speed: the throwaway cluster runs with crash-safety off (`fsync`,
 * `synchronous_commit`, `full_page_writes`) — irrelevant for ephemeral test data
 * and a large win for the create/drop-database-per-test workload — and a high
 * `max_connections` so parallel workers don't exhaust it. The Postgres binary
 * itself is the prebuilt one `embedded-postgres` caches under `node_modules`, so
 * only a fast `initdb` runs per invocation.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Create the shared extensions in a STABLE schema (public) once, before any test
 * connects. `CREATE EXTENSION IF NOT EXISTS` installs into the connection's
 * current schema, so without this the first test to run it — possibly a cloud
 * test whose search_path points at a fresh schema it later drops CASCADE — would
 * plant pgcrypto there and then yank `digest`/`hmac` out from under every other
 * connection. Pre-creating in public makes every later `IF NOT EXISTS` a no-op.
 */
async function ensureExtensions(url: string): Promise<void> {
  let pg: typeof import('pg').default;
  try {
    pg = (await import('pg')).default;
  } catch {
    return; // pg unavailable — the Postgres suite will skip anyway
  }
  const client = new pg.Client(url);
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    // pgvector only when the server ships it (the CI pgvector image); ignored otherwise.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => undefined);
  } finally {
    await client.end();
  }
}

export default async function setup({
  provide,
}: GlobalSetupContext): Promise<(() => Promise<void>) | undefined> {
  if (process.env.LATTICE_TEST_PG_URL) {
    // (1) an explicit cluster wins — but still pin the shared extensions to public.
    await ensureExtensions(process.env.LATTICE_TEST_PG_URL);
    return;
  }
  if (process.env.CI) return; // (2) CI without a URL → leave the suite skipped

  // (3) Local run with no Postgres — provision a disposable one.
  let EmbeddedPostgres: typeof import('embedded-postgres').default;
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default;
  } catch {
    console.warn(
      '\n[lattice tests] "embedded-postgres" is not installed — the Postgres integration ' +
        'suite will be SKIPPED. Run `npm install` (or set LATTICE_TEST_PG_URL) to include it.\n',
    );
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'lattice-test-pg-'));
  const port = await freePort();
  const errLog: string[] = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    postgresFlags: [
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'max_connections=300',
    ],
    onLog: () => undefined, // suppress routine server LOG/checkpoint chatter
    onError: (m) => errLog.push(String(m)),
  });

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('lattice_test');
  } catch (e) {
    // Boot failure must be LOUD — never let the suite quietly fall back to "all
    // Postgres tests skipped" when provisioning was supposed to happen.
    console.error(
      '[lattice tests] failed to boot the disposable Postgres:\n' + errLog.slice(-25).join('\n'),
    );
    rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }

  const url = `postgres://postgres:postgres@127.0.0.1:${String(port)}/lattice_test`;
  await ensureExtensions(url); // pin pgcrypto (+ pgvector if present) to public first
  process.env.LATTICE_TEST_PG_URL = url; // forked workers inherit this at spawn
  provide('latticePgUrl', url); // and the setup file backfills it for the threads pool
  console.log(
    `\n[lattice tests] booted a disposable Postgres for the integration suite ` +
      `(127.0.0.1:${String(port)}); it is removed when the run finishes.\n`,
  );

  return async () => {
    try {
      await pg.stop();
    } catch {
      // best-effort — the data dir is removed regardless
    }
    rmSync(dataDir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    latticePgUrl?: string;
  }
}
