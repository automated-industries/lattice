/**
 * Moving a LOCAL workspace onto a shared database still works from a managed
 * session — because the database being moved onto is not the managed one.
 *
 * Some deployments hand workspace management to a manager: it provisions a
 * database, secures it, and owns who is on it. Re-securing THAT database is
 * refused, correctly. Migration installs security too, on a completely different
 * database — one the person just supplied, holding a copy of their own local
 * workspace — so reading the refusal off the session refuses the whole capability
 * for anybody in such a session, for a database the manager has never heard of.
 *
 * Postgres-gated: the proof is the target really being populated and secured, so
 * a real per-test database is the only way to state it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
// The embedder's door: the package entry point.
import { Lattice, migrateWorkspaceToCloud } from '../../src/index.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { cloudRlsInstalled } from '../../src/framework/cloud-connect.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const databases: string[] = [];
const opened: Lattice[] = [];

function dbUrl(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

afterEach(async () => {
  delete process.env.LATTICE_MANAGED_WORKSPACES_URL;
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

/** A local workspace with one table and one row in it, ready to be moved. */
async function localWorkspace(): Promise<{ db: Lattice; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-managed-migrate-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');
  const db = new Lattice(
    { config: configPath },
    { encryptionKey: Buffer.alloc(32, 19).toString('base64') },
  );
  // The framework's own tables — `notes` among them — are what every opener has,
  // so the workspace being moved is an ordinary one.
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  await db.insert('notes', { id: 'n1', title: 'A note', body: 'moved with the workspace' });
  return { db, configPath };
}

describe.skipIf(!PG_URL)('migrating a local workspace from a managed session', () => {
  it('completes, and the target ends up secured and holding the rows', async () => {
    const dbname = `lattice_mig_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }
    const { db, configPath } = await localWorkspace();
    const label = `mig_${randomBytes(3).toString('hex')}`;

    // The session is managed. The target is not the managed database — it is one
    // this person just supplied.
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'https://workspaces.example/managed/tok';

    const result = await migrateWorkspaceToCloud({
      db,
      configPath,
      url: dbUrl(dbname),
      label,
      encryptionKey: Buffer.alloc(32, 19).toString('base64'),
      releaseSource: () => {
        db.close();
      },
    });

    expect(result.rowsCopied).toBeGreaterThan(0);
    expect(result.tablesCopied).toContain('notes');

    // The rows really moved, and the target really is protected — which is the
    // half a blanket refusal claimed could not be reached.
    const target = new Lattice(dbUrl(dbname));
    opened.push(target);
    await target.init({ introspectOnly: true });
    expect(await cloudRlsInstalled(target)).toBe(true);
    const rows = (await target.query('notes', {})) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain('n1');

    // ...and the workspace was cut over, not merely copied out of.
    expect(readFileSync(configPath, 'utf8')).toMatch(/\$\{LATTICE_DB:/);
  }, 180_000);
});
