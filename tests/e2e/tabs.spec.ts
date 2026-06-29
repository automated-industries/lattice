import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 5.0 — the center "Model" header has exactly two permanent (non-closable) tabs:
 * Graph and Tables. They switch the Model view between the force-directed brain
 * graph (#/graph) and the tiered Tables explorer (#/tables). Records and object
 * pages are NOT tabs — they render in the content area below (reached by drilling
 * a node), and a breadcrumb navigates back to the Graph. The non-empty filter
 * shows only objects that have rows.
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
  // `items` has a row → its node appears.
  await expect(page.locator('g.gnode[data-id="items"]')).toBeVisible({ timeout: 5000 });
});

test('opening a record renders in the content with NO tab (records are not tabs)', async ({
  page,
}) => {
  await page.goto(gui.url + '#/graph');
  // Clicking an object node navigates into the object's page — still no extra tab.
  await page.locator('g.gnode[data-id="items"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/items/);
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(2);
  // Opening the record (row detail) renders in the content; the strip still has
  // only the two model tabs, and neither is highlighted while off the model views.
  await page.evaluate((id) => {
    window.location.hash = '#/fs/items/' + id;
  }, itemId);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(itemId);
  await expect(page.locator('#tabstrip-tabs .tab')).toHaveCount(2);
  await expect(page.locator('.tab.active')).toHaveCount(0);
});

// Regression: the object page's back breadcrumb must return to the Graph, not the
// object's table/list view (it used to href the list route).
test('back from an object page returns to the Graph, not the list view', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // Into the object page — which defaults to the provenance view.
  await page.locator('g.gnode[data-id="items"]').click();
  await expect(page.locator('#prov-mount')).toBeVisible({ timeout: 5000 });
  // Click the "← Graph" breadcrumb.
  await page.locator('.breadcrumb').click();
  // It must land on the Graph — NOT the list view.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/);
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});
