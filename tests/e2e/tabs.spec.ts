import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 4.3 — center tab strip + brain graph. The graph is the permanent, non-closable
 * default view; opening an object opens a closable tab; the non-empty filter
 * shows only objects that have rows; re-opening dedups; closing the active tab
 * falls back to a neighbor (the graph).
 */

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
  // One row so the `items` object is non-empty and appears on the brain graph.
  await createRow(gui.url, 'items', { name: 'first item' });
});
test.afterEach(async () => {
  await gui.close();
});

test('Brain Graph is the permanent default tab and cannot be closed', async ({ page }) => {
  await page.goto(gui.url + '#/');
  const graphTab = page.locator('.tab[data-key="graph"]');
  await expect(graphTab).toBeVisible({ timeout: 5000 });
  await expect(graphTab).toHaveClass(/active/);
  // No close control on the permanent tab.
  await expect(graphTab.locator('.tab-close')).toHaveCount(0);
  // The graph itself renders into the center.
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});

test('the non-empty filter shows objects with rows', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // `items` has a row → its node appears.
  await expect(page.locator('g.gnode[data-table="items"]')).toBeVisible({ timeout: 5000 });
});

test('clicking a sidebar object opens a closable tab and re-clicking dedups', async ({ page }) => {
  await page.goto(gui.url + '#/');
  const itemsLink = page.locator('#object-nav a[data-route="#/fs/items"]');
  await itemsLink.click();
  const itemsTab = page.locator('.tab[data-key="table:items"]');
  await expect(itemsTab).toBeVisible({ timeout: 5000 });
  await expect(itemsTab).toHaveClass(/active/);
  await expect(itemsTab.locator('.tab-close')).toHaveCount(1);
  // Re-clicking the same sidebar item activates the existing tab — no duplicate.
  await page.locator('.tab[data-key="graph"]').click();
  await itemsLink.click();
  await expect(page.locator('.tab[data-key="table:items"]')).toHaveCount(1);
});

test('clicking a graph node opens that object’s tab', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  await page.locator('g.gnode[data-table="items"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/items/);
  await expect(page.locator('.tab[data-key="table:items"]')).toBeVisible({ timeout: 5000 });
});

test('closing the active tab falls back to the Brain Graph', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await page.locator('#object-nav a[data-route="#/fs/items"]').click();
  const itemsTab = page.locator('.tab[data-key="table:items"]');
  await expect(itemsTab).toHaveClass(/active/, { timeout: 5000 });
  await itemsTab.locator('.tab-close').click();
  await expect(page.locator('.tab[data-key="table:items"]')).toHaveCount(0);
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/);
});
