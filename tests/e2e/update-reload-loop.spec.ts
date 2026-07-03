import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

// Regression: the GUI reloads itself when /api/version differs from the version
// the page was SERVED with — that is the seamless auto-update trigger (a relaunch
// onto new code → the open tab reconnects and reloads). But if the mismatch is
// PERSISTENT — e.g. a stale or duplicate server is holding the port and reporting
// a different version than the page was served with — the original code reloaded
// every fresh page again, forever: an unbounded reload loop that pegs memory and
// crashes the browser. (Reported: `curl … | sh` "crashed my browser both times".)
//
// The fix caps auto-reloads to 3 per minute, then stops and surfaces the mismatch
// instead of spinning. This test drives a PERSISTENT mismatch (route /api/version
// to a value that never matches the served chip) and asserts the page reloads only
// a bounded number of times — never infinitely.
let gui: BootedGui;
test.beforeEach(async () => {
  // A non-empty version stamps the page's version chip → BOOT_VERSION is set, so
  // the reconnect version check actually runs (it is a no-op when the chip is empty).
  gui = await bootGui({ version: '1.0.0' });
});
test.afterEach(async () => {
  await gui.close();
});

test('a persistent /api/version mismatch reloads a bounded number of times, never infinitely', async ({
  page,
}) => {
  // Force /api/version to ALWAYS report a version different from the served chip,
  // so every reloaded page lands right back on a mismatch — the field crash shape.
  await page.route('**/api/version', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: '999.0.0' }),
    }),
  );

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    // Count HARD loads only: boot performs a same-document hash redirect to
    // the Analytics landing (#/analytics), which also fires framenavigated —
    // it is not a reload and must not count against the cap.
    if (frame === page.mainFrame() && !frame.url().includes('#')) navigations += 1;
  });

  await page.goto(gui.url, { waitUntil: 'domcontentloaded' });
  // Wait well past what an unbounded loop needs to blow the cap: the unfixed code
  // reloaded roughly every ~2s, so >6 navigations in this window. The fix caps it.
  await page.waitForTimeout(13000);

  // 1 initial load + at most 3 capped reloads = 4. An unbounded loop far exceeds it.
  expect(navigations).toBeLessThanOrEqual(4);
});
