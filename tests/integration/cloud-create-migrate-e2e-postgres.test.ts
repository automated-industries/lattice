/**
 * GREEN-GATE E2E — the canonical cloud-create flow, end to end, through the GUI:
 *   boot an owner on a fresh LOCAL workspace → create a cloud via the structured
 *   /api/dbconfig/migrate-to-cloud path → the tables + row-level-security are set
 *   up → invite a member → the member joins with the token and lands on the cloud.
 *
 * This is the test the cloud feature must keep green: if creating a cloud,
 * inviting someone, and joining by token doesn't work, cloud is broken. It
 * exercises the SAME structured-connection methodology the GUI now uses
 * everywhere (the retired postgres:// URL path is gone).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL. A fresh per-test target
 * DATABASE is created in the cluster and dropped in afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const JSON_HEADERS = { 'content-type': 'application/json' };

const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const roles: string[] = [];

function pgParts(): { host: string; port: number; user: string; password: string } {
  const u = new URL(PG_URL!);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}
function urlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

async function freshTargetDb(): Promise<string> {
  const dbname = `lattice_mig_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();
  return dbname;
}

/** Boot a GUI on a fresh LOCAL SQLite workspace under its own root. */
async function bootLocalGui(label: string): Promise<{ gui: GuiServerHandle; wsId: string }> {
  const tmp = mkdtempSync(join(tmpdir(), `mig-${randomBytes(3).toString('hex')}-`));
  dirs.push(tmp);
  const root = join(tmp, '.lattice');
  const ws = addWorkspace(root, { displayName: label, makeActive: true });
  const paths = resolveWorkspacePaths(root, ws);
  mkdirSync(paths.contextDir, { recursive: true });
  const gui = await startGuiServer({
    configPath: paths.configPath,
    outputDir: paths.contextDir,
    latticeRoot: root,
    port: 0,
    openBrowser: false,
  });
  servers.push(gui);
  return { gui, wsId: ws.id };
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
  for (const r of roles.splice(0))
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  await admin.end();
});

describe.skipIf(!PG_URL)('E2E: create cloud (GUI migrate) → invite → join by token', () => {
  it('sets up tables + RLS via migrate-to-cloud, then an invited member joins with the token', async () => {
    const { gui: ownerGui } = await bootLocalGui('Source Local');
    const dbname = await freshTargetDb();
    const p = pgParts();

    // ── Create the cloud THROUGH THE GUI — the canonical structured-fields path.
    const mig = (await fetch(`${ownerGui.url}/api/dbconfig/migrate-to-cloud`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        type: 'postgres',
        label: dbname,
        host: p.host,
        port: p.port,
        dbname,
        user: p.user,
        password: p.password,
      }),
    }).then((r) => r.json())) as { ok?: boolean; error?: string };
    expect(mig.error).toBeUndefined();
    expect(mig.ok).toBe(true);

    // Owner is now ON the cloud (postgres / owner) — the swap happened, no refresh.
    const dbcfg = (await fetch(`${ownerGui.url}/api/dbconfig`).then((r) => r.json())) as {
      type?: string;
      state?: string;
      isCloud?: boolean;
    };
    expect(dbcfg.isCloud).toBe(true);
    expect(dbcfg.type).toBe('postgres');
    expect(dbcfg.state).toBe('cloud-owner');

    // The TABLES were set up correctly: the RLS bookkeeping tables exist.
    const probe = new pg.Pool({ connectionString: urlForDb(dbname), max: 1 });
    try {
      const tbls = (
        await probe.query<{ relname: string }>(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE '\\_\\_lattice\\_%'`,
        )
      ).rows.map((r) => r.relname);
      for (const t of ['__lattice_owners', '__lattice_row_grants', '__lattice_table_policy']) {
        expect(tbls).toContain(t);
      }
    } finally {
      await probe.end();
    }

    // ── Invite a member → opaque token.
    const inv = (await fetch(`${ownerGui.url}/api/cloud/invite`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'member@example.com' }),
    }).then((r) => r.json())) as { ok?: boolean; token?: string; role?: string; error?: string };
    expect(inv.error).toBeUndefined();
    expect(inv.ok).toBe(true);
    expect(inv.token).toBeTruthy();
    if (inv.role) roles.push(inv.role);

    // ── The member joins with the token and lands on the cloud.
    const { gui: memberGui, wsId: memberLocalWsId } = await bootLocalGui('Member Local');
    const redeem = await fetch(`${memberGui.url}/api/cloud/redeem-invite`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'member@example.com', token: inv.token }),
    });
    const joined = (await redeem.json()) as { ok?: boolean; isCloud?: boolean; error?: string };
    expect(joined.error).toBeUndefined();
    expect(joined.ok).toBe(true);
    expect(joined.isCloud).toBe(true);

    const mcfg = (await fetch(`${memberGui.url}/api/dbconfig`).then((r) => r.json())) as {
      type?: string;
      state?: string;
      isCloud?: boolean;
    };
    expect(mcfg.isCloud).toBe(true);
    expect(mcfg.type).toBe('postgres');
    expect(mcfg.state).toBe('cloud-member');

    // The member's pre-existing local workspace is untouched (a NEW cloud ws added).
    const ws = (await fetch(`${memberGui.url}/api/workspaces`).then((r) => r.json())) as {
      workspaces: { id: string; kind: string }[];
    };
    expect(ws.workspaces.find((w) => w.id === memberLocalWsId)?.kind).toBe('local');
    expect(ws.workspaces.some((w) => w.kind === 'cloud')).toBe(true);
  });
});
