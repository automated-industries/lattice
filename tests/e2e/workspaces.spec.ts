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

// These tests share one server (and thus its active-workspace state), so they
// must run in order rather than racing in parallel workers.
test.describe.configure({ mode: 'serial' });

let server: GuiServerHandle;
let base: string;

test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-ws-home-'));
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
  // The old Objects home (#/folders) is gone; boot into the single-layout home.
  await page.goto(server.url + '#/');
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
  await page.goto(server.url + '#/');
  await expect(page.locator('#ws-name')).toBeVisible();
  const startName = (await page.locator('#ws-name').textContent()) ?? '';

  // Build some navigation history in the current workspace: home → the
  // Questions view. Back becomes enabled once this workspace's per-workspace
  // history stack has a prior entry.
  await page.evaluate(() => {
    location.hash = '#/questions';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/questions');
  await expect(page.locator('#nav-back-btn')).toBeEnabled();

  // Switch workspaces (whichever is not current).
  await page.locator('#ws-button').click();
  const other = page.locator('#ws-menu button.db-item:not(.active)').first();
  await other.click();
  // The switch lands the new workspace on ITS OWN home destination — the bare
  // home, or the dashboard home now redirects to when one exists — never the
  // previous workspace's hash (#/questions).
  const HOME_DEST = /^#\/(w\/dash\/.+)?$/;
  await expect
    .poll(() => page.evaluate(() => location.hash), { timeout: 15000 })
    .toMatch(HOME_DEST);
  await expect(page.locator('#ws-name')).not.toHaveText(startName, { timeout: 5000 });

  // The new workspace starts with ITS OWN history: the old workspace's
  // #/questions (or any of its records) is unreachable from here. There is
  // nothing ahead to go Forward into, and stepping Back never crosses back
  // into the previous workspace's location — it stays on this workspace's home.
  await expect(page.locator('#nav-fwd-btn')).toBeDisabled();
  const backBtn = page.locator('#nav-back-btn');
  if (await backBtn.isEnabled()) await backBtn.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(HOME_DEST);
});

test('a switch whose reload fails surfaces a loud "Switch failed", never a false success', async ({
  page,
}) => {
  await page.goto(server.url + '#/');
  await expect(page.locator('#ws-name')).toBeVisible();
  const startName = (await page.locator('#ws-name').textContent()) ?? '';

  // The switch POST itself succeeds (the server does switch), but the target
  // workspace's entities-summary load 500s once (a transient read degradation).
  // That fetch is load-bearing — its failure must reject the reload so the switch
  // reports the failure loudly and reverts, rather than swallowing it into a blank
  // workspace shown under a false "Switched workspace". Fail only the first call
  // (the forward switch's reload); the revert's own reload then recovers. Routed
  // now, after the initial boot has rendered the switcher.
  let entitySummaryCalls = 0;
  await page.route('**/api/entities-summary', (route) => {
    entitySummaryCalls += 1;
    if (entitySummaryCalls === 1) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"degraded"}',
      });
    }
    return route.continue();
  });

  await page.locator('#ws-button').click();
  await page.locator('#ws-menu button.db-item:not(.active)').first().click();

  // The reload rejection reaches the switch handler's catch: a "Switch failed"
  // toast (before the fix the swallowed 500 let the reload resolve, firing a
  // false "Switched workspace" toast instead — so this assertion fails).
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Switch failed', { timeout: 8000 });
  await expect(toast).not.toContainText('Switched workspace');
  // And the header reverts to where we came from — the failed switch never strands
  // a blank view of the degraded target.
  await expect(page.locator('#ws-name')).toHaveText(startName, { timeout: 8000 });
});
