/**
 * Root-cause regression for the "intermittent" Postgres CI failure where EVERY
 * test passed yet the run still exited non-zero with an UNCAUGHT EXCEPTION:
 *
 *     ⎯ Uncaught Exception ⎯
 *     error: terminating connection due to administrator command   (FATAL 57P01)
 *     ⎯ Uncaught Exception ⎯
 *     Error: Connection terminated unexpectedly
 *
 * The integration suite shares ONE embedded Postgres and opens ~130 raw
 * `pg.Pool` / `pg.Client` connections across its files. A pg Pool/Client emits an
 * `'error'` EVENT when its connection drops out-of-band — and a teardown's
 * `pg_terminate_backend(... WHERE datname = <db>)`, or the embedded-PG shutdown,
 * does exactly that. An EventEmitter that emits `'error'` with NO listener makes
 * Node raise an UNCAUGHT EXCEPTION, which vitest counts as a run failure even
 * though every assertion passed. Forked workers run many files each, so the
 * uncaught fires against whichever unguarded connection is live when some test
 * terminates a backend — the victim test varies run to run.
 *
 * The gap is the RAW connections tests open directly (the product guards its own).
 * Two listener-less surfaces existed: (1) the Pool/Client a test news up, and
 * (2) the Pool's INTERNAL clients (pg.Pool builds them from `options.Client`, not
 * the reassigned `pg.Client`, and only re-emits their error while IDLE — not
 * during connect/end). `tests/setup/pg-env.ts` now guards both (a default 'error'
 * listener on every test Pool/Client AND injects a guarded internal client ctor).
 *
 * This drives the condition deterministically (no parallel load): open a raw pool
 * + client, terminate their backends, then close them on the now-dead connections,
 * and assert nothing escaped to the process across BOTH the idle and the
 * connect/end paths.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

function dbUrl(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

describe.skipIf(!PG_URL)('a terminated raw test pg connection must not crash the run', () => {
  it('terminating + closing a pool and a client backend never escapes as an uncaught exception', async () => {
    const dbname = `term_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbname}"`);

    const escaped: string[] = [];
    const onEscape = (e: unknown): void => {
      escaped.push(e instanceof Error ? e.message : String(e));
    };
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);

    const pool = new pg.Pool({ connectionString: dbUrl(dbname), max: 2 });
    const client = new pg.Client({ connectionString: dbUrl(dbname) });
    try {
      await pool.query('SELECT 1'); // opens a pooled internal client, returns it idle
      await client.connect();
      await client.query('SELECT 1');

      // Kill every backend on this db (exactly what a teardown's
      // pg_terminate_backend does).
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbname],
      );
      await new Promise((res) => setTimeout(res, 200)); // idle-path 'error' events fire

      // Now close both on the now-dead connections — the connect/end path the
      // pool-level re-emit does NOT cover (internal clients). Listeners stay
      // attached through this so any escape is captured.
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await new Promise((res) => setTimeout(res, 150)); // end-path 'error' events fire

      const connErrors = escaped.filter((m) =>
        /terminating connection|administrator command|connection terminated/i.test(m),
      );
      expect(connErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onEscape);
      process.removeListener('unhandledRejection', onEscape);
      await admin.query(`DROP DATABASE IF EXISTS "${dbname}"`).catch(() => undefined);
      await admin.end();
    }
  }, 30_000);
});
