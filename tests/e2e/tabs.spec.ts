import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Single-layout reframe — the old two-view "Model" area (a fixed Objects / Graph /
 * Tables tab strip) is GONE. The schema surfaces live in the Configure drawer, where
 * Data Model (the tiered Tables explorer, full width) and Graph (the brain graph, full
 * width) are now their OWN top-level Configure tabs — no in-Data-Model subtabs. A
 * table's rows open as a single Workspace table tab (#/w/table/<name>); every legacy
 * record namespace (#/fs/*, #/tables/*, #/graph/<obj>) converges onto that ONE tab.
 *
 * These tests re-express the original intents on the new surfaces:
 *  - Configure exposes Data Model and Graph as separate tabs.
 *  - Data Model shows the tiered explorer full width; Graph shows the brain graph.
 *  - A non-empty object appears as a node in the graph.
 *  - Record drill-ins never spawn a second tab; legacy namespaces converge.
 *  - The Data Model explorer's "Open object" opens the table's rows as a Workspace tab.
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

// Navigate (in-page, no reload — keeps state.entities) to a Configure-drawer route and
// wait for the drawer to open on the expected tab. `#/tables` / `#/settings/data-model`
// open the Data Model tab; `#/graph` opens the Graph tab.
async function openConfigure(
  page: import('@playwright/test').Page,
  hash: '#/tables' | '#/graph' | '#/settings/data-model',
  activeTab: 'datamodel' | 'graph',
) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForSelector('#settings-drawer.open', { timeout: 10000 });
  await page.waitForSelector(`.drawer-tab[data-tab="${activeTab}"].active`, { timeout: 10000 });
}

test('Configure exposes Data Model and Graph as separate top-level tabs', async ({ page }) => {
  await bootReady(page);
  await openConfigure(page, '#/settings/data-model', 'datamodel');
  // Both Data Model and Graph are peer Configure tabs (not subtabs of one another).
  await expect(page.locator('.drawer-tab[data-tab="datamodel"]')).toBeVisible();
  await expect(page.locator('.drawer-tab[data-tab="graph"]')).toBeVisible();
  // No in-Data-Model subtab strip survives.
  await expect(page.locator('.dm-subtabs')).toHaveCount(0);
  // Data Model lands on the tiered explorer, full width.
  await expect(page.locator('.drawer-body.dm-wide #model-tables-host .mt')).toBeVisible({
    timeout: 5000,
  });
});

test('the Data Model tab shows the explorer; the Graph tab shows the brain graph', async ({
  page,
}) => {
  await bootReady(page);
  await openConfigure(page, '#/tables', 'datamodel');
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
  // The Graph tab is a peer Configure tab — clicking it swaps to the brain graph.
  await page.locator('.drawer-tab[data-tab="graph"]').click();
  await expect(page.locator('.drawer-tab[data-tab="graph"].active')).toBeVisible();
  await expect(page.locator('.graph-tab .brain-graph #graph-mount')).toBeVisible();
  // Link / Merge controls are present on the graph.
  await expect(page.locator('#wm-wire-btn')).toBeVisible();
  await expect(page.locator('#wm-merge-btn')).toBeVisible();
  // …and back to Data Model restores the explorer.
  await page.locator('.drawer-tab[data-tab="datamodel"]').click();
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
});

test('a non-empty object appears as a node in the graph', async ({ page }) => {
  await bootReady(page);
  await openConfigure(page, '#/graph', 'graph');
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

// Regression: the Data Model explorer and the Workspace object page are wired together —
// the explorer's "Open object" opens that table's rows as a Workspace table tab (the
// single-layout replacement for the old Tables-section object page).
test('the Data Model explorer "Open object" opens the table rows as a Workspace tab', async ({
  page,
}) => {
  await bootReady(page);
  await openConfigure(page, '#/tables', 'datamodel');
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
