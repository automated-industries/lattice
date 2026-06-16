/**
 * 3.3.4 — a cloud MEMBER could connect and read rows, but: (a) `lattice render` /
 * library init() failed with "permission denied for schema public" because
 * applySchema re-ran CREATE TABLE IF NOT EXISTS (Postgres checks CREATE-on-schema
 * before the IF-NOT-EXISTS short-circuit, and a member has no CREATE); and
 * (b) GET /api/system-tables 500'd on the first owner-only bookkeeping table the
 * member can't count, degrading the GUI.
 *
 * This suite verifies, against real Postgres:
 *  1. a member's init() auto-skips DDL on a provisioned cloud (no throw);
 *  2. SECURITY: secureCloud does NOT grant the member group the owner-only
 *     bookkeeping tables (__lattice_owners / row_grants / cell_grants /
 *     member_roles / cloud_settings / member_invites / changes) — those stay
 *     owner-only, reached only via SECURITY DEFINER functions — while it DOES
 *     grant the per-viewer-filtered __lattice_changelog;
 *  3. the member GUI /api/system-tables returns 200 (tolerates denied tables).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { MEMBER_GROUP } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
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
  for (const s of servers.splice(0)) await s.close();
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

/** A fresh DB secured as a cloud (entity `projects`, no relations) + one member. */
async function ownerCloudWithMember(): Promise<{ dbname: string; role: string; pw: string }> {
  const dbname = `lattice_sub_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('projects', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'projects.md',
  });
  await owner.init();
  await secureCloud(owner);
  await owner.insert('projects', { id: 'p1', name: 'Apollo' });
  // Share the row with everyone so a member's RLS-permitted read returns it
  // (an owner's private row is correctly hidden — not what this test checks).
  await runAsyncOrSync(
    owner.adapter,
    `SELECT lattice_set_row_visibility('projects','p1','everyone')`,
  );

  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  owner.close();
  return { dbname, role, pw };
}

describe.skipIf(!PG_URL)('3.3.4 member substrate', () => {
  it('a member init() auto-skips DDL on a provisioned cloud (no "permission denied for schema public")', async () => {
    const { dbname, role, pw } = await ownerCloudWithMember();
    const member = new Lattice(dbUrl(dbname, role, pw));
    member.define('projects', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'projects.md',
    });
    // Before the fix this rejected with "permission denied for schema public"
    // (applySchema re-ran CREATE TABLE IF NOT EXISTS). The auto-detect now skips
    // DDL for a member on a provisioned cloud, so init resolves.
    await expect(member.init()).resolves.toBeUndefined();
    // And the member can read the row (proves it's a working connection, not a
    // no-op): RLS-permitted SELECT through the normal path.
    const rows = await member.query('projects', {});
    expect(rows.map((r) => r.id)).toContain('p1');
    member.close();
  });

  it('SECURITY: owner-only bookkeeping tables are NOT granted to members; changelog is', async () => {
    const { dbname } = await ownerCloudWithMember();
    const admin = new Lattice(dbUrl(dbname));
    await admin.init();
    const can = async (table: string, priv: string): Promise<boolean> => {
      const row = (await getAsyncOrSync(
        admin.adapter,
        `SELECT has_table_privilege(?::text, format('%I.%I', current_schema(), ?::text), ?::text) AS ok`,
        [MEMBER_GROUP, table, priv],
      )) as { ok?: unknown } | undefined;
      return row?.ok === true || row?.ok === 't';
    };

    // A direct grant on any of these would leak another member's row existence /
    // ownership / sharing graph / identity — they must stay owner-only (members
    // reach them only through SECURITY DEFINER functions keyed on session_user).
    for (const t of [
      '__lattice_owners',
      '__lattice_row_grants',
      '__lattice_cell_grants',
      '__lattice_member_roles',
      '__lattice_cloud_settings',
      '__lattice_member_invites',
      '__lattice_changes',
    ]) {
      expect(await can(t, 'SELECT'), `${t} must NOT be SELECT-able by members`).toBe(false);
      expect(await can(t, 'INSERT'), `${t} must NOT be INSERT-able by members`).toBe(false);
    }

    // __lattice_changelog IS granted — its per-viewer RLS policy filters reads, so
    // the base grant is safe and members need it for observe()/history.
    expect(await can('__lattice_changelog', 'SELECT')).toBe(true);
    expect(await can('__lattice_changelog', 'INSERT')).toBe(true);
    admin.close();
  });

  it('the member GUI /api/system-tables returns 200 (tolerates owner-only tables it cannot count)', async () => {
    const { dbname, role, pw } = await ownerCloudWithMember();
    const tmp = mkdtempSync(join(tmpdir(), `sub-member-${randomBytes(3).toString('hex')}-`));
    dirs.push(tmp);
    const root = join(tmp, '.lattice');
    const ws = addWorkspace(root, {
      displayName: 'Substrate Cloud',
      db: dbUrl(dbname, role, pw),
      makeActive: true,
    });
    const paths = resolveWorkspacePaths(root, ws);
    mkdirSync(paths.contextDir, { recursive: true });
    const gui = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(gui);

    const r = await fetch(`${gui.url}/api/system-tables`);
    expect(r.status).toBe(200); // was 500: "permission denied for table __lattice_changes"
    const body = (await r.json()) as { tables: { name: string; rowCount: number | null }[] };
    // The owner-only tables the member can't count appear with rowCount null,
    // not as a crash; at least one such table is present.
    expect(body.tables.some((t) => t.rowCount === null)).toBe(true);
  });
});
