import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * Sources — the left-sidebar FILES section plus the Configure drawer's two
 * remaining input tabs (Connectors / Databases). FILES is the single file home:
 * a registered on-disk folder renders there as a lazy tree that fetches one
 * level per expand, and there is no Files tab in the Configure drawer any more.
 * The MCP Connectors tab hosts the whole connectors panel inline (no dialog).
 * The native OS picker can't run headless, so roots are registered via the real
 * API (the same endpoint the picker feeds).
 */

let gui: BootedGui;
let srcDir: string;

/**
 * Open the Configure drawer to one of its input tabs (Connectors / Databases).
 * The single-layout router maps #/settings/<tab> → open the drawer over the
 * Workspace home; wait until that tab's body sentinel has rendered.
 */
async function openConfigureTab(
  page: import('@playwright/test').Page,
  tab: 'connectors' | 'databases',
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

/** The sidebar FILES section's tree host — the single file browser. */
function filesTree(page: import('@playwright/test').Page) {
  return page.locator('#src-files-tree');
}

test('the Configure drawer has Connectors / Databases tabs and NO Files tab', async ({ page }) => {
  // Files moved out of the drawer entirely — it is a left-sidebar specialty
  // section now, so a second file browser (and a second add-files button) here
  // would be a duplicate surface.
  await openConfigureTab(page, 'connectors', '#mcp-connectors-list');
  await expect(page.locator('.drawer-tab[data-tab="files"]')).toHaveCount(0);
  await expect(page.locator('.drawer-tab[data-tab="connectors"]')).toBeVisible();
  await expect(page.locator('.drawer-tab[data-tab="databases"]')).toBeVisible();
  // Each tab renders its own body.
  await page.locator('.drawer-tab[data-tab="databases"]').click();
  await expect(page.locator('#drawer-body #src-databases-list')).toBeVisible({ timeout: 5000 });
});

test('the sidebar FILES section renders a tree and a folder lazily expands one level', async ({
  page,
}) => {
  // Register the folder via the real API (what the native picker feeds).
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar', { state: 'visible' });
  const tree = filesTree(page);
  await expect(tree).toHaveCount(1);
  // Exactly one add-files control in the whole document (it is resolved by id).
  await expect(page.locator('#src-add-files')).toHaveCount(1);
  await expect(page.locator('#src-add-files-menu')).toHaveCount(1);

  // The folder root renders as a collapsed tree node.
  const folder = tree.locator('li.src-folder').first();
  await expect(folder).toBeVisible({ timeout: 5000 });
  // Children are NOT loaded until the folder row is clicked (lazy).
  await expect(tree.locator('.src-children .src-node')).toHaveCount(0);
  await folder.locator('> .src-row').click();
  // One level: the 'sub' folder + 'note.txt' file appear; 'deep.txt' does not.
  await expect(tree.getByText('note.txt', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(tree.getByText('sub', { exact: true })).toBeVisible();
  await expect(tree.getByText('deep.txt', { exact: true })).toHaveCount(0);
});

test('a file source shows ONCE with a ✕, and removing it clears both root + ingested row', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // window.confirm fallback, if showModal ever isn't present.
  page.on('dialog', (d) => void d.accept());

  const filePath = join(srcDir, 'note.txt');
  // Register a FILE source → creates BOTH a file-root AND an ingested files row at
  // the same path (the dual-representation the dedupe collapses).
  const reg = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: filePath, kind: 'file' },
  });
  expect(reg.ok()).toBeTruthy();

  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar', { state: 'visible' });
  const tree = filesTree(page);
  // De-dupe: the file appears exactly ONCE (as the root node), not twice.
  await expect(tree.getByText('note.txt', { exact: true })).toHaveCount(1, { timeout: 5000 });
  const row = tree.locator('.src-node', { hasText: 'note.txt' }).first();
  const del = row.locator('.src-del');
  await expect(del).toHaveCount(1);

  // The root + its twin row are both present before removal.
  const rootsBefore = await (await page.request.get(gui.url + '/api/sources/roots')).json();
  expect((rootsBefore.roots || []).some((r: { path: string }) => r.path.endsWith('note.txt'))).toBe(
    true,
  );

  // Click ✕ → a confirm modal appears ("Your file stays on your disk"); confirm it.
  await del.click({ force: true });
  const modal = page.locator('.modal-backdrop .modal');
  await expect(modal).toContainText('stays on your disk', { timeout: 5000 });
  await modal.locator('[data-act="ok"]').click();
  // Both representations gone (API-confirmed), the node disappears.
  await expect(tree.getByText('note.txt', { exact: true })).toHaveCount(0, { timeout: 5000 });
  const rootsAfter = await (await page.request.get(gui.url + '/api/sources/roots')).json();
  expect((rootsAfter.roots || []).some((r: { path: string }) => r.path.endsWith('note.txt'))).toBe(
    false,
  );
  // The live files row is soft-deleted (the default query returns live rows only).
  const rows = await (await page.request.get(gui.url + '/api/tables/files/rows')).json();
  expect(
    (rows.rows || []).some(
      (r: { ref_uri?: string; deleted_at?: string }) =>
        r.ref_uri && r.ref_uri.endsWith('note.txt') && !r.deleted_at,
    ),
  ).toBe(false);
  // The on-disk file is untouched.
  const st = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: filePath, kind: 'file' },
  });
  expect(st.ok()).toBeTruthy(); // re-registerable ⇒ still on disk
  expect(pageErrors).toEqual([]);
});

test('an empty workspace shows the FILES empty state and no table entries', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar', { state: 'visible' });
  await expect(filesTree(page).locator('.src-empty')).toHaveText(
    'No files yet — add a file or folder to get started.',
    { timeout: 5000 },
  );
  // files itself is never listed among the tables — it has this section instead.
  await expect(page.locator('.nav-table-item[data-table="files"]')).toHaveCount(0);
  // …and the legacy notes table is gone from the payload entirely.
  await expect(page.locator('.nav-table-item[data-table="notes"]')).toHaveCount(0);
});

test('the MCP Connectors tab hosts the table + add form inline (no dialog)', async ({ page }) => {
  await openConfigureTab(page, 'connectors', '#mcp-connectors-list');
  await expect(page.locator('#mcp-connectors-form')).toContainText('Add an MCP connector');
  await expect(page.locator('#connectors-dialog')).toHaveCount(0);
});

test('the Files table still opens as a SQL runner when addressed directly', async ({ page }) => {
  // files is hidden from the table nav (it has its own sidebar section) but stays a
  // fully registered, routable table — a direct #/w/table/files link still opens the
  // uniform SQL runner. The default query shows LIVE rows only (files is
  // soft-deletable), so a soft-deleted/merged file doesn't linger in the view.
  await page.goto(gui.url + '#/w/table/files');
  await expect(page.locator('.sql-runner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#sql-editor')).toHaveValue(
    /select \* from "files" where deleted_at is null limit 100/i,
  );
  await expect(page.locator('#sql-run')).toBeVisible();
});

// The Databases tab renders its whole panel inline (the left-sliding
// Connect-a-database drawer is gone): the connected-databases area and the
// add form both live in the tab body, full-width.
test('the Databases tab hosts the connect form inline (no dialog)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await openConfigureTab(page, 'databases', '#src-databases-list');

  // The inline add form renders in its own mount (a sibling of the table) so a
  // background table refresh can't wipe it. It carries the Postgres fields.
  const form = page.locator('#db-form-host');
  await expect(form.getByText('Add a database')).toBeVisible({ timeout: 5000 });
  await expect(form.locator('#db-host')).toBeVisible();
  await expect(form.locator('#db-name')).toBeVisible();
  await expect(form.locator('#db-ok')).toBeVisible();

  // The old side-drawer is gone, and the tab runs full-width (dm-wide on the body).
  await expect(page.locator('#db-connect-dialog')).toHaveCount(0);
  await expect(page.locator('#settings-drawer .drawer-body.dm-wide')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
