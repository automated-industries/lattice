import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('GUI boots and renders the Sources sidebar', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();
  // The default sidebar is now Sources (Files / Artifacts / Connectors).
  await expect(page.locator('#sources-nav').getByText('Files', { exact: true })).toBeVisible();
});
