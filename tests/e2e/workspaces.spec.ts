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

// These tests share one server (and thus its active-workspace state), so they
// must run in order rather than racing in parallel workers.
test.describe.configure({ mode: 'serial' });

let server: GuiServerHandle;
let base: string;

test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-test-key';
  // Pin the registry root to THIS spec's temp dir BEFORE any root resolution:
  // findLatticeRoot's env override wins everywhere (ensureLatticeRoot included),
  // so a developer shell exporting LATTICE_ROOT=~/.lattice would otherwise send
  // every registry read/WRITE in this spec into the real workspace registry.
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const alpha = addWorkspace(root, { displayName: 'Alpha' });
  const beta = addWorkspace(root, { displayName: 'Beta' });
  // Render both so either can be opened; Alpha stays active (created first).
  for (const ws of [alpha, beta]) {
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    db.close();
  }
  const pa = resolveWorkspacePaths(root, alpha);
  // (Root pinned above; walk-up discovery alone is NOT safe under a shell that
  // exports LATTICE_ROOT.)
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

test('the header workspace switcher lists workspaces and switches the active one', async ({
  page,
}) => {
  await page.goto(server.url);

  const switcher = page.locator('#ws-switcher');
  await expect(switcher).toBeVisible();
  await expect(page.locator('#ws-name')).toHaveText('Alpha');

  await page.locator('#ws-button').click();
  const menu = page.locator('#ws-menu');
  await expect(menu).toBeVisible();
  const betaItem = menu.locator('button.db-item', { hasText: 'Beta' });
  await expect(betaItem).toBeVisible();

  await betaItem.click();
  // After switching, the header reflects the new active workspace.
  await expect(page.locator('#ws-name')).toHaveText('Beta');
});

test('switching paints a loading frame immediately and never freezes on the previous workspace', async ({
  page,
}) => {
  await page.goto(server.url);
  const startName = (await page.locator('#ws-name').textContent()) ?? '';

  // Simulate a slow (cloud-like) open by delaying the switch POST.
  await page.route('**/api/workspaces/switch', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  await page.locator('#ws-button').click();
  // Switch to whichever workspace is NOT currently active (order-independent).
  await page.locator('#ws-menu button.db-item:not(.active)').first().click();

  // The content area shows a loading frame immediately — well before the 800ms
  // open completes — instead of leaving the previous workspace's view frozen.
  await expect(page.locator('#content .route-loading')).toBeVisible({ timeout: 400 });
  // …and the switch still completes (the active workspace changes).
  await expect(page.locator('#ws-name')).not.toHaveText(startName, { timeout: 5000 });
});

test('Back/Forward history is per-workspace: a switch never carries the old hash or history', async ({
  page,
}) => {
  await page.goto(server.url);
  await expect(page.locator('#ws-name')).toBeVisible();

  // Build some history in the current workspace: Objects → Tables.
  await page.locator('.tab[data-key="tables"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('#nav-back-btn')).toBeEnabled();

  // Switch workspaces (whichever is not current).
  await page.locator('#ws-button').click();
  const other = page.locator('#ws-menu button.db-item:not(:has(.db-item-current))').first();
  await other.click();
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 15000 }).toBe('#/');

  // The new workspace starts with ITS OWN history: Back is disabled — the old
  // workspace's #/tables (or any of its records) is unreachable from here.
  await expect(page.locator('#nav-back-btn')).toBeDisabled();
  await expect(page.locator('#nav-fwd-btn')).toBeDisabled();
});
