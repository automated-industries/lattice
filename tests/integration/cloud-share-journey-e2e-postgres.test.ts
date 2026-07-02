/**
 * Cloud sharing — the full journey, end to end, over the real HTTP API.
 *
 * One coherent test drives an OWNER GUI and a MEMBER GUI against a real cloud
 * (Postgres) entirely through `/api/*` — the same routes the browser calls —
 * exercising the consolidated sharing layer as a user actually hits it:
 *
 *   1. Owner secures a cloud and creates three rows through `/api/tables`.
 *   2. Owner shares one `everyone`, grants one to a specific member (`custom`),
 *      and leaves one `private`.
 *   3. A member is invited and joins through `/api/cloud/redeem-invite`.
 *   4. The member SEES exactly the shared subset (everyone + custom), never the
 *      private row — enforced by Postgres RLS, read back through `/api/tables`.
 *   5. The member RENDERS non-empty context for a visible row (guards the
 *      "member rendered 0 files" regression: a member's synthesized context tree).
 *   6. The member CREATES a row and RE-SHARES it `everyone`; the owner then sees
 *      it through `/api/tables`.
 *   7. Negative gate: a member cannot change the sharing of a row they do not own
 *      (the owner-only database function raises, surfaced as an API error).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL (the local run boots a
 * disposable embedded Postgres; CI uses a real service). Isolation is a fresh
 * per-test database in the throwaway cluster, dropped in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setRowVisibility, grantRow } from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const JSON_HEADERS = { 'content-type': 'application/json' };

const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const dbs: Lattice[] = [];
const roles: string[] = []; // cluster-global scoped roles this run minted

function baseUrlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

type HttpResult = { status: number; body: unknown };

/** GET a JSON route. */
async function getJson(gui: GuiServerHandle, path: string): Promise<HttpResult> {
  const r = await fetch(`${gui.url}${path}`);
  return { status: r.status, body: await r.json() };
}

/** POST a JSON route. */
async function postJson(gui: GuiServerHandle, path: string, payload: unknown): Promise<HttpResult> {
  const r = await fetch(`${gui.url}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

/** Stand up a fresh per-test database, register the schema, and secure it as a
 *  cloud. Leaves the owner Lattice OPEN — the owner side (seed rows + set
 *  sharing) runs through it (the owner's render layout lives only in the owner's
 *  code/config, never in the cloud, so an owner GUI on a bare workspace config
 *  has no entities; the member discovers them from the catalog). Closed in
 *  afterEach. */
async function makeCloud(): Promise<{ ownerDb: Lattice; cloudUrl: string; dbname: string }> {
  const dbname = `lattice_share_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  const cloudUrl = baseUrlForDb(dbname);

  const ownerDb = new Lattice(cloudUrl, { encryptionKey: 'share-journey-key' });
  dbs.push(ownerDb);
  registerNativeEntities(ownerDb);
  ownerDb.define('shared_t', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'shared_t.md',
  });
  // The GUI creates __lattice_user_identity at workspace-open before the owner
  // secures the cloud, so secureCloud grants that one member-writable system
  // table. Mirror that ordering so the secured cloud matches the real app.
  ownerDb.define('__lattice_user_identity', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      display_name: "TEXT NOT NULL DEFAULT ''",
      email: "TEXT NOT NULL DEFAULT ''",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
    },
    primaryKey: 'id',
    render: () => '',
    outputFile: '.lattice-native/user-identity.md',
  });
  await ownerDb.init();
  await secureCloud(ownerDb);
  return { ownerDb, cloudUrl, dbname };
}

/** Boot an OWNER GUI pointed at an already-secured cloud, under a fresh root. */
async function bootOwnerGui(cloudUrl: string, label: string): Promise<GuiServerHandle> {
  const ownerTmp = mkdtempSync(join(tmpdir(), `owner-${randomBytes(3).toString('hex')}-`));
  dirs.push(ownerTmp);
  const ownerRoot = join(ownerTmp, '.lattice');
  const ws = addWorkspace(ownerRoot, { displayName: label, db: cloudUrl, makeActive: true });
  const paths = resolveWorkspacePaths(ownerRoot, ws);
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

/** Boot a MEMBER GUI with a pre-existing local workspace, autoRender ON so the
 *  member's synthesized context tree actually renders (the "0 files" guard). */
async function bootMemberGui(): Promise<GuiServerHandle> {
  const memberTmp = mkdtempSync(join(tmpdir(), `member-${randomBytes(3).toString('hex')}-`));
  dirs.push(memberTmp);
  const memberRoot = join(memberTmp, '.lattice');
  const localWs = addWorkspace(memberRoot, { displayName: 'My Local', makeActive: true });
  const localPaths = resolveWorkspacePaths(memberRoot, localWs);
  mkdirSync(localPaths.contextDir, { recursive: true });
  const memberGui = await startGuiServer({
    configPath: localPaths.configPath,
    outputDir: localPaths.contextDir,
    port: 0,
    openBrowser: false,
    autoRender: true,
  });
  servers.push(memberGui);
  return memberGui;
}

/** Poll /api/render/status until the background render finishes (or throw). */
async function waitForRender(gui: GuiServerHandle, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getJson<{ phase: string; error?: string }>(gui, '/api/render/status');
    if (body.phase === 'done') return;
    if (body.phase === 'error') throw new Error(`member render failed: ${body.error ?? 'unknown'}`);
    if (Date.now() > deadline)
      throw new Error(`member render did not finish (phase=${body.phase})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

type RowsResp = { rows?: { id: string }[]; error?: string };
type ShareResp = { ok?: boolean; error?: string };
type CreateResp = { id?: string; error?: string };
type InviteResp = { ok?: boolean; token?: string; role?: string; error?: string };
type RedeemResp = { ok?: boolean; isCloud?: boolean; error?: string };
type DbCfgResp = { state?: string; type?: string; isCloud?: boolean };
type RowResp = { id?: string; error?: string };
type ContextResp = { files?: { name: string; content: string }[] };

describe.skipIf(!PG_URL)(
  'cloud sharing: owner shares → member sees/renders/creates → owner sees',
  () => {
    it('drives the full share journey over the HTTP API with RLS-correct visibility', async () => {
      const { ownerDb, cloudUrl } = await makeCloud();
      const owner = await bootOwnerGui(cloudUrl, 'Team Cloud');

      // ── Owner creates three rows. All start owner-private. ─────────────────────
      // (Owner side runs through the owner's library connection: the render layout
      // that names these entities lives in the owner's code, never in the cloud, so
      // an owner GUI booted on a bare workspace config has no entities registered —
      // only a MEMBER discovers them from the catalog, which the journey below does.)
      await ownerDb.insert('shared_t', { id: 'r-everyone', name: 'Shared with everyone' });
      await ownerDb.insert('shared_t', { id: 'r-private', name: 'Owner private' });
      await ownerDb.insert('shared_t', { id: 'r-custom', name: 'Shared with one member' });

      // ── Invite a member; mint the scoped role (the real GUI invite flow). ──────
      const inv = (await postJson(owner, '/api/cloud/invite', { email: 'member@example.com' }))
        .body as InviteResp;
      expect(inv.error).toBeUndefined();
      expect(inv.ok).toBe(true);
      const token = inv.token!;
      const role = inv.role!;
      roles.push(role);

      // ── Owner sets sharing explicitly: everyone, private, and a custom grant. ──
      await setRowVisibility(ownerDb, 'shared_t', 'r-everyone', 'everyone');
      await setRowVisibility(ownerDb, 'shared_t', 'r-private', 'private');
      await grantRow(ownerDb, 'shared_t', 'r-custom', role);

      // ── Member joins the cloud through redeem-invite. ──────────────────────────
      const member = await bootMemberGui();
      const redeem = (
        await postJson(member, '/api/cloud/redeem-invite', { email: 'member@example.com', token })
      ).body as RedeemResp;
      expect(redeem.error).toBeUndefined();
      expect(redeem.ok).toBe(true);

      const dbcfg = (await getJson(member, '/api/dbconfig')).body as DbCfgResp;
      expect(dbcfg.isCloud).toBe(true);
      expect(dbcfg.type).toBe('postgres');
      expect(dbcfg.state).toBe('cloud-member');

      // ── Member SEES exactly the shared subset — RLS read back over the API. ────
      const list = (await getJson(member, '/api/tables/shared_t/rows')).body as RowsResp;
      expect(list.error).toBeUndefined();
      const visible = (list.rows ?? []).map((r) => r.id).sort();
      expect(visible).toEqual(['r-custom', 'r-everyone']); // NOT r-private
      expect(visible).not.toContain('r-private');

      // Single-row reads confirm the same boundary: visible → 200, private → 404.
      const okRow = await getJson(member, '/api/tables/shared_t/rows/r-everyone');
      expect(okRow.status).toBe(200);
      expect((okRow.body as RowResp).id).toBe('r-everyone');
      const hiddenRow = await getJson(member, '/api/tables/shared_t/rows/r-private');
      expect(hiddenRow.status).toBe(404);

      // ── Member RENDERS non-empty context for a visible row (the "0 files" guard).
      await waitForRender(member);
      const context = (await getJson(member, '/api/tables/shared_t/rows/r-everyone/context'))
        .body as ContextResp;
      expect((context.files ?? []).length).toBeGreaterThan(0);

      // ── Member CREATES a row and RE-SHARES it everyone. ────────────────────────
      const created = await postJson(member, '/api/tables/shared_t/rows', {
        id: 'r-member',
        name: 'Created by the member',
      });
      expect((created.body as CreateResp).error).toBeUndefined();
      expect([200, 201]).toContain(created.status);
      const reshare = (
        await postJson(member, '/api/cloud/share', {
          table: 'shared_t',
          pk: 'r-member',
          visibility: 'everyone',
        })
      ).body as ShareResp;
      expect(reshare.error).toBeUndefined();
      expect(reshare.ok).toBe(true);

      // ── Owner SEES the member's row (read back through the owner connection). ──
      const ownerRows = await ownerDb.query('shared_t', {});
      expect(ownerRows.map((r) => r.id as string)).toContain('r-member');

      // ── Negative gate: a member cannot re-share a row they do NOT own. ─────────
      const denied = (
        await postJson(member, '/api/cloud/share', {
          table: 'shared_t',
          pk: 'r-everyone', // owned by the owner
          visibility: 'private',
        })
      ).body as ShareResp;
      expect(denied.ok).not.toBe(true);
      expect(denied.error).toBeTruthy();

      // ── Owner-gate: a scoped MEMBER can write ROWS (above) but must NOT drive
      // SCHEMA/config mutations — merge, delete-table, or add-link all edit the
      // owner's config and are 403 for a member (RLS alone does not gate them).
      const mergeDenied = await postJson(member, '/api/schema/entities/shared_t/merge', {
        target: 'shared_t',
      });
      expect(mergeDenied.status).toBe(403);
      const linkDenied = await postJson(member, '/api/schema/entities/shared_t/links', {
        target: 'shared_t',
      });
      expect(linkDenied.status).toBe(403);
      const dropDenied = await fetch(`${member.url}/api/schema/entities/shared_t`, {
        method: 'DELETE',
      });
      expect(dropDenied.status).toBe(403);
      // The shared table survives the denied drop.
      expect((await ownerDb.query('shared_t', {})).length).toBeGreaterThan(0);

      // The SAME gate covers every other config/DDL-mutating schema route — a
      // scoped member is 403 on create/junction/rename/columns/delete-link/purge
      // too (each edits the owner's on-disk config, which RLS does not protect).
      expect((await postJson(member, '/api/schema/entities', { name: 'sneaky' })).status).toBe(403);
      expect(
        (await postJson(member, '/api/schema/junctions', { left: 'shared_t', right: 'shared_t' }))
          .status,
      ).toBe(403);
      expect(
        (await postJson(member, '/api/schema/entities/shared_t/rename', { newName: 'renamed' }))
          .status,
      ).toBe(403);
      expect(
        (await postJson(member, '/api/schema/entities/shared_t/columns', { name: 'c', op: 'add' }))
          .status,
      ).toBe(403);
      const linkDropDenied = await fetch(
        `${member.url}/api/schema/entities/shared_t/links/whatever`,
        { method: 'DELETE' },
      );
      expect(linkDropDenied.status).toBe(403);
      expect(
        (await postJson(member, '/api/schema/purge', { type: 'table', name: 'shared_t' })).status,
      ).toBe(403);
      // The owner's table + rows survive every denied schema mutation.
      expect((await ownerDb.query('shared_t', {})).length).toBeGreaterThan(0);
    });
  },
);
