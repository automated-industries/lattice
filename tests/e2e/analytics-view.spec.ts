import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers';

// The app's two views: Analytics (#/analytics*, the landing surface — the
// Dashboards sidebar, tab strip, and the docked assistant) and Configure
// (every other route — the three-column workspace). The header shows exactly
// one trigger per view and each side remembers its last location.

let gui: BootedGui;

test.beforeAll(async () => {
  gui = await bootGui();
});
test.afterAll(async () => gui.close());

test('boot lands on the Analytics view with its empty states', async ({ page }) => {
  await page.goto(gui.url);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('body')).toHaveClass(/view-analytics/);
  // Analytics is showing; Configure is parked hidden.
  await expect(page.locator('#ask-dock')).toBeVisible();
  await expect(page.locator('.layout')).toBeHidden();
  // No dashboards yet — both empty states, and an empty tab strip.
  await expect(page.locator('#dash-list')).toContainText('No dashboards yet');
  await expect(page.locator('.analytics-home h1')).toHaveText('Ask your company anything');
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(0);
});

test('the header triggers round-trip and restore each side’s last location', async ({ page }) => {
  await page.goto(gui.url);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');

  // → Configure (its default home), then drill somewhere specific.
  await page.locator('#configure-trigger').click();
  await expect(page.locator('.layout')).toBeVisible();
  await page.locator('.tab[data-key="tables"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');

  // → Analytics and back: Configure reopens on #/tables, not its home.
  await page.locator('#ask-lattice-trigger').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('.layout')).toBeHidden();
  await page.locator('#configure-trigger').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('.layout')).toBeVisible();
});

test('browser Back walks across a view flip', async ({ page }) => {
  await page.goto(gui.url);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await page.locator('#configure-trigger').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');

  await page.locator('#nav-back-btn').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('body')).toHaveClass(/view-analytics/);
  await page.locator('#nav-fwd-btn').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await expect(page.locator('.layout')).toBeVisible();
});

test('a Configure deep link boots straight into Configure (no redirect)', async ({ page }) => {
  await page.goto(gui.url + '#/graph');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('body')).not.toHaveClass(/view-analytics/);
  await expect(page.locator('.layout')).toBeVisible();
});
