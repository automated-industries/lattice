/**
 * #5.2 — end-to-end invite → join → connect guard. The shipped bug: a member
 * redeemed an invite, saw "joined", and silently landed on an empty LOCAL DB
 * (the active workspace was hijacked / the credential never resolved). This boots
 * a real owner GUI + a real member GUI and asserts the failure modes are gone:
 * a NEW cloud workspace is created + activated, the pre-existing local workspace
 * is untouched, and the member is actually on the cloud (postgres, not sqlite).
 *
 * Also guards the invite LIFECYCLE through the real routes (#3.1 one-time-use,
 * #3.4 re-invite drops the prior orphaned role).
 *
 * Isolation: a fresh per-test DATABASE in the throwaway cluster (production-
 * realistic public schema; the payload's dbname carries it). Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];

function baseUrlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Stand up a fresh per-test database, secure it as a cloud (one shared row), and
 *  boot an OWNER GUI pointed at it. Returns the cloud URL + the owner GUI. */
async function makeOwnerCloud(): Promise<{ cloudUrl: string; ownerGui: GuiServerHandle }> {
  const dbname = `lattice_e2e_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  const cloudUrl = baseUrlForDb(dbname);

  const ownerDb = new Lattice(cloudUrl);
  ownerDb.define('shared_t', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'shared_t.md',
  });
  await ownerDb.init();
  await secureCloud(ownerDb); // installs RLS + ownership + member group
  await ownerDb.insert('shared_t', { id: 's1', name: 'row one' });
  ownerDb.close();

  const ownerTmp = mkdtempSync(join(tmpdir(), `owner-${randomBytes(3).toString('hex')}-`));
  dirs.push(ownerTmp);
  const ownerRoot = join(ownerTmp, '.lattice'); // the root marker is a .lattice/.config dir
  const ownerWs = addWorkspace(ownerRoot, {
    displayName: 'Acme Cloud',
    db: cloudUrl,
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
  servers.push(ownerGui);
  return { cloudUrl, ownerGui };
}

/** Owner invites an email; returns the opaque token + the minted scoped role. */
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
  expect(r.role).toBeTruthy();
  return { token: r.token!, role: r.role! };
}

/** Boot a member GUI with a PRE-EXISTING local workspace. Returns the GUI + the
 *  local workspace id (so a test can assert it stays untouched). */
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

async function roleExists(role: string): Promise<boolean> {
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  try {
    const r = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
    return r.rowCount === 1;
  } finally {
    await admin.end();
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
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
  await admin.end();
});

describe.skipIf(!PG_URL)('#5.2 invite → join → connect (e2e)', () => {
  it('a redeemed invite creates a NEW active cloud workspace; the local one is untouched', async () => {
    const { ownerGui } = await makeOwnerCloud();
    const { token } = await invite(ownerGui, 'member@example.com');
    const { memberGui, localWsId } = await bootMemberGui();

    // Before: one local workspace, active.
    const before = (await fetch(`${memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      current: string;
      workspaces: { id: string; label: string; kind: string }[];
    };
    expect(before.workspaces).toHaveLength(1);
    expect(before.current).toBe(localWsId);

    // ── Member redeems the invite.
    const r = await redeem(memberGui, 'member@example.com', token);
    expect(r.body.error).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(r.body.isCloud).toBe(true);

    // After: a NEW workspace exists and is active; the local one is untouched.
    const after = (await fetch(`${memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      current: string;
      workspaces: { id: string; label: string; kind: string }[];
    };
    expect(after.workspaces).toHaveLength(2); // NOT hijacked — a new one was added
    const local = after.workspaces.find((w) => w.id === localWsId);
    const cloud = after.workspaces.find((w) => w.id !== localWsId);
    expect(local).toBeDefined();
    expect(local!.kind).toBe('local'); // pre-existing local workspace intact
    expect(cloud).toBeDefined();
    expect(cloud!.kind).toBe('cloud'); // the new cloud workspace
    expect(cloud!.label).toBe('Acme Cloud'); // named from the cloud (1.3a)
    expect(after.current).toBe(cloud!.id); // auto-switched to the cloud

    // The member is actually ON the cloud (postgres), not a silent empty local DB.
    const dbcfg = (await fetch(`${memberGui.url}/api/dbconfig`).then((r) => r.json())) as {
      type?: string;
      state?: string;
      isCloud?: boolean;
    };
    expect(dbcfg.isCloud).toBe(true);
    expect(dbcfg.type).toBe('postgres');
    expect(dbcfg.state).toBe('cloud-member');
  });

  it('#3.1: the SAME invite token cannot be redeemed twice (one-time-use)', async () => {
    const { ownerGui } = await makeOwnerCloud();
    const { token } = await invite(ownerGui, 'twice@example.com');

    // First member redeems successfully.
    const m1 = await bootMemberGui();
    const first = await redeem(m1.memberGui, 'twice@example.com', token);
    expect(first.body.ok).toBe(true);
    expect(first.body.isCloud).toBe(true);

    // A second redeem of the SAME token (a leaked/replayed token) is rejected —
    // the invite was claimed (redeemed_at stamped); it does NOT silently join.
    const m2 = await bootMemberGui();
    const second = await redeem(m2.memberGui, 'twice@example.com', token);
    expect(second.body.ok).not.toBe(true);
    expect(second.status).toBeGreaterThanOrEqual(400);
    // The second member is NOT on a cloud — its only workspace is still local.
    const ws = (await fetch(`${m2.memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      workspaces: { kind: string }[];
    };
    expect(ws.workspaces.every((w) => w.kind === 'local')).toBe(true);
  });

  it('#3.4: re-inviting the same email drops the prior orphaned role', async () => {
    const { ownerGui } = await makeOwnerCloud();
    const a = await invite(ownerGui, 'reinvite@example.com');
    expect(await roleExists(a.role)).toBe(true);

    // Re-invite the same email: a fresh role is minted and the prior PENDING one
    // is revoked + dropped (no orphan accumulation, old token now dead).
    const b = await invite(ownerGui, 'reinvite@example.com');
    expect(b.role).not.toBe(a.role);
    expect(await roleExists(b.role)).toBe(true);
    expect(await roleExists(a.role)).toBe(false); // prior role cleaned up

    // The OLD token can no longer be redeemed (its role is gone); the NEW one can.
    const mOld = await bootMemberGui();
    const old = await redeem(mOld.memberGui, 'reinvite@example.com', a.token);
    expect(old.body.ok).not.toBe(true);

    const mNew = await bootMemberGui();
    const fresh = await redeem(mNew.memberGui, 'reinvite@example.com', b.token);
    expect(fresh.body.ok).toBe(true);
    expect(fresh.body.isCloud).toBe(true);
  });
});
