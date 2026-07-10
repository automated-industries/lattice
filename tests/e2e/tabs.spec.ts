import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Single-layout reframe — the old two-view "Model" area (a fixed Objects / Graph /
 * Tables tab strip with sticky per-section highlighting) is GONE. The schema
 * surfaces now live in the Configure drawer's Data Model tab, which has two
 * subtabs: Tables (the tiered explorer) and Graph (the brain graph). The old
 * Objects/Folders index view was removed entirely; a table's rows are opened as a
 * single Workspace table tab (#/w/table/<name>), and every legacy record namespace
 * (#/fs/*, #/tables/*, #/graph/<obj>) converges onto that ONE tab.
 *
 * These tests re-express the original intents on the new surfaces:
 *  - Data Model exposes exactly the Tables + Graph subtabs, Tables default.
 *  - Switching subtabs swaps the explorer ⇄ graph.
 *  - A non-empty object appears as a node in the graph.
 *  - Record drill-ins never spawn a second tab; legacy namespaces converge.
 *  - The drawer explorer's "Open object" opens the table's rows as a Workspace tab.
 */

let gui: BootedGui;
let itemId: string;
test.beforeEach(async () => {
  gui = await bootGui();
  // One row so the `items` object is non-empty and appears on the brain graph.
  const r = (await createRow(gui.url, 'items', { name: 'first item' })) as { id: string };
  itemId = r.id;
});
test.afterEach(async () => {
  await gui.close();
});

// Boot into the single layout and wait until entities are loaded (the Tables nav
// section renders a row per table from state.entities only after boot completes).
async function bootReady(page: import('@playwright/test').Page) {
  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar');
  await page.waitForSelector('.nav-table-item[data-table="items"]', {
    state: 'attached',
    timeout: 15000,
  });
}

// Navigate (in-page, no reload — keeps state.entities) to a Configure-drawer route
// and wait for the drawer to open. `#/tables` / `#/graph` open Data Model to that
// subtab; `#/settings/data-model` opens Data Model with no forced subtab (default).
async function openDataModel(
  page: import('@playwright/test').Page,
  hash: '#/tables' | '#/graph' | '#/settings/data-model',
) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForSelector('#settings-drawer.open', { timeout: 10000 });
  await page.waitForSelector('.drawer-tab[data-tab="datamodel"].active', { timeout: 10000 });
}

test('Data Model exposes the Tables + Graph subtabs; Tables is the default; Graph renders on click', async ({
  page,
}) => {
  await bootReady(page);
  // Open Data Model with no forced subtab — the default subtab must be Tables.
  await openDataModel(page, '#/settings/data-model');
  const tablesSub = page.locator('.dm-subtabs .tab[data-dmsub="tables"]');
  const graphSub = page.locator('.dm-subtabs .tab[data-dmsub="graph"]');
  await expect(tablesSub).toBeVisible({ timeout: 5000 });
  await expect(graphSub).toBeVisible();
  await expect(tablesSub).toHaveText(/tables/i);
  await expect(graphSub).toHaveText(/graph/i);
  await expect(tablesSub).toHaveClass(/active/); // the landing subtab
  // Exactly two subtabs, neither closable (the drawer surface has no tab-close).
  await expect(page.locator('.dm-subtabs .tab')).toHaveCount(2);
  await expect(page.locator('.dm-subtabs .tab .tab-close')).toHaveCount(0);
  // Graph renders into the drawer body when its subtab is clicked.
  await graphSub.click();
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});

test('the Tables subtab shows the tiered explorer; Graph restores the graph', async ({ page }) => {
  await bootReady(page);
  await openDataModel(page, '#/tables');
  await expect(page.locator('.dm-subtabs .tab[data-dmsub="tables"]')).toHaveClass(/active/);
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
  // Switching to Graph swaps the explorer for the brain graph.
  await page.locator('.dm-subtabs .tab[data-dmsub="graph"]').click();
  await expect(page.locator('.dm-subtabs .tab[data-dmsub="graph"]')).toHaveClass(/active/);
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
  // …and back to Tables restores the explorer.
  await page.locator('.dm-subtabs .tab[data-dmsub="tables"]').click();
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
});

test('a non-empty object appears as a node in the graph', async ({ page }) => {
  await bootReady(page);
  await openDataModel(page, '#/graph');
  // `items` has a row → its node is present in the graph. Assert topology (the node
  // exists), not the force-graph reveal animation (slow in headless CI; covered by
  // graph-layout.spec).
  await expect(page.locator('#graph-mount g.gnode[data-id="items"]')).toHaveCount(1, {
    timeout: 10000,
  });
});

test('record drill-ins never spawn a second tab; legacy namespaces converge on one Workspace tab', async ({
  page,
}) => {
  await bootReady(page);
  // A record opened under the legacy Objects namespace (#/fs/*) normalizes to the
  // single Workspace table tab #/w/table/items/<id> — a record is NOT its own tab.
  await page.evaluate((id) => {
    window.location.hash = '#/fs/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items/' + itemId);
  const itemsTab = page.locator('#antabstrip-tabs .tab[data-key="table:items"]');
  await expect(itemsTab).toHaveCount(1);
  await expect(itemsTab).toHaveClass(/active/);
  // The SAME record under the legacy Tables namespace (#/tables/*) converges on the
  // SAME tab — no duplicate, still exactly one `table:items` tab.
  await page.evaluate((id) => {
    window.location.hash = '#/tables/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items/' + itemId);
  await expect(page.locator('#antabstrip-tabs .tab[data-key="table:items"]')).toHaveCount(1);
  // A graph-node drill-in (legacy #/graph/<obj>) also normalizes onto the table tab.
  await page.evaluate(() => {
    window.location.hash = '#/graph/items';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items');
  await expect(page.locator('#antabstrip-tabs .tab[data-key="table:items"]')).toHaveClass(/active/);
});

// Regression: the drawer Tables explorer and the Workspace object page are wired
// together — the explorer's "Open object" opens that table's rows as a Workspace
// table tab (the single-layout replacement for the old Tables-section object page).
test('the Tables explorer "Open object" opens the table rows as a Workspace tab', async ({
  page,
}) => {
  await bootReady(page);
  await openDataModel(page, '#/tables');
  // Open the `items` card's detail panel, then its "Open object →" link.
  await page.locator('#model-tables-host .mt-card[data-table="items"]').click();
  const openLink = page.locator('#mt-detail .mt-detail-open[href="#/w/table/items"]');
  await expect(openLink).toBeVisible({ timeout: 5000 });
  await openLink.click();
  // It lands on the single Workspace table tab showing the table's rows.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items');
  await expect(page.locator('#antabstrip-tabs .tab[data-key="table:items"]')).toHaveClass(/active/);
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });
});
