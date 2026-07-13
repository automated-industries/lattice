import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
  getActiveWorkspace,
  setActiveWorkspace,
} from '../../src/index.js';

interface WsListItem {
  id: string;
  label: string;
  dir: string;
  kind: string;
}
interface WsList {
  current: string | null;
  workspaces: WsListItem[];
}

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

describe('GUI /api/workspaces', () => {
  it('lists workspaces + current and switches the active one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const alpha = addWorkspace(root, { displayName: 'Alpha' });
    const beta = addWorkspace(root, { displayName: 'Beta' });
    const dbA = await Lattice.openWorkspace({ root, workspaceId: alpha.id });
    dbA.close();

    const pa = resolveWorkspacePaths(root, alpha);
    const server = await startGuiServer({
      configPath: pa.configPath,
      outputDir: pa.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as WsList;
    expect(list.workspaces.length).toBe(2);
    expect(list.workspaces.map((w) => w.label).sort()).toEqual(['Alpha', 'Beta']);
    expect(list.current).toBe(alpha.id);

    const sw = (await (
      await fetch(`${server.url}/api/workspaces/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: beta.id }),
      })
    ).json()) as { ok?: boolean };
    expect(sw.ok).toBe(true);
    expect(getActiveWorkspace(root)?.id).toBe(beta.id);
  });

  it('creates a new workspace and makes it the active one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-create-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const alpha = addWorkspace(root, { displayName: 'Alpha' });
    const dbA = await Lattice.openWorkspace({ root, workspaceId: alpha.id });
    dbA.close();

    const pa = resolveWorkspacePaths(root, alpha);
    const server = await startGuiServer({
      configPath: pa.configPath,
      outputDir: pa.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const created = (await (
      await fetch(`${server.url}/api/workspaces/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gamma' }),
      })
    ).json()) as { ok?: boolean; id?: string };
    expect(created.ok).toBe(true);
    expect(typeof created.id).toBe('string');

    const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as WsList;
    expect(list.workspaces.map((w) => w.label).sort()).toEqual(['Alpha', 'Gamma']);
    expect(list.current).toBe(created.id); // the new workspace becomes active
    expect(getActiveWorkspace(root)?.id).toBe(created.id);

    // A blank name is rejected.
    const bad = await fetch(`${server.url}/api/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('header current follows the SERVED config, not a stale registry active (desync fix)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-desync-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const alpha = addWorkspace(root, { displayName: 'Alpha' });
    const beta = addWorkspace(root, { displayName: 'Beta' });
    (await Lattice.openWorkspace({ root, workspaceId: alpha.id })).close();
    // The registry says Beta is active, but the server boots on ALPHA's config —
    // exactly the drift that showed the wrong workspace label over another
    // workspace's data. The header must reflect what's actually being served.
    setActiveWorkspace(root, beta.id);

    const pa = resolveWorkspacePaths(root, alpha);
    const server = await startGuiServer({
      configPath: pa.configPath,
      outputDir: pa.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as WsList;
    expect(list.current).toBe(alpha.id); // served workspace, NOT the stale Beta
    expect(getActiveWorkspace(root)?.id).toBe(alpha.id); // boot reconciled the registry
  });

  it('returns empty when the GUI is opened on a plain config (no root)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-plain-'));
    dirs.push(base);
    // Anchor the root lookup inside the sandbox (the dir is never created, so the
    // registry reads as empty): without this the upward walk from the config's
    // temp dir can find a real user-level root on machines that have one.
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const cfg = join(base, 'lattice.config.yml');
    writeFileSync(cfg, 'db: ./data.db\nentities: {}\n');
    const server = await startGuiServer({
      configPath: cfg,
      outputDir: join(base, 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as WsList;
    expect(list.workspaces).toEqual([]);
    expect(list.current).toBeNull();
  });

  // 4.3.2 regression — the reported files-leak. Registering a source root in one
  // workspace must NOT appear in another after switching. Pre-fix, roots lived in
  // a single machine-global sources.json, so a brand-new workspace showed the
  // previous workspace's folders.
  it('source roots do NOT leak across a workspace switch', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-srcleak-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    delete process.env.LATTICE_LOCAL_OPEN; // default: local file access enabled
    const root = ensureLatticeRoot(base);
    const alpha = addWorkspace(root, { displayName: 'Alpha' });
    const beta = addWorkspace(root, { displayName: 'Beta' });
    (await Lattice.openWorkspace({ root, workspaceId: alpha.id })).close();

    const pa = resolveWorkspacePaths(root, alpha);
    const server = await startGuiServer({
      configPath: pa.configPath,
      outputDir: pa.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    // A folder to register as a source root while Alpha is the active workspace.
    const srcDir = mkdtempSync(join(tmpdir(), 'lattice-gws-src-'));
    dirs.push(srcDir);
    writeFileSync(join(srcDir, 'note.txt'), 'hello');

    interface RootsResp {
      enabled: boolean;
      roots?: { path: string }[];
    }
    const reg = await fetch(`${server.url}/api/sources/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir, kind: 'folder' }),
    });
    expect(reg.status).toBe(200);

    // Alpha sees its root.
    const a = (await (await fetch(`${server.url}/api/sources/roots`)).json()) as RootsResp;
    expect(a.roots).toHaveLength(1);
    expect(a.roots?.[0]?.path).toBe(srcDir);

    // Switch to Beta — a brand-new workspace.
    const sw = (await (
      await fetch(`${server.url}/api/workspaces/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: beta.id }),
      })
    ).json()) as { ok?: boolean };
    expect(sw.ok).toBe(true);

    // Beta must be EMPTY — the roots must not have leaked across the switch.
    const b = (await (await fetch(`${server.url}/api/sources/roots`)).json()) as RootsResp;
    expect(b.roots ?? []).toHaveLength(0);

    // Switching back to Alpha still shows its root (no data loss).
    await fetch(`${server.url}/api/workspaces/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: alpha.id }),
    });
    const a2 = (await (await fetch(`${server.url}/api/sources/roots`)).json()) as RootsResp;
    expect(a2.roots).toHaveLength(1);
    expect(a2.roots?.[0]?.path).toBe(srcDir);
  });
});
