/**
 * #2.1 — a MEMBER reading an audience-masked table through the GUI server. A
 * secured cloud REVOKEs base SELECT from members for any table with a column
 * audience and grants only the `<table>_v` masking view — so a member's base read
 * was `permission denied`. The read path now routes member SELECTs to the view:
 * the row is returned, the masked column reads NULL, the rest is intact, and the
 * masked table is NOT exposed as a separate `<table>_v` sidebar object.
 *
 * Boots a real member GUI against a real per-test cloud database. Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
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

async function memberGuiOnMaskedCloud(): Promise<GuiServerHandle> {
  // ── Owner: a fresh DB secured as a cloud with a masked column on `notes`.
  const dbname = `lattice_aud_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  await owner.init();
  await secureCloud(owner);
  // A row shared with everyone, but secret_note masked to the row owner only.
  await owner.insert('notes', { id: 'n1', body: 'visible', secret_note: 'EYES ONLY' });
  await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility('notes','n1','everyone')`);
  // A second row visible to the OWNER ONLY (private). The member must neither see
  // it in the list NOR count it — proving the pagination total is RLS-scoped.
  await owner.insert('notes', { id: 'n2', body: 'owner-private', secret_note: 'hidden' });
  await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility('notes','n2','private')`);
  await setColumnAudience(
    owner,
    'notes',
    'secret_note',
    'owner',
    ['id', 'body', 'secret_note', 'deleted_at'],
    ['id'],
  );

  // ── Member role + a member GUI pointed straight at the cloud as that role.
  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  owner.close();

  const tmp = mkdtempSync(join(tmpdir(), `aud-member-${randomBytes(3).toString('hex')}-`));
  dirs.push(tmp);
  const root = join(tmp, '.lattice');
  const ws = addWorkspace(root, {
    displayName: 'Masked Cloud',
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
  return gui;
}

describe.skipIf(!PG_URL)('#2.1 member reads a masked table through the GUI', () => {
  it('the list read succeeds and masks the audience column (was permission denied)', async () => {
    const gui = await memberGuiOnMaskedCloud();
    const r = await fetch(`${gui.url}/api/tables/notes/rows`);
    expect(r.status).toBe(200); // base SELECT was revoked — must route to notes_v
    const body = (await r.json()) as { rows: { id: string; body: string; secret_note: unknown }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.body).toBe('visible'); // unmasked column intact
    expect(body.rows[0]!.secret_note ?? null).toBeNull(); // owner-only column masked
  });

  it('the single-row read also routes to the view + masks', async () => {
    const gui = await memberGuiOnMaskedCloud();
    const r = await fetch(`${gui.url}/api/tables/notes/rows/n1`);
    expect(r.status).toBe(200);
    const row = (await r.json()) as { body: string; secret_note: unknown };
    expect(row.body).toBe('visible');
    expect(row.secret_note ?? null).toBeNull();
  });

  it('the pagination total (approxTotal) counts only rows the member can see', async () => {
    // Guards the recurring "only tested as owner/BYPASSRLS" failure class: the
    // bounded count must route through the same RLS-scoped relation as the rows.
    const gui = await memberGuiOnMaskedCloud();
    const r = await fetch(`${gui.url}/api/tables/notes/rows`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      rows: { id: string }[];
      approxTotal: number;
      totalIsCapped: boolean;
    };
    expect(body.rows.map((x) => x.id)).toEqual(['n1']); // owner-private n2 hidden
    expect(body.approxTotal).toBe(1); // …and NOT counted (would be 2 if unscoped)
    expect(body.totalIsCapped).toBe(false);
  });

  it('the masking view is NOT exposed as a separate sidebar object', async () => {
    const gui = await memberGuiOnMaskedCloud();
    const ents = (await (await fetch(`${gui.url}/api/entities`)).json()) as {
      tables: { name: string }[];
    };
    const names = ents.tables.map((t) => t.name);
    expect(names).toContain('notes');
    expect(names.some((n) => n.endsWith('_v'))).toBe(false); // no notes_v leak
  });
});
