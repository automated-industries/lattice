/**
 * Securing a database a workspace MANAGER already provisioned is refused — from
 * the library, not only from the browser and the command line.
 *
 * Some deployments hand workspace management to a manager: it provisions the
 * database, secures it, and owns who is on it. Re-running the security bootstrap
 * there is not a harmless repeat — it re-stamps row ownership and re-privatizes
 * shared rows on a database the manager already set up for the account, so rows
 * people were given access to stop being reachable.
 *
 * The refusal existed in the request handler and in the command wrapper. It did
 * not exist in the operation, and the operation is published: a deployment
 * embedding Lattice imports it from the package entry point and calls it
 * directly. So the two doors that had the check were the two doors a manager's
 * own runtime does not use.
 *
 * Postgres-gated (a real per-test database — the refusal has to be proved by the
 * bootstrap NOT being installed afterwards).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
// The embedder's door: the package entry point.
import { Lattice, secureCloud } from '../../src/index.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { MANAGED_REFUSAL } from '../../src/cloud/managed-guard.js';
import { cloudRlsInstalled } from '../../src/framework/cloud-connect.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const databases: string[] = [];
const opened: Lattice[] = [];

function dbUrl(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

afterEach(async () => {
  delete process.env.LATTICE_MANAGED_WORKSPACES_URL;
  for (const db of opened.splice(0)) {
    db.close();
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const name of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await admin.end();
});

/** A fresh, initialized, UNSECURED Postgres — the thing securing acts on. */
async function freshDatabase(): Promise<Lattice> {
  const dbname = `lattice_mgd_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  const db = new Lattice(dbUrl(dbname));
  opened.push(db);
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    primaryKey: 'id',
    outputFile: 'notes.md',
  });
  await db.init();
  return db;
}

describe.skipIf(!PG_URL)('securing a managed workspace', () => {
  it('is refused through the library entry point, and installs nothing', async () => {
    const db = await freshDatabase();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'https://workspaces.example/managed/tok';

    const refusal = await secureCloud(db).then(
      () => null,
      (e: unknown) => e,
    );
    expect(cloudErrorCode(refusal)).toBe('cloud_managed');
    expect((refusal as Error).message).toBe(MANAGED_REFUSAL.secure);

    // The proof the refusal is a refusal and not a late error: the bootstrap the
    // whole operation exists to install is absent.
    expect(await cloudRlsInstalled(db)).toBe(false);
  }, 120_000);

  it('still secures an unmanaged database, and a manager driving it itself may say so', async () => {
    const unmanaged = await freshDatabase();
    await secureCloud(unmanaged);
    expect(await cloudRlsInstalled(unmanaged)).toBe(true);

    // A caller that already knows which kind of session it is says so, rather
    // than reaching through a process-wide environment variable — the same
    // override the invite and remove capabilities take.
    const byTheManager = await freshDatabase();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'https://workspaces.example/managed/tok';
    await secureCloud(byTheManager, { managed: false });
    expect(await cloudRlsInstalled(byTheManager)).toBe(true);
  }, 120_000);
});
