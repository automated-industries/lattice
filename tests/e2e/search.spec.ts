import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('the header search bar finds a row and opens it', async ({ page }) => {
  await createRow(gui.url, 'items', { name: 'Kangaroo Widget' });
  await createRow(gui.url, 'items', { name: 'Ordinary Thing' });

  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();

  const input = page.locator('#search-input');
  await input.fill('kangaroo');

  // The grouped results dropdown appears with the matching hit.
  const results = page.locator('#search-results');
  await expect(results).toBeVisible();
  const hit = results.locator('.search-hit').first();
  await expect(hit).toBeVisible();

  // Clicking the hit opens the row in the current mode (simple → #/fs/,
  // advanced → #/objects/) and dismisses the dropdown.
  await hit.click();
  await expect(page).toHaveURL(/#\/(fs|objects)\/items\//);
  await expect(results).toBeHidden();
});

test('a blank query shows no dropdown', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();
  await page.locator('#search-input').fill('k'); // below the 2-char threshold
  await expect(page.locator('#search-results')).toBeHidden();
});
