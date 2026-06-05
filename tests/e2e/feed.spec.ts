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

  // The mutation is published to the in-process FeedBus and pushed over the
  // /api/feed/stream SSE the page opened on boot.
  await expect(page.locator('.feed-item')).toHaveCount(1);
  await expect(page.locator('.feed-item .feed-summary')).toBeVisible();
  // GUI-sourced mutations are tagged "you" in the source pill.
  await expect(page.locator('.feed-item .feed-source')).toHaveText('you');
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
