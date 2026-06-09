import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('the header search bar routes the query to the assistant rail', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  const input = page.locator('#search-input');
  await input.fill('where are my kangaroos');
  await input.press('Enter');

  // The query is handed to the assistant as a chat turn (a user bubble appears
  // in the rail) instead of running a plain-text results dropdown.
  await expect(page.locator('#rail-feed .chat-bubble.user').last()).toContainText(
    'where are my kangaroos',
  );
  // The legacy results dropdown is gone, and the box clears after submitting.
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(input).toHaveValue('');
});

test('typing no longer opens a results dropdown', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();
  await page.locator('#search-input').fill('kang');
  await expect(page.locator('#search-results')).toBeHidden();
});
