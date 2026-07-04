/**
 * Computed views must honor per-column audience masking, exercised AS A MEMBER.
 *
 * A computed view reads its source columns THROUGH each table's cell-masking
 * `<t>_v` view on a secured cloud, so a column the owner masked from a member's
 * role (audience `owner` — a secret column revealed only to the row owner) reads
 * NULL through the computed view too. Before the fix the computed view read the
 * RAW base column and applied only row visibility, leaking the masked value.
 *
 * The crux is that this is verified as the SCOPED MEMBER login role (a real,
 * non-BYPASSRLS Postgres role) — an owner-connection read would NOT catch the
 * leak, because the owner (row owner) is allowed to see the secret column.
 *
 * Postgres-gated (per-test database + a provisioned member role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive } from '../../src/gui/server.js';
import type { ActiveDb } from '../../src/gui/server.js';
import { createComputedTable } from '../../src/gui/computed-ops.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import type { ComputedTableDef } from '../../src/config/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const pools: pg.Pool[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const a of actives.splice(0)) await disposeActive(a);
  for (const p of pools.splice(0)) await p.end();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

function writeOwnerConfig(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-cctm-owner-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: "${url}"`,
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      secret: { type: text }',
      '      priority: { type: integer }',
      '      deleted_at: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

// `secret` is aliased AND used in a calc — both must mask to NULL for a member.
const boardDef: ComputedTableDef = {
  base: 'notes',
  fields: {
    body: { kind: 'alias', source: 'body' },
    secret_alias: { kind: 'alias', source: 'secret' },
    secret_len: { kind: 'calc', expr: 'length(secret)', type: 'integer' },
  },
};

describe.skipIf(!PG_URL)('computed tables — cloud member column masking', () => {
  it('masks an owner-secret source column through the computed view for a non-owner member', async () => {
    const dbname = `lattice_cctm_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeOwnerConfig(dbUrl(dbname));
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    // Mark `secret` an owner-audience (secret) column through the DB-canonical
    // runtime path — this builds the `notes_v` cell-masking view + policy row.
    const cols = Object.keys(owner.db.getRegisteredColumns('notes')!);
    const pk = owner.db.getPrimaryKey('notes');
    await setColumnAudience(owner.db, 'notes', 'secret', 'owner', cols, pk);

    // One member-visible row + one owner-private row (each with a secret value).
    const sharedId = await owner.db.insertForcingVisibility(
      'notes',
      { body: 'shared note', secret: 'top-secret', priority: 5 },
      'everyone',
    );
    await owner.db.insertForcingVisibility(
      'notes',
      { body: 'private note', secret: 'hidden', priority: 1 },
      'private',
    );

    // Create the computed view AFTER the column is masked, so it compiles against
    // the masking view.
    await createComputedTable(owner, 'note_board', boardDef, 'sess');

    // The OWNER (the row owner) still sees the secret through the computed view —
    // proving the mask binds per-viewer, not a blanket NULL.
    const ownerPool = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    pools.push(ownerPool);
    const ownerSeen = (
      await ownerPool.query<{
        body: string;
        secret_alias: string | null;
        secret_len: number | null;
      }>(`SELECT body, secret_alias, secret_len FROM "note_board" WHERE id = $1`, [sharedId])
    ).rows;
    expect(ownerSeen).toEqual([
      { body: 'shared note', secret_alias: 'top-secret', secret_len: 'top-secret'.length },
    ]);

    // Provision a scoped member and read the computed view over a raw connection.
    const role = `lm_cctm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    const seen = await member.query<{
      id: string;
      body: string;
      secret_alias: string | null;
      secret_len: number | null;
    }>(`SELECT id, body, secret_alias, secret_len FROM "note_board" ORDER BY body`);

    // Only the shared row is visible (row filtering preserved), the unmasked
    // `body` passes through, and BOTH the masked alias and the calc over the
    // masked column read NULL — the member never sees the secret's value.
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]).toEqual({
      id: sharedId,
      body: 'shared note',
      secret_alias: null,
      secret_len: null,
    });

    // Defense-in-depth: the base column stays unreachable to members, so the
    // mask can't be bypassed with raw SQL against the underlying table.
    await expect(member.query(`SELECT secret FROM "notes"`)).rejects.toThrow(/permission denied/i);
  }, 120_000);
});
