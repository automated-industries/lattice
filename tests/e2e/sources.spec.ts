import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * 4.3 — Sources sidebar. Three peer sections (Files / Artifacts / Connectors);
 * a registered on-disk folder renders as a lazy tree that fetches one level per
 * expand; the "Add a Connector" entry opens the Connectors drawer. The native OS
 * picker can't run headless, so roots are registered via the real API (the same
 * endpoint the picker feeds).
 */

let gui: BootedGui;
let srcDir: string;
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

test('the sidebar shows the three Inputs sections', async ({ page }) => {
  await page.goto(gui.url + '#/');
  const src = page.locator('#sources-nav');
  await expect(src.getByText('Files', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(src.getByText('Connectors', { exact: true })).toBeVisible();
  await expect(src.getByText('Databases', { exact: true })).toBeVisible();
  // Artifacts moved to the Outputs column; empty on a fresh workspace.
  await expect(page.locator('#out-artifacts-tree')).toContainText('Nothing created yet');
});

test('a registered folder renders as a tree and lazily expands one level', async ({ page }) => {
  // Register the folder via the real API (what the native picker feeds).
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(gui.url + '#/');
  const tree = page.locator('#src-files-tree');
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
  await page.goto(gui.url + '#/');
  await page.locator('#src-add-connector').click();
  await expect(page.locator('#connectors-dialog')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#connectors-dialog-body')).toContainText('Jira');
});

test('the Files object page is a table and folders drill in', async ({ page }) => {
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  // The Files object page (#/fs/files) lists the registered folder root as a table row.
  await page.goto(gui.url + '#/fs/files');
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

  await page.goto(gui.url + '#/');
  const header = page.locator('.section-toggle[data-group="files"] .section-label-text');
  await expect(header).toBeVisible({ timeout: 5000 });
  const child = page.locator('#src-files-tree .src-row').first();
  await expect(child).toBeVisible({ timeout: 5000 });

  const hb = await header.boundingBox();
  const cb = await child.boundingBox();
  expect(hb).toBeTruthy();
  expect(cb).toBeTruthy();
  // Header label is at or left of the child rows (allow a 1px rounding margin).
  expect(hb!.x).toBeLessThanOrEqual(cb!.x + 1);
});
