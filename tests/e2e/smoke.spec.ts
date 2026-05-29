import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('GUI boots and renders the entity sidebar', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();
  // The seeded `items` entity should appear as a sidebar card.
  await expect(page.getByText('items', { exact: false }).first()).toBeVisible();
});
