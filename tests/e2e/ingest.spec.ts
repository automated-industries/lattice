import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('dropping a file on the rail shows an "Analyzing…" indicator while ingesting', async ({
  page,
}) => {
  // Delay the ingest response so the transient pending row is observable.
  await page.route('**/api/ingest/upload', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'file-1', extraction_status: 'extracted' }),
    });
  });

  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();

  // Dispatch a synthetic file drop on the rail (browsers block real paths).
  await page.evaluate(() => {
    const rail = document.getElementById('assistant-rail')!;
    const dt = new DataTransfer();
    dt.items.add(new File(['hello ingest'], 'memo.md', { type: 'text/markdown' }));
    rail.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  });

  // The "Analyzing memo.md…" row appears while the request is in flight…
  const pending = page.locator('.feed-item.feed-pending');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText('Analyzing memo.md');

  // …and is removed once ingest resolves.
  await expect(page.locator('.feed-item.feed-pending')).toHaveCount(0, { timeout: 5000 });
});
