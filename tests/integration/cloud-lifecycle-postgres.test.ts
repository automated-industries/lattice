/**
 * Cloud lifecycle, end-to-end:
 *   create a cloud → the tables are created/secured correctly →
 *   invite someone → the invite is accepted and the member connects →
 *   per-member chat-message permissions hold.
 *
 * Two halves, both on a real Postgres:
 *  (A) The full GUI-route flow — boot an owner GUI on a freshly-secured cloud,
 *      invite an email through `/api/cloud/invite`, boot a member GUI with a
 *      pre-existing LOCAL workspace, redeem through `/api/cloud/redeem-invite`,
 *      and assert the member lands on the cloud (postgres, cloud-member) with a
 *      NEW workspace while the local one is untouched. Before inviting, it
 *      introspects the cloud and asserts the RLS bookkeeping tables + every
 *      native/user table exist and are FORCE-RLS secured, and that the
 *      private-only tables (chat + secrets) are `never_share`.
 *  (B) The chat-permission boundary at the RLS layer (the substrate behind the
 *      app-level owner filter): scoped members connect directly and a member can
 *      read ONLY its own chat rows — never the owner's, never another member's —
 *      and cannot share a chat row (private-only table).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL. Isolation is a fresh
 * per-test DATABASE in the throwaway cluster (production-realistic public
 * schema), dropped in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const JSON_HEADERS = { 'content-type': 'application/json' };

const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const pools: pg.Pool[] = [];
const dbs: Lattice[] = [];
const roles: string[] = []; // cluster-global scoped roles this run minted

function baseUrlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

/** A scoped-member connection string for a per-test database (no search_path —
 *  each database has its own `public` schema). */
function memberUrlForDb(dbname: string, role: string, pw: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  u.username = role;
  u.password = pw;
  return u.toString();
}

/** Stand up a fresh per-test database with the native entities registered, then
 *  secure it as a cloud. Leaves the owner Lattice OPEN (callers introspect /
 *  insert through it, then it is closed in afterEach). */
async function makeNativeCloud(): Promise<{ ownerDb: Lattice; cloudUrl: string; dbname: string }> {
  const dbname = `lattice_life_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  const cloudUrl = baseUrlForDb(dbname);

  const ownerDb = new Lattice(cloudUrl, { encryptionKey: 'lifecycle-test-key' });
  dbs.push(ownerDb);
  registerNativeEntities(ownerDb); // secrets / files / notes / chat_threads / chat_messages
  ownerDb.define('shared_t', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'shared_t.md',
  });
  // The GUI creates __lattice_user_identity at workspace-open, BEFORE the owner
  // secures the cloud — so secureCloud's grant of that one member-writable system
  // table fires (a member records "who is sitting here" through it). Mirror that
  // ordering here so the secured cloud matches what the app actually produces.
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
  await secureCloud(ownerDb); // RLS + ownership + member group + never_share on private tables
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

/** Owner invites an email; returns the opaque token + minted scoped role. */
async function invite(
  ownerGui: GuiServerHandle,
  email: string,
): Promise<{ token: string; role: string }> {
  const r = (await fetch(`${ownerGui.url}/api/cloud/invite`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  }).then((x) => x.json())) as { ok?: boolean; token?: string; role?: string; error?: string };
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(r.token).toBeTruthy();
  return { token: r.token!, role: r.role! };
}

/** Boot a member GUI with a PRE-EXISTING local workspace. */
async function bootMemberGui(): Promise<{ memberGui: GuiServerHandle; localWsId: string }> {
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
  });
  servers.push(memberGui);
  return { memberGui, localWsId: localWs.id };
}

async function redeem(
  memberGui: GuiServerHandle,
  email: string,
  token: string,
): Promise<{ status: number; body: { ok?: boolean; isCloud?: boolean; error?: string } }> {
  const r = await fetch(`${memberGui.url}/api/cloud/redeem-invite`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, token }),
  });
  return { status: r.status, body: (await r.json()) as { ok?: boolean; isCloud?: boolean } };
}

/** Owner-side admin pool on a per-test database (the `postgres` superuser — used
 *  ONLY for schema introspection, which RLS does not gate). */
function adminPool(dbname: string): pg.Pool {
  const p = new pg.Pool({ connectionString: baseUrlForDb(dbname), max: 1 });
  pools.push(p);
  return p;
}

function memberPool(dbname: string, role: string, pw: string): pg.Pool {
  const p = new pg.Pool({ connectionString: memberUrlForDb(dbname, role, pw), max: 1 });
  pools.push(p);
  return p;
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
  for (const p of pools.splice(0)) await p.end();
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
  // Member roles are cluster-global — drop exactly the ones this run minted (a
  // scoped lm_* role owns no objects, so DROP ROLE alone suffices after the DB).
  for (const r of roles.splice(0)) {
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud lifecycle: create → secure → invite → connect → chat perms', () => {
  it('creates the tables correctly, then a member accepts an invite and connects to the cloud', async () => {
    const { ownerDb, cloudUrl, dbname } = await makeNativeCloud();

    // ── The tables are created CORRECTLY. ───────────────────────────────────
    const admin = adminPool(dbname);

    // (1) RLS bookkeeping tables exist.
    const bookkeeping = (
      await admin.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE '\\_\\_lattice\\_%'`,
      )
    ).rows.map((r) => r.relname);
    for (const t of ['__lattice_owners', '__lattice_row_grants', '__lattice_table_policy']) {
      expect(bookkeeping).toContain(t);
    }

    // (2) Every native + user table exists and has FORCE RLS on (relrowsecurity
    //     AND relforcerowsecurity) — so even the table owner is row-confined.
    const secured = (
      await admin.query<{ relname: string; rls: boolean; force: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      )
    ).rows;
    const byName = new Map(secured.map((r) => [r.relname, r]));
    for (const t of ['shared_t', 'files', 'secrets', 'notes', 'chat_threads', 'chat_messages']) {
      const row = byName.get(t);
      expect(row, `table ${t} should exist`).toBeDefined();
      expect(row!.rls, `${t} should have RLS enabled`).toBe(true);
      expect(row!.force, `${t} should have FORCE RLS`).toBe(true);
    }

    // (3) The private-only tables are never_share — chat (per-author private) and
    //     secrets can never be bulk-shared to members.
    const policy = (
      await admin.query<{ table_name: string; never_share: boolean }>(
        `SELECT "table_name", "never_share" FROM "__lattice_table_policy"`,
      )
    ).rows;
    const neverShare = new Set(policy.filter((p) => p.never_share).map((p) => p.table_name));
    expect(neverShare.has('chat_threads')).toBe(true);
    expect(neverShare.has('chat_messages')).toBe(true);
    expect(neverShare.has('secrets')).toBe(true);

    // Close the owner library connection before the GUI opens its own.
    ownerDb.close();
    dbs.splice(dbs.indexOf(ownerDb), 1);

    // ── Invite someone to the cloud → invite is accepted and connects. ──────
    const ownerGui = await bootOwnerGui(cloudUrl, 'Acme Cloud');
    const { token, role } = await invite(ownerGui, 'member@example.com');
    roles.push(role); // clean up the invite-minted scoped role in afterEach
    const { memberGui, localWsId } = await bootMemberGui();

    // Before: the member has only its local workspace, active.
    const before = (await fetch(`${memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      current: string;
      workspaces: { id: string; kind: string }[];
    };
    expect(before.workspaces).toHaveLength(1);
    expect(before.current).toBe(localWsId);

    // Member redeems the invite.
    const r = await redeem(memberGui, 'member@example.com', token);
    expect(r.body.error).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(r.body.isCloud).toBe(true);

    // After: a NEW cloud workspace exists and is active; the local one is intact.
    const after = (await fetch(`${memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      current: string;
      workspaces: { id: string; label: string; kind: string }[];
    };
    expect(after.workspaces).toHaveLength(2);
    const local = after.workspaces.find((w) => w.id === localWsId);
    const cloud = after.workspaces.find((w) => w.id !== localWsId);
    expect(local!.kind).toBe('local');
    expect(cloud!.kind).toBe('cloud');
    expect(cloud!.label).toBe('Acme Cloud');
    expect(after.current).toBe(cloud!.id);

    // The member is actually ON the cloud (postgres / cloud-member), not a
    // silent empty local DB.
    const dbcfg = (await fetch(`${memberGui.url}/api/dbconfig`).then((r) => r.json())) as {
      type?: string;
      state?: string;
      isCloud?: boolean;
    };
    expect(dbcfg.isCloud).toBe(true);
    expect(dbcfg.type).toBe('postgres');
    expect(dbcfg.state).toBe('cloud-member');
  });

  it('per-member chat permissions: a member reads only its OWN chat, never the owner’s or another member’s, and cannot share it', async () => {
    const { ownerDb, dbname } = await makeNativeCloud();

    // Owner writes a private chat (one thread + one message). On a never_share
    // table the default insert is private-to-owner.
    await ownerDb.insert('chat_threads', {
      id: 't-owner',
      title: 'Owner chat',
      owner_user_id: 'owner-uid',
    });
    await ownerDb.insert('chat_messages', {
      id: 'm-owner',
      thread_id: 't-owner',
      role: 'user',
      owner_user_id: 'owner-uid',
      content_json: JSON.stringify({ text: 'owner secret' }),
    });

    // Two scoped members.
    const tag = randomBytes(3).toString('hex');
    const alice = `lm_life_a_${tag}`;
    const bob = `lm_life_b_${tag}`;
    roles.push(alice, bob);
    const alicePw = generateMemberPassword();
    const bobPw = generateMemberPassword();
    await provisionMemberRole(ownerDb, alice, alicePw);
    await provisionMemberRole(ownerDb, bob, bobPw);
    ownerDb.close();
    dbs.splice(dbs.indexOf(ownerDb), 1);

    const A = memberPool(dbname, alice, alicePw);
    const B = memberPool(dbname, bob, bobPw);

    // Alice cannot see the owner's private chat (thread or message).
    expect(
      (await A.query<{ id: string }>(`SELECT id FROM chat_threads`)).rows.map((r) => r.id),
    ).not.toContain('t-owner');
    expect(
      (await A.query<{ id: string }>(`SELECT id FROM chat_messages`)).rows.map((r) => r.id),
    ).not.toContain('m-owner');

    // Alice writes her own chat. owner_user_id is stamped to her connection
    // identity (session_user) exactly as the app does, so her own read passes the
    // per-author RLS while everyone else's is filtered out.
    await A.query(
      `INSERT INTO chat_threads (id, title, owner_user_id) VALUES ('t-alice','Alice chat',session_user)`,
    );
    await A.query(
      `INSERT INTO chat_messages (id, thread_id, role, owner_user_id, content_json) VALUES ('m-alice','t-alice','user',session_user,'{"text":"alice note"}')`,
    );

    // Alice sees HER chat and only hers.
    expect(
      (await A.query<{ id: string }>(`SELECT id FROM chat_messages ORDER BY id`)).rows.map(
        (r) => r.id,
      ),
    ).toEqual(['m-alice']);

    // Bob sees NEITHER alice's nor the owner's chat — member-from-member and
    // member-from-owner isolation both hold.
    expect((await B.query<{ id: string }>(`SELECT id FROM chat_messages`)).rows).toEqual([]);
    expect((await B.query<{ id: string }>(`SELECT id FROM chat_threads`)).rows).toEqual([]);

    // A chat row is private-only: even its owner cannot share it.
    await expect(
      A.query(`SELECT lattice_set_row_visibility('chat_messages','m-alice','everyone')`),
    ).rejects.toThrow(/private-only table and cannot be shared/i);
  });
});
