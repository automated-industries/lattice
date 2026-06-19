/**
 * Zero-workspace "virgin" state (Feature B): the GUI server boots with NO active
 * DB, serves the shell + workspace-management/onboarding routes, 409s every data
 * route, and transitions into a normal workspace once one is created.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRootForGui } from '../../src/framework/gui-bootstrap.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { addWorkspace, listWorkspaces } from '../../src/framework/workspace.js';
import { workspaceDir } from '../../src/framework/lattice-root.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bootVirgin(): Promise<GuiServerHandle> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-virgin-'));
  dirs.push(base);
  const boot = ensureRootForGui({
    startDir: base,
    configPath: join(base, 'lattice.config.yml'),
    explicitConfig: false,
  });
  expect(boot.workspaceId).toBeNull(); // confirm we're actually virgin
  const server = await startGuiServer({
    configPath: boot.configPath,
    outputDir: boot.contextDir,
    latticeRoot: boot.root,
    port: 0,
    openBrowser: false,
    autoRender: true,
  });
  servers.push(server);
  return server;
}

describe('GUI virgin (zero-workspace) state', () => {
  it('serves the shell, an empty workspace list, and identity — but 409s data routes', async () => {
    const s = await bootVirgin();

    // The shell loads (so the SPA can render the welcome screen).
    const html = await fetch(`${s.url}/`);
    expect(html.status).toBe(200);

    // `virgin: true` is the authoritative no-active-DB signal the client gates on.
    const ws = (await fetch(`${s.url}/api/workspaces`).then((r) => r.json())) as {
      virgin?: boolean;
      current: string | null;
      workspaces: unknown[];
    };
    expect(ws.virgin).toBe(true);
    expect(ws.current).toBeNull();
    expect(ws.workspaces).toHaveLength(0);

    // Identity works (the wizard needs it) without a DB.
    expect((await fetch(`${s.url}/api/userconfig/identity`)).status).toBe(200);

    // Realtime status reports "none", not a crash.
    const rt = (await fetch(`${s.url}/api/realtime/status`).then((r) => r.json())) as {
      mode: string;
    };
    expect(rt.mode).toBe('none');

    // A data route has no DB → 409 (loud, not a 500/crash).
    expect((await fetch(`${s.url}/api/entities`)).status).toBe(409);
    expect((await fetch(`${s.url}/api/dashboard`)).status).toBe(409);
  });

  it('lets you Connect with Claude from the virgin state (assistant creds are machine-level)', async () => {
    // Regression: "Connect with Claude" runs in the onboarding wizard BEFORE a
    // workspace exists, but the virgin guard 409'd every /api/assistant/* route
    // ("No active workspace"), so oauth/start failed. Assistant credentials live
    // in the machine-local store, not a workspace, so these must work with no DB.
    const s = await bootVirgin();

    // config reports presence flags (not a 409) — the wizard reads it to know if
    // an account is already connected.
    const cfgRes = await fetch(`${s.url}/api/assistant/config`);
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as { claudeAuthKind?: string | null };
    expect('claudeAuthKind' in cfg).toBe(true);

    // oauth/start begins the PKCE flow: a 302 to the authorize URL + a verifier
    // cookie — NOT a 409 "No active workspace".
    const start = await fetch(`${s.url}/api/assistant/oauth/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location') ?? '').toMatch(/^https?:\/\//);
    expect(start.headers.get('set-cookie') ?? '').toContain('lat_oauth_verifier=');
  });

  it('a plain --config GUI (active DB, no .lattice registry) is NOT virgin', async () => {
    // Regression: a plain `--config` boot has an active DB but an EMPTY workspace
    // registry. The client must boot it normally, NOT show the welcome screen —
    // so /api/workspaces must NOT report virgin, and data routes must work.
    const base = mkdtempSync(join(tmpdir(), 'lattice-plaincfg-'));
    dirs.push(base);
    mkdirSync(join(base, 'data'), { recursive: true });
    const configPath = join(base, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
    );
    const server = await startGuiServer({
      configPath,
      outputDir: join(base, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    const ws = (await fetch(`${server.url}/api/workspaces`).then((r) => r.json())) as {
      virgin?: boolean;
      workspaces: unknown[];
    };
    expect(ws.virgin).not.toBe(true); // active DB → not the welcome screen
    expect(ws.workspaces).toHaveLength(0); // …even though the registry is empty
    expect((await fetch(`${server.url}/api/entities`)).status).toBe(200); // data routes live
  });

  it('creating a local workspace transitions out of the virgin state', async () => {
    const s = await bootVirgin();

    const create = await fetch(`${s.url}/api/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My First Workspace' }),
    });
    expect(create.status).toBe(200);

    // Now there is a workspace, and the data routes work.
    const ws = (await fetch(`${s.url}/api/workspaces`).then((r) => r.json())) as {
      current: string | null;
      workspaces: { label: string }[];
    };
    expect(ws.workspaces).toHaveLength(1);
    expect(ws.current).not.toBeNull();
    expect(ws.workspaces[0]?.label).toBe('My First Workspace');

    const entities = await fetch(`${s.url}/api/entities`);
    expect(entities.status).toBe(200);
  });

  it('rejects a nameless create from the virgin state', async () => {
    const s = await bootVirgin();
    const r = await fetch(`${s.url}/api/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(r.status).toBe(400);
  });

  it('deleting the LAST workspace returns to the virgin state (no "only workspace" refusal)', async () => {
    const s = await bootVirgin();
    const created = (await fetch(`${s.url}/api/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Solo' }),
    }).then((r) => r.json())) as { id: string };
    expect((await fetch(`${s.url}/api/entities`)).status).toBe(200);

    // Delete the only workspace → no refusal; server drops to virgin.
    const del = await fetch(`${s.url}/api/workspaces/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as { switchedTo: string | null }).toEqual({
      ok: true,
      switchedTo: null,
    });

    // Back to virgin: empty registry + data routes 409 again.
    const ws = (await fetch(`${s.url}/api/workspaces`).then((r) => r.json())) as {
      workspaces: unknown[];
    };
    expect(ws.workspaces).toHaveLength(0);
    expect((await fetch(`${s.url}/api/entities`)).status).toBe(409);
  });

  it('deletes a registered-but-inactive workspace from the virgin state (DB never opened)', async () => {
    // Regression: a workspace whose database fails to open at boot leaves the
    // server with NO active DB (virgin), yet the welcome screen still lists it
    // (the list is read from the registry). Deleting it 409'd "No active
    // workspace" because the delete route sat behind the virgin gate — so the
    // workspace was un-removable. It must be deletable with no active DB.
    const base = mkdtempSync(join(tmpdir(), 'lattice-virgin-del-'));
    dirs.push(base);
    const boot = ensureRootForGui({
      startDir: base,
      configPath: join(base, 'lattice.config.yml'),
      explicitConfig: false,
    });
    expect(boot.workspaceId).toBeNull();
    const s = await startGuiServer({
      configPath: boot.configPath,
      outputDir: boot.contextDir,
      latticeRoot: boot.root,
      port: 0,
      openBrowser: false,
      autoRender: true,
    });
    servers.push(s);

    // Register a workspace directly in the registry AFTER the virgin boot, so the
    // server's in-memory state stays "no active DB" — mimicking a workspace whose
    // database could not be opened.
    const ws = addWorkspace(boot.root, { displayName: 'Unopenable', makeActive: true });
    expect(existsSync(workspaceDir(boot.root, ws.dir))).toBe(true);

    // Still virgin, but the welcome screen lists the registered workspace.
    const listed = (await fetch(`${s.url}/api/workspaces`).then((r) => r.json())) as {
      virgin?: boolean;
      workspaces: { id: string }[];
    };
    expect(listed.virgin).toBe(true);
    expect(listed.workspaces.map((w) => w.id)).toContain(ws.id);

    // Delete must succeed (not 409 "No active workspace").
    const del = await fetch(`${s.url}/api/workspaces/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ws.id }),
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean }).toMatchObject({ ok: true });

    // Record dropped from the registry AND the local folder removed.
    expect(listWorkspaces(boot.root).map((w) => w.id)).not.toContain(ws.id);
    expect(existsSync(workspaceDir(boot.root, ws.dir))).toBe(false);
  });
});
