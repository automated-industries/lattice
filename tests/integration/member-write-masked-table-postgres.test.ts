/**
 * A cloud MEMBER writing to a table whose base SELECT was revoked in favour of the
 * `<table>_v` masking view.
 *
 * Reading was already routed to the view at a handful of call sites. WRITING never
 * was — and a write reads: `updateRow` takes a before-image and an after-image via
 * `db.get`, which emitted `SELECT * FROM "<base>"`. On a masked table a member has
 * no base SELECT, so the write failed with `permission denied` before it ever
 * reached the UPDATE. The masked-table tests that existed asserted PRIVILEGE BITS
 * (`has_table_privilege`) and never performed a real member write, so nothing
 * caught it.
 *
 * That matters far beyond masked tables: the fix that revokes base SELECT from
 * members on EVERY table turns this from "masked tables are half-broken" into
 * "every table is half-broken" unless reads resolve through the view at the one
 * seam every read already funnels through. This test is the guard on that seam —
 * it drives the real HTTP route, so it fails if the routing regresses anywhere
 * between the handler and the SQL.
 *
 * Postgres-gated; boots a real member GUI against a real per-test cloud database.
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

/** A member GUI on a cloud where `notes.secret_note` is masked and `n1` is shared. */
async function memberGuiOnMaskedCloud(): Promise<GuiServerHandle> {
  const dbname = `lattice_mw_${randomBytes(4).toString('hex')}`;
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
  await owner.insert('notes', { id: 'n1', body: 'visible', secret_note: 'EYES ONLY' });
  await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility('notes','n1','everyone')`);
  await setColumnAudience(
    owner,
    'notes',
    'secret_note',
    'owner',
    ['id', 'body', 'secret_note', 'deleted_at'],
    ['id'],
  );

  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  owner.close();

  // Open the workspace ONCE as the owner, exactly as a real cloud is used: that is
  // what creates the GUI-side tables a write touches (the audit log) and what runs
  // the owner-side convergence that issues the member grants. A member-only harness
  // reads fine and then fails on the first write for reasons that have nothing to do
  // with what is under test.
  const ownerTmp = mkdtempSync(join(tmpdir(), `mw-owner-${randomBytes(3).toString('hex')}-`));
  dirs.push(ownerTmp);
  const ownerRoot = join(ownerTmp, '.lattice');
  const ownerWs = addWorkspace(ownerRoot, {
    displayName: 'Masked Cloud (owner)',
    db: dbUrl(dbname),
    makeActive: true,
  });
  const ownerPaths = resolveWorkspacePaths(ownerRoot, ownerWs);
  mkdirSync(ownerPaths.contextDir, { recursive: true });
  const ownerGui = await startGuiServer({
    configPath: ownerPaths.configPath,
    outputDir: ownerPaths.contextDir,
    port: 0,
    openBrowser: false,
  });
  await ownerGui.whenConverged();
  await ownerGui.close();

  const tmp = mkdtempSync(join(tmpdir(), `mw-member-${randomBytes(3).toString('hex')}-`));
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

describe.skipIf(!PG_URL)('a member can WRITE to a table it reads through a masking view', () => {
  it('updates a shared row without base SELECT — the write path reads through the view', async () => {
    const gui = await memberGuiOnMaskedCloud();

    const res = await fetch(`${gui.url}/api/tables/notes/rows/n1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'edited by the member' }),
    });

    // Before the read seam this was a 500 carrying `permission denied for table notes`
    // — raised by the before-image read, not by the UPDATE.
    const text = await res.text();
    expect(res.status, `PATCH failed: ${text}`).toBe(200);
    expect(text).not.toMatch(/permission denied/i);

    // ...and the write actually landed.
    const after = (await (await fetch(`${gui.url}/api/tables/notes/rows`)).json()) as {
      rows: { id: string; body: string; secret_note: unknown }[];
    };
    const n1 = after.rows.find((r) => r.id === 'n1');
    expect(n1?.body).toBe('edited by the member');

    // The mask is still doing its job on the way back out — a member write must not
    // become a way to read the column the member may not see.
    expect(n1?.secret_note ?? null).toBeNull();
  });

  it('never sends the member a raw base-table read for a masked table', async () => {
    const gui = await memberGuiOnMaskedCloud();
    // The row read, the list read and the write all have to agree: whatever the
    // member touches, `EYES ONLY` is never in the response.
    for (const path of ['/api/tables/notes/rows', '/api/tables/notes/rows/n1']) {
      const body = await (await fetch(`${gui.url}${path}`)).text();
      expect(body).not.toContain('EYES ONLY');
    }
  });

  /**
   * Search must not go dark for a member.
   *
   * Both search tiers build their own SQL and read the base table directly, which a
   * member has no SELECT on — and `fullTextSearch` swallows a per-table failure so
   * one bad table cannot kill the whole search. The two together turned a permission
   * error into an EMPTY RESULT: search silently returned nothing for every member,
   * on every table, and looked exactly like "no matches".
   *
   * That is the failure mode this release already produced once (masked tables became
   * read-only for members and nobody noticed), which is why it is asserted from the
   * member's side rather than trusted to routing.
   */
  it('search still finds rows for a member, through the read view', async () => {
    const gui = await memberGuiOnMaskedCloud();

    const res = await fetch(`${gui.url}/api/search?q=visible`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups?: { table: string; hits?: unknown[] }[] };
    const hits = (body.groups ?? []).flatMap((g) => g.hits ?? []);
    expect(hits.length, `search returned nothing: ${JSON.stringify(body)}`).toBeGreaterThan(0);

    // ...and finding it must not hand back the masked column.
    expect(JSON.stringify(body)).not.toContain('EYES ONLY');
  });
});
