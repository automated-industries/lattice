import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

let server: GuiServerHandle;
let base: string;

// 1.16.4: deletion is workspace-based. The danger zone's "Delete workspace"
// deletes the active workspace (owner-only for cloud) and switches to a sibling.
test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'lattice-e2e-del-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-del-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  // A connected Claude subscription is mandatory (the first-run wall gates the
  // whole app), so seed one before the server boots.
  seedClaudeOAuth();
  // Pin the registry root to THIS spec's temp dir BEFORE any root resolution:
  // findLatticeRoot's env override wins everywhere (ensureLatticeRoot included),
  // so a developer shell exporting LATTICE_ROOT=~/.lattice would otherwise send
  // every registry read/WRITE in this spec into the real workspace registry.
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const alpha = addWorkspace(root, { displayName: 'Alpha' });
  // A second workspace so deleting the active one can switch away to it.
  const beta = addWorkspace(root, { displayName: 'Beta' });
  for (const ws of [alpha, beta]) {
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    db.close();
  }
  const pa = resolveWorkspacePaths(root, alpha);
  // The server discovers the root by walking up from the workspace config.
  server = await startGuiServer({
    configPath: pa.configPath,
    outputDir: pa.contextDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
});

test.afterAll(async () => {
  await server.close();
  rmSync(base, { recursive: true, force: true });
});

test('Workspace Settings danger zone deletes the active workspace after typed confirmation', async ({
  page,
}) => {
  await page.goto(`${server.url}#/settings/database`);

  const deleteBtn = page.locator('#db-delete-btn');
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // The confirm modal's red button is disabled until the workspace name matches.
  const ok = page.locator('.modal-backdrop [data-act="ok"]');
  await expect(ok).toBeDisabled();
  await page.locator('#confirm-db-name').fill('Alpha');
  await expect(ok).toBeEnabled();
  await ok.click();

  // The active workspace was deleted and the server switched to the sibling (Beta),
  // which is now the only remaining workspace.
  await expect
    .poll(async () => {
      const res = await page.request.get(`${server.url}/api/workspaces`);
      const body = (await res.json()) as {
        current: string | null;
        workspaces: { id: string; label: string }[];
      };
      const cur = body.workspaces.find((w) => w.id === body.current);
      const labels = body.workspaces
        .map((w) => w.label)
        .sort()
        .join(',');
      return `${cur ? cur.label : 'none'}|${labels}`;
    })
    .toBe('Beta|Beta');
});
