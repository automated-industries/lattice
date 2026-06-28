import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Regression: navigating between views must paint the new view's FRAME (a
 * loading state) immediately — it must NOT leave the previous view on screen
 * while the new view's row data loads. A slow/large fetch (a big local table or
 * a cloud workspace) previously left the old view frozen on screen with no
 * feedback, because each renderer set `content.innerHTML` only AFTER its fetch
 * resolved. This drives a REAL browser and slows the row API so the freeze is
 * deterministic, independent of machine speed.
 */
let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

const ROW_DELAY_MS = 800;

test('navigation paints the new view immediately even when data is slow', async ({ page }) => {
  for (let i = 0; i < 20; i++) await createRow(gui.url, 'items', { name: 'Item ' + String(i) });

  // Slow the object-page (provenance) + row fetches, to simulate a large local
  // table / a cloud open. (Entities/dashboard are NOT delayed, so the shell still
  // boots normally.)
  await page.route('**/api/provenance**', async (route) => {
    await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
    await route.continue();
  });
  await page.route('**/api/tables/**/rows**', async (route) => {
    await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
    await route.continue();
  });

  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // Navigate to the items object page (provenance). A loading frame must appear
  // well before the 800ms data — the view never blocks on the fetch.
  await page.evaluate(() => {
    window.location.hash = '#/fs/items';
  });
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
  // …then the provenance view fills in.
  await expect(page.locator('#prov-mount')).toBeVisible({ timeout: 5000 });

  // Open a record (List view → a row tile → detail): the nav must paint the new
  // frame immediately (a loading state), not freeze on the slow row fetch.
  await page.locator('#pv-view-list').click();
  const tile = page.locator('.fs-tile').first();
  await expect(tile).toBeVisible({ timeout: 5000 });
  await tile.click();
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
  // …and the item content eventually loads.
  await expect(page.locator('.fs-doc')).toBeVisible({ timeout: 5000 });

  // The GUI stays responsive: navigating again while data is still in flight
  // immediately repaints (no freeze, no stale view).
  await page.evaluate(() => {
    window.location.hash = '#/fs/items';
  });
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
});
