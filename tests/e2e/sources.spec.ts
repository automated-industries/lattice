import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * Inputs — the Configure drawer's Inputs tab. Three peer groups (Files /
 * Connectors / Databases) moved off the old two-view Sources rail into the
 * Configure drawer (#settings-drawer → Inputs). A registered on-disk folder
 * renders as a lazy tree that fetches one level per expand; the "Add a Connector"
 * entry opens the Connectors dialog. The native OS picker can't run headless, so
 * roots are registered via the real API (the same endpoint the picker feeds).
 */

let gui: BootedGui;
let srcDir: string;

/**
 * Open the Configure drawer to its Inputs tab (Files / Connectors / Databases).
 * The single-layout router maps #/settings/inputs → open the drawer over the
 * Workspace home; wait until the Inputs body has rendered.
 */
async function openInputsDrawer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(gui.url + '#/settings/inputs');
  await page.waitForSelector('nav.dash-sidebar', { state: 'visible' });
  // A same-page hash that's already set won't re-fire the route; force it either way.
  await page.evaluate(() => {
    if (location.hash !== '#/settings/inputs') location.hash = '#/settings/inputs';
  });
  await page.waitForSelector('#settings-drawer.open', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#drawer-body #src-add-connector', {
    state: 'visible',
    timeout: 8000,
  });
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

test('the Configure drawer shows the three Inputs sections', async ({ page }) => {
  // The Markdown tree lives in the left sidebar now. The Tables/Files/Markdown sections
  // are a single-open accordion (Tables open by default), so expand Markdown first.
  await page.goto(gui.url + '#/');
  await page.locator('.section-toggle[data-group="nav-md"]').click();
  await expect(page.locator('#nav-md-tree')).toBeVisible({ timeout: 5000 });
  // Files / Connectors / Databases moved into the Configure drawer's Inputs tab.
  await openInputsDrawer(page);
  const heads = page.locator('#drawer-body .inputs-group-head');
  await expect(heads.filter({ hasText: 'Files' })).toBeVisible({ timeout: 5000 });
  await expect(heads.filter({ hasText: 'Connectors' })).toBeVisible();
  await expect(heads.filter({ hasText: 'Databases' })).toBeVisible();
});

test('a registered folder renders as a tree and lazily expands one level', async ({ page }) => {
  // Register the folder via the real API (what the native picker feeds).
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  await openInputsDrawer(page);
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

test('"Add a Connector" opens the connectors dialog', async ({ page }) => {
  await openInputsDrawer(page);
  await page.locator('#src-add-connector').click();
  await expect(page.locator('#connectors-dialog')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#connectors-dialog-body')).toContainText('Jira');
});

test('the Files table tab is a table and folders drill in', async ({ page }) => {
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  // The Files collection tab (#/w/table/files) lists the registered folder root as a
  // table row. (Legacy #/fs/files redirects here via the single-layout router.)
  await page.goto(gui.url + '#/w/table/files');
  await expect(page.locator('table.fs-files-table')).toBeVisible({ timeout: 5000 });
  const folderLink = page.locator('.fs-files-table a[href^="#/folder/"]').first();
  await expect(folderLink).toBeVisible({ timeout: 5000 });

  // Drilling into the folder → #/folder/… lists its sub-folder + file as table rows.
  await folderLink.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/folder/');
  await expect(page.locator('table.fs-files-table')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fs-files-table')).toContainText('note.txt');
});

// Regression: the collapsible group header must be the outermost (furthest-left)
// element with its child rows indented under it — not inverted (header inset past
// its own children).
test('the Files group header sits left of its child rows (tree indentation)', async ({ page }) => {
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  await openInputsDrawer(page);
  const header = page.locator('#drawer-body .inputs-group-head', { hasText: 'Files' });
  await expect(header).toBeVisible({ timeout: 5000 });
  const child = page.locator('#inputs-files-tree .src-row').first();
  await expect(child).toBeVisible({ timeout: 5000 });

  const hb = await header.boundingBox();
  const cb = await child.boundingBox();
  expect(hb).toBeTruthy();
  expect(cb).toBeTruthy();
  // Header label is at or left of the child rows (allow a 1px rounding margin).
  expect(hb!.x).toBeLessThanOrEqual(cb!.x + 1);
});

// Regression: the Connect-a-database dialog is a MODAL — its backdrop (which
// dims the whole app) must sit BELOW the dialog, or the dialog fades out with
// everything else. A z-order slip once put the dialog under its own backdrop.
test('Connect-a-database opens ABOVE its backdrop (the dialog is not dimmed)', async ({ page }) => {
  await openInputsDrawer(page);
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
