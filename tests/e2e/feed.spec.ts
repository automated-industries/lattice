import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('a server-side mutation logs to the activity popover, and nowhere else', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();
  // The activity popover is the ONE place a data change surfaces; it starts empty.
  await expect(page.locator('#activity-popover .feed-item')).toHaveCount(0);

  await createRow(gui.url, 'items', { name: 'Hello from e2e' });

  // The mutation is published to the in-process FeedBus and pushed as a `feed`
  // message over the multiplexed /api/stream WebSocket the page opened on boot.
  await expect(page.locator('#activity-popover .feed-item')).toHaveCount(1);

  // It does NOT also flash a transient header status (that surface is retired)
  // and it does NOT appear in the conversation, which carries only the user's
  // messages and the assistant's answers.
  await expect(page.locator('#app-status')).toHaveCount(0);
  await expect(page.locator('#rail-feed .feed-item')).toHaveCount(0);
});

test('a server-side new entity appears in the sidebar without a reload', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  // The entity does not exist yet — its Tables-section nav row is absent.
  const navItem = page.locator(
    '#nav-tables-list button.nav-table-item[data-table="consulting_agreements"]',
  );
  await expect(navItem).toHaveCount(0);

  // Create it server-side — the same `schema.create_entity` op the Context
  // Constructor emits when it infers a new object from an ingested file. No
  // page reload, no client-initiated mutation: the only signal the client gets
  // is the feed stream.
  const res = await page.request.post(gui.url + '/api/schema/entities', {
    data: { name: 'consulting_agreements' },
  });
  expect(res.ok()).toBeTruthy();

  // The feed-stream schema event triggers a live entity-list refresh, so the
  // new object shows in the sidebar without a manual reload (regression: it
  // used to stay missing until refresh, and routing to it showed
  // "Unknown entity").
  await expect(navItem).toHaveCount(1);
});
