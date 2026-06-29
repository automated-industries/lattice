import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Regression (3.3.5): opening the settings drawer via a `#/settings/*` hash (e.g.
 * a "User Settings" link) left the URL on that hash after the drawer was closed.
 * Because renderRoute reopens the drawer for a `#/settings/*` hash, any later
 * re-render — submitting a chat message, a live data refresh — popped the panel
 * back open on its own. Closing the drawer now resets the hash to the dashboard,
 * so the URL always reflects what's on screen and the panel never self-reopens.
 */
let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('closing the settings drawer clears the #/settings URL and it does not reopen on a re-render', async ({
  page,
}) => {
  // Open via the settings hash (the link path that caused the bug).
  await page.goto(gui.url + '#/settings/user-config');
  await expect(page.locator('#settings-drawer')).toBeVisible();

  // Close it. The drawer hides via removing its `open` class (a CSS transform),
  // not display:none, so assert the class — not toBeHidden.
  await page.locator('#drawer-close').click();
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/\bopen\b/);

  // The URL no longer says settings — it reflects the dashboard now on screen.
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('/settings/');

  // A re-render (here: a hashchange-driven renderRoute, the same entry point a
  // chat submit / live refresh hits) must NOT reopen the drawer.
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await page.waitForTimeout(150);
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/\bopen\b/);

  // And a live data mutation (feed → soft refresh → renderRoute) also must not
  // pop it open — this is the exact "type in chat, panel reopens" symptom.
  await createRow(gui.url, 'items', { name: 'x' });
  await page.waitForTimeout(400);
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/\bopen\b/);
});

test('a live refresh updates the middle pane in place without flashing a loading frame', async ({
  page,
}) => {
  for (let i = 0; i < 8; i++) await createRow(gui.url, 'items', { name: 'Item ' + String(i) });
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();
  // Land on the items object page (a stable view to refresh).
  await page.evaluate(() => {
    window.location.hash = '#/fs/items';
  });
  await expect(page.locator('.view-header')).toBeVisible({
    timeout: 5000,
  });

  // Slow the refresh's data fetches so a soft refresh is observable while in flight.
  await page.route('**/api/entities', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.route('**/api/provenance**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.route('**/api/tables/**/rows**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });

  // Trigger a live refresh via a server-side mutation (feed → debounced soft
  // afterMutation → renderRoute({soft:true})).
  await createRow(gui.url, 'items', { name: 'Live row' });

  // Across the slow refresh window the middle pane must NOT flash to the loading
  // spinner — the existing tiles stay on screen and are swapped only when ready.
  for (let i = 0; i < 6; i++) {
    expect(await page.locator('#content .route-loading').count()).toBe(0);
    expect(await page.locator('.view-header').count()).toBeGreaterThan(0);
    await page.waitForTimeout(120);
  }
});
