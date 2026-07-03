import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 5.0 — the center "Model" header has exactly three permanent (non-closable)
 * tabs: Objects (#/ — the default), Graph (#/graph), and Tables (#/tables).
 * Records and object pages are NOT tabs — they render in the content area below,
 * and the SECTION you drilled in from stays highlighted (the section is encoded
 * in the hash prefix: #/fs/* = Objects, #/graph/* = Graph, #/tables/* = Tables).
 * The non-empty filter shows objects with rows.
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

test('Objects + Graph + Tables are the only tabs; all permanent; Objects is the default', async ({
  page,
}) => {
  await page.goto(gui.url + '#/');
  const objectsTab = page.locator('.tab[data-key="folders"]');
  const graphTab = page.locator('.tab[data-key="graph"]');
  const tablesTab = page.locator('.tab[data-key="tables"]');
  await expect(objectsTab).toBeVisible({ timeout: 5000 });
  await expect(graphTab).toBeVisible();
  await expect(tablesTab).toBeVisible();
  await expect(objectsTab).toHaveText(/objects/i); // "Folders" was renamed
  await expect(objectsTab).toHaveClass(/active/); // the landing view
  // Exactly three tabs, none closable.
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(3);
  await expect(page.locator('.tab .tab-close')).toHaveCount(0);
  // The Model header carries the "Model" column label.
  await expect(page.locator('#tabstrip .col-header-text')).toHaveText(/model/i);
  // Graph renders into the center when its tab is clicked.
  await graphTab.click();
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});

test('the Tables tab switches the Model view to the tiered explorer', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await page.locator('.tab[data-key="tables"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
  await expect(page.locator('.model-tables-view .mt')).toBeVisible({ timeout: 5000 });
  // Switching back to Graph restores the graph.
  await page.locator('.tab[data-key="graph"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});

test('the non-empty filter shows objects with rows', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // `items` has a row → its node is present in the graph. Assert topology (the node
  // exists), not the force-graph reveal animation (slow in headless CI; covered by
  // graph-layout.spec).
  await expect(page.locator('g.gnode[data-id="items"]')).toHaveCount(1, { timeout: 10000 });
});

test('object + record pages are not tabs; the drill-in SECTION stays highlighted', async ({
  page,
}) => {
  await page.goto(gui.url + '#/graph');
  // Clicking an object node drills into that entity's GRAPH (#/graph/<obj>) —
  // no extra tab, and the GRAPH section stays lit (sticky sections).
  await page.locator('g.gnode[data-id="items"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph/items');
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(3);
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/);
  // A record opened under the Objects namespace (#/fs/*) lights Objects…
  await page.evaluate((id) => {
    window.location.hash = '#/fs/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(itemId);
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(3);
  await expect(page.locator('.tab[data-key="folders"]')).toHaveClass(/active/);
  // …and the SAME record under the Tables namespace (#/tables/*) lights Tables.
  await page.evaluate((id) => {
    window.location.hash = '#/tables/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(itemId);
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
});

// Regression: a Tables-section object page (the "Open object" target) is rooted
// at Tables — its breadcrumb returns to the Tables explorer.
test('back from a Tables object page returns to the Tables explorer', async ({ page }) => {
  await page.goto(gui.url + '#/tables/items');
  // The object page — the table's rows, Tables tab lit.
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
  // Click the "Tables" crumb (the breadcrumb is rooted at the Tables section).
  await page.locator('.fs-crumbs a', { hasText: 'Tables' }).first().click();
  // It must land on the Tables explorer.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
  await expect(page.locator('.model-tables-view .mt')).toBeVisible({ timeout: 5000 });
});
