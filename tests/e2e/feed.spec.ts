import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('a server-side mutation streams a bubble into the rail feed', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();
  await expect(page.locator('.feed-item')).toHaveCount(0);

  await createRow(gui.url, 'items', { name: 'Hello from e2e' });

  // The mutation is published to the in-process FeedBus and pushed as a `feed`
  // message over the multiplexed /api/stream WebSocket the page opened on boot.
  await expect(page.locator('.feed-item')).toHaveCount(1);
  await expect(page.locator('.feed-item .feed-summary')).toBeVisible();
  // GUI-sourced mutations are tagged "you" in the source pill.
  await expect(page.locator('.feed-item .feed-source')).toHaveText('you');
});

test('a server-side new entity appears in the sidebar without a reload', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();

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

test('consecutive identical events collapse into one counted bubble', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();
  await expect(page.locator('.feed-item')).toHaveCount(0);

  // Three inserts into the same table — a bulk run that used to spam three
  // near-identical bubbles now collapses into one with a count.
  await createRow(gui.url, 'items', { name: 'a' });
  await createRow(gui.url, 'items', { name: 'b' });
  await createRow(gui.url, 'items', { name: 'c' });

  await expect(page.locator('.feed-item')).toHaveCount(1);
  await expect(page.locator('.feed-item .feed-summary')).toHaveText(/Added 3 rows to items/);
});

test("starting a new conversation clears the previous conversation's activity cards", async ({
  page,
}) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();
  await createRow(gui.url, 'items', { name: 'clear me' });
  await expect(page.locator('.feed-item')).toHaveCount(1);

  // The rail is conversation-scoped: "New conversation" runs newChat() →
  // clearChat(), which now drops the activity cards too. Each conversation
  // replays its own data-change cards from its persisted per-turn events, so a
  // fresh conversation starts with an empty rail.
  await page.locator('#rail-threads').selectOption('');
  await expect(page.locator('.feed-item')).toHaveCount(0);
});

test('clicking a row feed item navigates to that object', async ({ page }) => {
  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();

  const created = (await createRow(gui.url, 'items', { name: 'Clickable target' })) as {
    id: string;
  };

  const item = page.locator('.feed-item.feed-clickable').first();
  await expect(item).toBeVisible();
  await item.click();

  // Navigates to the row detail (#/fs/items/<id> in simple mode).
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('items/' + created.id);
});
