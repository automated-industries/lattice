/**
 * The open-time cloud converge (reconcileCloudMemberAccess) is per-table
 * fault-isolated: a table the connecting role cannot manage — e.g. one created by
 * a DIFFERENT Postgres role — is skipped with an actionable reason, and EVERY
 * other table is still reconciled. Previously one un-ownable table aborted the
 * whole converge and degraded the entire workspace to "Failed to fetch".
 *
 * To make "must be owner of table X" actually fire, the converge must run as a
 * NON-superuser role (a superuser bypasses ownership). So this secures a cloud as
 * a dedicated non-superuser owner role, then hands ONE table to another role, and
 * asserts the next converge skips only that table.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dbs: Lattice[] = [];
const pools: pg.Pool[] = [];
const databases: string[] = [];
const roles: string[] = [];

function urlForDb(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const p of pools.splice(0)) await p.end();
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud converge: per-table fault isolation', () => {
  it('skips a table the connecting role cannot manage, still reconciles the rest', async () => {
    const tag = randomBytes(4).toString('hex');
    const dbname = `lattice_cv_${tag}`;
    databases.push(dbname);
    const superUser = decodeURIComponent(new URL(PG_URL!).username); // the cluster superuser

    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    pools.push(admin);
    await admin.query(`CREATE DATABASE "${dbname}"`);

    // A dedicated NON-superuser owner role that will secure the cloud (so it owns
    // the bookkeeping + the tables it creates). CREATEROLE so it can mint the
    // member group; schema rights so it can create tables/functions.
    const owner = `cv_owner_${tag}`;
    const ownerPw = `pw_${tag}`;
    roles.push(owner);
    const dbAdmin = new pg.Pool({ connectionString: urlForDb(dbname), max: 1 });
    pools.push(dbAdmin);
    await dbAdmin.query(`CREATE ROLE "${owner}" LOGIN PASSWORD '${ownerPw}' CREATEROLE`);
    await dbAdmin.query(`GRANT ALL ON SCHEMA public TO "${owner}"`);
    await dbAdmin.query(`GRANT ALL ON DATABASE "${dbname}" TO "${owner}"`);

    // Secure the cloud AS the owner role: it owns `mine`, `foreign_t`, and all the
    // bookkeeping. (reconcile inside secureCloud succeeds — owner owns everything.)
    const ownerDb = new Lattice(urlForDb(dbname, owner, ownerPw));
    dbs.push(ownerDb);
    ownerDb.define('mine', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'mine.md',
    });
    ownerDb.define('foreign_t', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'foreign_t.md',
    });
    await ownerDb.init();
    await secureCloud(ownerDb);

    // Hand `foreign_t` to a different role — now the owner can no longer ALTER or
    // GRANT it (the exact "table created by another role" scenario).
    await dbAdmin.query(`ALTER TABLE foreign_t OWNER TO "${superUser}"`);

    // The next converge (as the owner) must isolate the failure to `foreign_t`.
    const report = await reconcileCloudMemberAccess(ownerDb);

    const skippedTables = report.skipped.map((s) => s.table);
    expect(skippedTables).toContain('foreign_t');
    expect(skippedTables).not.toContain('mine'); // the rest still reconcile
    const foreignReason = report.skipped.find((s) => s.table === 'foreign_t')?.reason ?? '';
    expect(foreignReason).toMatch(/owned by/i); // actionable: names the owner mismatch
    expect(foreignReason).toMatch(/ALTER TABLE/i); // and the exact fix
  });
});
