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
  let firstItemId = '';
  for (let i = 0; i < 20; i++) {
    const r = (await createRow(gui.url, 'items', { name: 'Item ' + String(i) })) as { id: string };
    if (i === 0) firstItemId = r.id;
  }

  // Slow the row fetches that gate the table-collection + record Workspace tabs,
  // to simulate a large local table / a cloud open. The collection and record
  // renderers both await these before painting their real content, so this makes
  // the freeze deterministic. (Entities/dashboard are NOT delayed, so the shell
  // still boots normally. Provenance is now a lazy, collapsed panel on the record
  // view — off the initial-render path — but we keep it slowed for good measure.)
  await page.route('**/api/provenance**', async (route) => {
    await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
    await route.continue();
  });
  await page.route('**/api/tables/**/rows**', async (route) => {
    await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
    await route.continue();
  });

  // Boot the single-layout shell; wait for entities so the table nav resolves to
  // the real collection/record renderers rather than the pre-entities loading gate.
  const entitiesLoaded = page.waitForResponse((r) => r.url().includes('/api/entities-summary'));
  await page.goto(gui.url + '#/');
  await entitiesLoaded;
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  // Open the items table collection tab. A loading frame must appear well before
  // the 800ms row data — the view never blocks on the fetch.
  await page.evaluate(() => {
    window.location.hash = '#/w/table/items';
  });
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
  // …then the collection view fills in.
  await expect(page.locator('.view-header')).toBeVisible({ timeout: 5000 });

  // Open a record (the row detail) directly: the nav must paint the new frame
  // immediately (a loading state), not freeze on the slow row fetch.
  await page.evaluate((id) => {
    window.location.hash = '#/w/table/items/' + id;
  }, firstItemId);
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
  // …and the item content eventually loads (the record view header).
  await expect(page.locator('.view-header')).toBeVisible({ timeout: 5000 });

  // The GUI stays responsive: navigating again while data is still in flight
  // immediately repaints (no freeze, no stale view).
  await page.evaluate(() => {
    window.location.hash = '#/w/table/items';
  });
  await expect(page.locator('.route-loading')).toBeVisible({ timeout: 400 });
});
