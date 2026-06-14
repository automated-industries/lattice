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

test('a multi-file upload bounds concurrency (worker pool) and ingests every file', async ({
  page,
}) => {
  // A folder pick can be thousands of files; firing them all at once exhausts the
  // browser connection pool and starves the SSE streams + live-refresh refetch.
  // The worker pool must keep concurrency capped while still sending every file.
  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;
  await page.route('**/api/ingest/upload', async (route) => {
    inFlight += 1;
    total += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40)); // hold the slot so overlap is observable
    inFlight -= 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ extraction_status: 'extracted' }),
    });
  });

  await page.goto(gui.url);
  const N = 12;
  const files = Array.from({ length: N }, (_, i) => ({
    name: `f${i}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`content ${i}`),
  }));
  // The topbar "Files…" input feeds uploadFiles() — the same batch path a folder
  // pick / composer-paperclip folder uses.
  await page.setInputFiles('#upload-input', files);

  await expect.poll(() => total, { timeout: 8000 }).toBe(N); // every file sent, none dropped
  expect(maxInFlight).toBeLessThanOrEqual(4); // capped (would be 6+ if unbounded)
  expect(maxInFlight).toBeGreaterThan(1); // but it does parallelize
});

test('the progress toast can cancel an in-progress upload', async ({ page }) => {
  // Hold each upload open so the batch is still running when we click cancel.
  let served = 0;
  await page.route('**/api/ingest/upload', async (route) => {
    served += 1;
    await new Promise((r) => setTimeout(r, 400));
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ extraction_status: 'extracted' }),
      })
      .catch(() => {}); // request may already be aborted by cancel
  });

  await page.goto(gui.url);
  const N = 30;
  const files = Array.from({ length: N }, (_, i) => ({
    name: `x${i}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`content ${i}`),
  }));
  await page.setInputFiles('#upload-input', files);

  const toast = page.locator('#upload-progress-toast');
  await expect(toast.locator('.up-cancel')).toBeVisible();
  await toast.locator('.up-cancel').click();

  // Toast reports the cancel, and the worker pool stops pulling new files — so
  // far fewer than N requests ever reach the server.
  await expect(toast.locator('.up-title')).toContainText('cancelled');
  await page.waitForTimeout(700);
  expect(served).toBeLessThan(N);
});
