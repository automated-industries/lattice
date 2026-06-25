import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Regression: the GUI used to open THREE long-lived SSE streams per tab
 * (/api/realtime/stream, /api/feed/stream, /api/render/progress). Browsers cap
 * HTTP/1.1 at six connections per host, so two open tabs consumed all six slots
 * and every data request (entities, rows, workspace switch) queued forever — the
 * "Switching…" spinner and clicking-into-objects froze with no recovery.
 *
 * The fix collapses those three into ONE multiplexed WebSocket (/api/stream).
 * WebSocket connections live in a separate, far larger browser pool than
 * HTTP/1.1 requests, so the six-slot HTTP budget stays free for data requests no
 * matter how many tabs are open. These tests drive a real browser to prove (1) a
 * tab holds exactly one persistent stream and it is a WebSocket, and (2) the GUI
 * stays responsive — including rapid clicks while row data is slow — with several
 * tabs open at once.
 */
let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('a tab opens exactly ONE persistent event stream — a WebSocket, not three SSE streams', async ({
  page,
}) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));

  // The three retired SSE endpoints must never be requested again.
  const sseRequests: string[] = [];
  page.on('request', (req) => {
    const u = req.url();
    if (
      u.includes('/api/feed/stream') ||
      u.includes('/api/realtime/stream') ||
      u.includes('/api/render/progress')
    ) {
      sseRequests.push(u);
    }
  });

  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // Exactly one persistent stream, and it is the multiplexed WebSocket.
  await expect.poll(() => sockets.length, { timeout: 4000 }).toBe(1);
  expect(sockets[0]).toContain('/api/stream');
  expect(sseRequests).toHaveLength(0);
});

test('stays responsive with several tabs open while row data is slow (rapid clicks never freeze)', async ({
  page,
  context,
}) => {
  for (let i = 0; i < 12; i++) await createRow(gui.url, 'items', { name: 'Item ' + String(i) });

  // Open extra tabs against the SAME origin — they share the browser's per-host
  // connection pool. Each holds its own event-stream WebSocket. Under the old
  // three-SSE design two of these tabs would already have exhausted the
  // six-connection HTTP budget and frozen everything that follows.
  const extraTabs = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  for (const t of extraTabs) {
    await t.goto(gui.url);
    await expect(t.locator('nav.sidebar')).toBeVisible();
  }

  // Slow every row fetch in the active tab to simulate a large/cloud workspace.
  await page.route('**/api/tables/**/rows**', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });

  await page.goto(gui.url);
  await expect(page.locator('nav.sidebar')).toBeVisible();

  // Rapidly bounce between the collection and home while row data is still in
  // flight — each navigation must repaint its frame immediately (a loading
  // state), never freeze on the pending fetch.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.location.hash = '#/fs/items';
    });
    // The loading frame repaints immediately, never frozen on the pending fetch.
    await expect(page.locator('.route-loading')).toBeVisible({ timeout: 1500 });
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
  }

  // …and the data ultimately arrives — the request was never starved by the
  // other tabs' persistent connections.
  await page.evaluate(() => {
    window.location.hash = '#/fs/items';
  });
  await expect(page.locator('.ognode-entity').first()).toBeVisible({
    timeout: 5000,
  });

  for (const t of extraTabs) await t.close();
});
