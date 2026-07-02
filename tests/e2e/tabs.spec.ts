import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 5.0 — the center "Model" header has exactly two permanent (non-closable) tabs:
 * Graph and Tables. They switch the Model view between the force-directed brain
 * graph (#/graph) and the tiered Tables explorer (#/tables). Records and object
 * pages are NOT tabs — they render in the content area below (reached by drilling
 * a node), keep the Tables tab highlighted, and an object page's breadcrumb
 * returns to the Tables explorer. The non-empty filter shows objects with rows.
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

test('Graph + Tables are the only tabs; both permanent; Graph is the default', async ({ page }) => {
  await page.goto(gui.url + '#/');
  const graphTab = page.locator('.tab[data-key="graph"]');
  const tablesTab = page.locator('.tab[data-key="tables"]');
  await expect(graphTab).toBeVisible({ timeout: 5000 });
  await expect(tablesTab).toBeVisible();
  await expect(graphTab).toHaveClass(/active/);
  // Exactly two tabs, neither closable.
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(2);
  await expect(page.locator('.tab .tab-close')).toHaveCount(0);
  // The Model header carries the "Model" column label.
  await expect(page.locator('#tabstrip .col-header-text')).toHaveText(/model/i);
  // The graph itself renders into the center.
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

test('object + record pages are not tabs but keep the Tables tab highlighted', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // Clicking an object node navigates into the object's page — no extra tab, and
  // the object page belongs to the Tables view (Tables tab stays lit).
  await page.locator('g.gnode[data-id="items"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/items/);
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(2);
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
  // Opening the record (row detail) renders in the content; still only the two
  // model tabs, and the Tables tab stays highlighted.
  await page.evaluate((id) => {
    window.location.hash = '#/fs/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(itemId);
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(2);
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
});

// Regression: the object page's back breadcrumb returns to the Tables explorer
// (the object page is the single table view reached from Tables).
test('back from an object page returns to the Tables explorer', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // Into the object page — the table's rows.
  await page.locator('g.gnode[data-id="items"]').click();
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });
  // Click the "Tables" crumb (the breadcrumb is rooted at Tables).
  await page.locator('.fs-crumbs a', { hasText: 'Tables' }).first().click();
  // It must land on the Tables explorer.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('.tab[data-key="tables"]')).toHaveClass(/active/);
  await expect(page.locator('.model-tables-view .mt')).toBeVisible({ timeout: 5000 });
});
