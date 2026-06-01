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

  it('returns empty when the GUI is opened on a plain config (no root)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-gws-plain-'));
    dirs.push(base);
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
});
