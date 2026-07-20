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
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();
  await expect(page.locator('#search-input')).toHaveCount(0);
  await expect(page.locator('#search-results')).toHaveCount(0);
  // The persistent Ask Gladys dock is the single ask surface — always visible,
  // no toggle. (The old header Ask trigger is gone in the single layout.)
  await expect(page.locator('#ask-dock')).toBeVisible();
});

test('Back / Forward buttons walk the page-navigation history, next to Undo/Redo', async ({
  page,
}) => {
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();
  const back = page.locator('#nav-back-btn');
  const fwd = page.locator('#nav-fwd-btn');
  await expect(back).toBeVisible();
  await expect(fwd).toBeVisible();
  // Undo/Redo live in the same control group.
  await expect(page.locator('.history-controls #undo-btn')).toBeVisible();
  await expect(page.locator('.history-controls #redo-btn')).toBeVisible();

  // Navigate between two Workspace locations (Questions → the items table tab),
  // then Back returns to the first and Forward to the second — the buttons walk
  // the app-managed page-navigation history.
  await page.evaluate(() => {
    location.hash = '#/questions';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/questions');
  await page.evaluate(() => {
    location.hash = '#/w/table/items';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items');
  await back.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/questions');
  await fwd.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/items');
});
