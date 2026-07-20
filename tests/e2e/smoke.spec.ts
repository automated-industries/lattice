import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;

test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('GUI boots and renders the single-layout workspace shell', async ({ page }) => {
  await page.goto(gui.url + '#/');
  // One 3-column layout: sidebar │ center Workspace │ Ask Gladys dock — all visible,
  // no view flip.
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#ask-dock')).toBeVisible();
  // The sidebar carries the Dashboards + Tables nav sections (Files is now a table
  // in the LATTICE schema under Tables, not its own section).
  await expect(page.locator('.section-toggle[data-group="nav-tables"]')).toBeVisible();
  await expect(page.locator('.section-toggle[data-group="nav-files"]')).toHaveCount(0);
});
