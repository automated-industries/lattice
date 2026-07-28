/**
 * A cloud MEMBER reading version history must not receive owner-secret columns.
 *
 * The audit log stores whole before/after row IMAGES — that is what lets undo, redo
 * and revert restore a row, so what is STORED must stay complete. What is SERVED
 * must not be: a shared row's images carry every column, including the ones this
 * viewer is not allowed to read, so an unmasked history read hands out exactly the
 * values the column mask exists to protect.
 *
 * A serve-time mask for this was written, documented, unit-tested — and wired to
 * nothing. It sat in the tree as dead code while the leak stayed open, and the suite
 * could not tell, because the test called the helper directly and proved the helper
 * worked. That was true and beside the point.
 *
 * So this test never imports the mask. It drives the REAL routes over HTTP as a REAL
 * scoped member and asserts the secret string is absent from the response BODY. Dead
 * code fails it by construction, and so does any future serve path that forgets to
 * call it.
 *
 * The second case is the one that matters most. The column is masked via
 * `setColumnAudience` ALONE, with no `_lattice_gui_column_meta.secret` row — which is
 * what a config-declared audience, a direct API call, or an inherited computed mask
 * all look like. The obvious wiring (resolve secrets from `loadSecretColumns`) is a
 * NO-OP in exactly that case on exactly this connection, because its column-policy
 * arm is skipped for a member: the policy table is owner-only. A green suite and a
 * shipped leak. The mask therefore resolves from the member's own read-view
 * definitions, which a member can read and which cannot drift from the mask.
 *
 * Postgres-gated; boots a real owner GUI and a real member GUI on one cloud.
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
const SECRET = 'EYES-ONLY-PAYROLL';
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

async function guiOn(dbname: string, label: string, user?: string, pw?: string) {
  const tmp = mkdtempSync(join(tmpdir(), `audm-${label}-${randomBytes(3).toString('hex')}-`));
  dirs.push(tmp);
  const root = join(tmp, '.lattice');
  const ws = addWorkspace(root, {
    displayName: `Audit Cloud (${label})`,
    db: dbUrl(dbname, user, pw),
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

/**
 * A cloud where `notes.secret_note` is masked via `setColumnAudience` ONLY — no
 * `_lattice_gui_column_meta.secret` row — with an audit entry whose images carry the
 * secret, written by a real owner edit through the real route.
 */
async function cloudWithSecretInHistory(): Promise<{ dbname: string; role: string; pw: string }> {
  const dbname = `lattice_audm_${randomBytes(4).toString('hex')}`;
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
  await owner.insert('notes', { id: 'n1', body: 'visible', secret_note: 'placeholder' });
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

  // A real owner edit through the real route, so the audit images are produced the
  // way production produces them — not hand-inserted.
  const ownerGui = await guiOn(dbname, 'owner');
  await ownerGui.whenConverged();
  const patched = await fetch(`${ownerGui.url}/api/tables/notes/rows/n1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret_note: SECRET }),
  });
  expect(patched.status).toBe(200);

  // The owner's OWN history read still contains it — this mask is per-viewer, not a
  // blanket scrub, and an owner has every right to their own data.
  const ownerHistory = await (await fetch(`${ownerGui.url}/api/history`)).text();
  expect(ownerHistory).toContain(SECRET);

  return { dbname, role, pw };
}

describe.skipIf(!PG_URL)('a member never receives owner-secret columns in audit images', () => {
  it('GET /api/history masks the secret for a member and keeps it for the owner', async () => {
    const { dbname, role, pw } = await cloudWithSecretInHistory();
    const member = await guiOn(dbname, 'member', role, pw);

    const res = await fetch(`${member.url}/api/history`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // Asserted against the WHOLE body, deliberately: it survives any reshaping of
    // the response and cannot be satisfied by returning nothing.
    expect(body).not.toContain(SECRET);
    // Positive control — the read really did return this table's history, so the
    // assertion above is not passing on an empty result.
    expect(body).toContain('notes');
  }, 180_000);

  it('the system-table browser masks it too', async () => {
    const { dbname, role, pw } = await cloudWithSecretInHistory();
    const member = await guiOn(dbname, 'member', role, pw);

    const body = await (
      await fetch(`${member.url}/api/system-tables/_lattice_gui_audit/rows`)
    ).text();
    expect(body).not.toContain(SECRET);
  }, 180_000);
});
