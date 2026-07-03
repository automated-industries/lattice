import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

/**
 * 5.0 — the header search BOX was removed: it duplicated the assistant surface
 * (both routed a query to the assistant). In its place the header carries
 * Back / Forward page-navigation buttons next to Undo / Redo. Search happens
 * through the assistant panel only.
 */

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('the header has no search box — the assistant is the single search surface', async ({
  page,
}) => {
  await page.goto(gui.url + '#/folders');
  await expect(page.locator('nav.sidebar')).toBeVisible();
  await expect(page.locator('#search-input')).toHaveCount(0);
  await expect(page.locator('#search-results')).toHaveCount(0);
  // The assistant trigger is present — the one way to ask.
  await expect(page.locator('#ask-lattice-trigger')).toBeVisible();
});

test('Back / Forward buttons walk the page-navigation history, next to Undo/Redo', async ({
  page,
}) => {
  await page.goto(gui.url + '#/folders');
  await expect(page.locator('nav.sidebar')).toBeVisible();
  const back = page.locator('#nav-back-btn');
  const fwd = page.locator('#nav-fwd-btn');
  await expect(back).toBeVisible();
  await expect(fwd).toBeVisible();
  // Undo/Redo live in the same control group.
  await expect(page.locator('.history-controls #undo-btn')).toBeVisible();
  await expect(page.locator('.history-controls #redo-btn')).toBeVisible();

  // Navigate: Objects → Tables, then Back returns to Objects, Forward to Tables.
  await page.locator('.tab[data-key="tables"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await back.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/folders');
  await fwd.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
});
