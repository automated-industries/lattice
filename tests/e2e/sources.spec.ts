import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * Inputs — the Configure drawer's three input tabs (Files / Connectors /
 * Databases), split out of the old single "Inputs" tab. A registered on-disk
 * folder renders (on the Files tab) as a lazy tree that fetches one level per
 * expand; the MCP Connectors tab hosts the whole connectors panel inline (no
 * dialog). The native OS picker can't run headless, so roots are registered via
 * the real API (the same endpoint the picker feeds).
 */

let gui: BootedGui;
let srcDir: string;

/**
 * Open the Configure drawer to one of the three input tabs (Files / Connectors /
 * Databases — the former single "Inputs" tab was split into three peer tabs). The
 * single-layout router maps #/settings/<tab> → open the drawer over the Workspace
 * home; wait until that tab's body sentinel has rendered.
 */
async function openConfigureTab(
  page: import('@playwright/test').Page,
  tab: 'files' | 'connectors' | 'databases',
  sentinel: string,
): Promise<void> {
  const hash = '#/settings/' + tab;
  await page.goto(gui.url + hash);
  await page.waitForSelector('nav.dash-sidebar', { state: 'visible' });
  // A same-page hash that's already set won't re-fire the route; force it either way.
  await page.evaluate((h) => {
    if (location.hash !== h) location.hash = h;
  }, hash);
  await page.waitForSelector('#settings-drawer.open', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#drawer-body ' + sentinel, { state: 'visible', timeout: 8000 });
}
test.beforeEach(async () => {
  gui = await bootGui();
  srcDir = mkdtempSync(join(tmpdir(), 'lattice-src-e2e-'));
  writeFileSync(join(srcDir, 'note.txt'), 'hello');
  mkdirSync(join(srcDir, 'sub'));
  writeFileSync(join(srcDir, 'sub', 'deep.txt'), 'deep');
});
test.afterEach(async () => {
  await gui.close();
  rmSync(srcDir, { recursive: true, force: true });
});

test('the Configure drawer has Files / Connectors / Databases tabs', async ({ page }) => {
  // Files / Connectors / Databases are now three peer Configure tabs (the former
  // single "Inputs" tab, with the FILES/CONNECTORS/DATABASES subheadings dropped —
  // the tab name IS the heading).
  await openConfigureTab(page, 'files', '#inputs-files-tree');
  await expect(page.locator('.drawer-tab[data-tab="files"]')).toBeVisible();
  await expect(page.locator('.drawer-tab[data-tab="connectors"]')).toBeVisible();
  await expect(page.locator('.drawer-tab[data-tab="databases"]')).toBeVisible();
  // The old subheadings are gone.
  await expect(page.locator('#drawer-body .inputs-group-head')).toHaveCount(0);
  // Each tab renders its own body.
  await page.locator('.drawer-tab[data-tab="connectors"]').click();
  await expect(page.locator('#drawer-body #mcp-connectors-panel')).toBeVisible({ timeout: 5000 });
  await page.locator('.drawer-tab[data-tab="databases"]').click();
  await expect(page.locator('#drawer-body #src-add-database')).toBeVisible({ timeout: 5000 });
});

test('a registered folder renders as a tree and lazily expands one level', async ({ page }) => {
  // Register the folder via the real API (what the native picker feeds).
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  await openConfigureTab(page, 'files', '#inputs-files-tree');
  const tree = page.locator('#inputs-files-tree');
  const rootFolder = tree.locator('.src-folder').first();
  await expect(rootFolder).toBeVisible({ timeout: 5000 });

  // Children are NOT loaded until the folder is expanded (lazy).
  await expect(rootFolder.locator('.src-children .src-name')).toHaveCount(0);
  await rootFolder.locator('> .src-row').click();
  // One level: the 'sub' folder + 'note.txt' file appear; 'deep.txt' does not.
  await expect(tree.getByText('note.txt', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(tree.getByText('sub', { exact: true })).toBeVisible();
  await expect(tree.getByText('deep.txt', { exact: true })).toHaveCount(0);
});

test('the MCP Connectors tab hosts the panel inline (no dialog)', async ({ page }) => {
  await openConfigureTab(page, 'connectors', '#mcp-connectors-panel');
  await expect(page.locator('#mcp-connectors-panel')).toContainText('Add an MCP connector');
  await expect(page.locator('#connectors-dialog')).toHaveCount(0);
});

test('the Files table opens as a SQL runner (like every table)', async ({ page }) => {
  // Files is now a table in the LATTICE schema — clicking it opens the uniform SQL
  // runner, not a bespoke folder tree. The default query shows LIVE rows only (files is
  // soft-deletable), so a soft-deleted/merged file doesn't linger in the view.
  // (On-disk folder roots are still managed in the Configure drawer's Files tab.)
  await page.goto(gui.url + '#/w/table/files');
  await expect(page.locator('.sql-runner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#sql-editor')).toHaveValue(
    /select \* from "files" where deleted_at is null limit 100/i,
  );
  await expect(page.locator('#sql-run')).toBeVisible();
});

// Regression: the Connect-a-database dialog is a MODAL — its backdrop (which
// dims the whole app) must sit BELOW the dialog, or the dialog fades out with
// everything else. A z-order slip once put the dialog under its own backdrop.
test('Connect-a-database opens ABOVE its backdrop (the dialog is not dimmed)', async ({ page }) => {
  await openConfigureTab(page, 'databases', '#src-add-database');
  await page.locator('#src-add-database').click();
  const dialog = page.locator('#db-connect-dialog');
  const backdrop = page.locator('#db-connect-backdrop');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await expect(backdrop).toBeVisible();

  const zOf = (loc: ReturnType<typeof page.locator>) =>
    loc.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  const dialogZ = await zOf(dialog);
  const backdropZ = await zOf(backdrop);
  expect(dialogZ).toBeGreaterThan(backdropZ); // dialog on top of its own scrim

  // Behavioral proof: the Connect button actually receives the click (it is not
  // covered by the backdrop) — Playwright's actionability check throws if it is.
  await expect(page.locator('#db-connect-dialog #db-ok')).toBeVisible();
  await page.locator('#db-connect-dialog #db-ok').click({ trial: true });
});
