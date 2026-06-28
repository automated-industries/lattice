import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 4.3 — center tab strip + brain graph. The graph is the permanent, non-closable
 * default view AND the single exploration surface: clicking objects / drilling
 * folders navigates the graph tab itself (no per-object tabs). Only opening a
 * RECORD spawns a closable tab; re-opening it dedups; closing it falls back to
 * the graph. The non-empty filter shows only objects that have rows.
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
  await expect(page.locator('g.gnode[data-id="items"]')).toBeVisible({ timeout: 5000 });
});

test('exploring objects stays in the graph tab; opening a record opens a closable tab (dedups)', async ({
  page,
}) => {
  await page.goto(gui.url + '#/graph');
  // Clicking an object node navigates the SAME graph tab into the object's page —
  // no per-object tab is spawned (exploration is single-tab).
  await page.locator('g.gnode[data-id="items"]').click();
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/, { timeout: 5000 });
  await expect(page.locator('.tab[data-key^="table:"]')).toHaveCount(0);
  // The object page is the provenance view; List view reaches the rows. Opening a
  // record (a row tile) spawns its own closable tab.
  await page.locator('#pv-view-list').click();
  const tile = page.locator('.fs-tile').first();
  await expect(tile).toBeVisible({ timeout: 5000 });
  await tile.click();
  const recordTab = page.locator('.tab[data-key^="item:items:"]');
  await expect(recordTab).toBeVisible({ timeout: 5000 });
  await expect(recordTab).toHaveClass(/active/);
  await expect(recordTab.locator('.tab-close')).toHaveCount(1);
  // Re-opening the same record dedups (no second tab).
  await page.locator('.tab[data-key="graph"]').click();
  await page.locator('.fs-tile').first().click();
  await expect(page.locator('.tab[data-key^="item:items:"]')).toHaveCount(1);
});

test('clicking a graph node navigates the single graph tab (no new tab)', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  await page.locator('g.gnode[data-id="items"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/items/);
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/, { timeout: 5000 });
  await expect(page.locator('.tab[data-key^="table:"]')).toHaveCount(0);
});

test('closing a record tab falls back to the Brain Graph', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  await page.locator('g.gnode[data-id="items"]').click(); // into the object page
  await page.locator('#pv-view-list').click(); // List view → the row grid
  const tile = page.locator('.fs-tile').first();
  await expect(tile).toBeVisible({ timeout: 5000 });
  await tile.click(); // open the record → a closable tab
  const recordTab = page.locator('.tab[data-key^="item:items:"]');
  await expect(recordTab).toHaveClass(/active/, { timeout: 5000 });
  await recordTab.locator('.tab-close').click();
  await expect(page.locator('.tab[data-key^="item:items:"]')).toHaveCount(0);
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/);
});

// Regression: the object page's back breadcrumb must return to the Brain Graph,
// not the object's table/list view (it used to href the list route).
test('back from an object page returns to the Brain Graph, not the list view', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  // Into the object page — which defaults to the provenance view.
  await page.locator('g.gnode[data-id="items"]').click();
  await expect(page.locator('#pv-view-list')).toBeVisible({ timeout: 5000 });
  // Click the "← Brain Graph" breadcrumb.
  await page.locator('.breadcrumb').click();
  // It must land on the Brain Graph — NOT the list view.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('.tab[data-key="graph"]')).toHaveClass(/active/);
  await expect(page.locator('.brain-graph #graph-mount')).toBeVisible();
});
