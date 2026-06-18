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

test('a multi-file drop caps concurrent uploads and shows batch progress', async ({ page }) => {
  // Track how many ingest requests are in flight at once. The fix's whole point
  // is that a bulk drop must NOT saturate the browser's ~6-per-host HTTP/1.1
  // budget (which would freeze the rest of the GUI), so the in-flight count
  // must never exceed the client concurrency cap.
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route('**/api/ingest/upload', async (route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 300));
    inFlight--;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'file-' + maxInFlight + '-' + inFlight, extraction_status: 'extracted' }),
    });
  });

  await page.goto(gui.url);
  await expect(page.locator('#assistant-rail')).toBeVisible();

  const FILE_COUNT = 7;
  await page.evaluate((n) => {
    const rail = document.getElementById('assistant-rail')!;
    const dt = new DataTransfer();
    for (let i = 0; i < n; i++) {
      dt.items.add(new File(['hello ' + i], 'doc-' + i + '.md', { type: 'text/markdown' }));
    }
    rail.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, FILE_COUNT);

  // The batch progress bar appears while the queue drains…
  const bar = page.locator('.ingest-progress');
  await expect(bar).toBeVisible();
  await expect(page.locator('.ingest-progress-label')).toContainText('of ' + FILE_COUNT);

  // …no more than 3 pending cards on screen at once (the cap is client-side)…
  expect(await page.locator('.feed-item.feed-pending').count()).toBeLessThanOrEqual(3);

  // …and the bar clears once every file is analyzed.
  await expect(bar).toHaveCount(0, { timeout: 15000 });

  // The connection-budget guarantee: never more than the cap in flight at once.
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(3);
});
