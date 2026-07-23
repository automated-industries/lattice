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

  // Single-layout reframe: the old fixed "Workspace Settings" view is gone.
  // #/settings/database now opens the Configure drawer; the workspace danger zone
  // lives in its "Workspace" tab (data-tab="database"). Wait for the drawer, then
  // switch to that tab to reach the Delete workspace button.
  await expect(page.locator('#settings-drawer.open')).toBeVisible();
  await page.locator('.drawer-tab[data-tab="database"]').click();

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

// Deleting the ONLY workspace lands the server in the zero-workspace state
// (switchedTo === null). The client must go straight to the welcome screen —
// pre-fix it unconditionally reloaded data routes, which 409 on the virgin
// server, throwing → a false failure toast, the confirm modal left open, and no
// welcome transition. Own hermetic single-workspace server (env is process-wide).
test.describe('deleting the last workspace returns to the welcome screen', () => {
  let soloServer: GuiServerHandle;
  let soloBase: string;

  test.beforeAll(async () => {
    soloBase = mkdtempSync(join(tmpdir(), 'lattice-e2e-del-solo-'));
    process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-del-solo-home-'));
    process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
    seedClaudeOAuth();
    process.env.LATTICE_ROOT = join(soloBase, '.lattice');
    const root = ensureLatticeRoot(soloBase);
    const solo = addWorkspace(root, { displayName: 'Solo' });
    const db = await Lattice.openWorkspace({ root, workspaceId: solo.id });
    db.close();
    const ps = resolveWorkspacePaths(root, solo);
    soloServer = await startGuiServer({
      configPath: ps.configPath,
      outputDir: ps.contextDir,
      port: 0,
      host: '127.0.0.1',
      teamCloud: false,
      openBrowser: false,
    });
  });

  test.afterAll(async () => {
    await soloServer.close();
    rmSync(soloBase, { recursive: true, force: true });
  });

  test('shows #virgin-state with no error toast or lingering modal', async ({ page }) => {
    await page.goto(`${soloServer.url}#/settings/database`);
    await expect(page.locator('#settings-drawer.open')).toBeVisible();
    await page.locator('.drawer-tab[data-tab="database"]').click();

    const deleteBtn = page.locator('#db-delete-btn');
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const ok = page.locator('.modal-backdrop [data-act="ok"]');
    await page.locator('#confirm-db-name').fill('Solo');
    await expect(ok).toBeEnabled();
    await ok.click();

    // The load-bearing flip: the welcome (virgin) screen appears.
    await expect(page.locator('#virgin-state')).toBeVisible();
    // No false-failure toast, and the confirm modal closed.
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    // The switch overlay did not get stuck visible.
    await expect(page.locator('#ws-switch-overlay.show')).toHaveCount(0);

    // Corroborate server state: zero workspaces, virgin.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${soloServer.url}/api/workspaces`);
        const body = (await res.json()) as { virgin?: boolean; workspaces: unknown[] };
        return `${body.virgin === true}|${body.workspaces.length}`;
      })
      .toBe('true|0');
  });
});
