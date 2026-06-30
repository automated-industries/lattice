import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('a server-side mutation flashes a transient status and logs to the activity popover (not rail pills)', async ({
  page,
}) => {
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();
  // The (removed) right rail never showed pills; the header activity popover
  // starts empty before any mutation.
  await expect(page.locator('#activity-popover .feed-item')).toHaveCount(0);

  await createRow(gui.url, 'items', { name: 'Hello from e2e' });

  // The mutation is published to the in-process FeedBus and pushed as a `feed`
  // message over the multiplexed /api/stream WebSocket the page opened on boot.
  // The client flashes it as a transient note in the top-right status indicator
  // (it auto-clears) AND logs it to the header activity popover — never a rail pill.
  await expect(page.locator('#app-status')).toBeVisible();
  await expect(page.locator('#activity-popover .feed-item')).toHaveCount(1);
});

test('a server-side new entity appears in the sidebar without a reload', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // The entity does not exist yet — its nav item is absent.
  const navItem = page.locator('#object-nav a[data-route="#/fs/consulting_agreements"]');
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
