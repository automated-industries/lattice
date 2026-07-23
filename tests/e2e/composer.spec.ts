import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('the composer is active when Claude is connected', async ({ page }) => {
  // Claude access is OAuth-only + mandatory (the wall gates a disconnected boot),
  // so past the wall the composer is always active — there is no key-gated setup
  // prompt. bootGui boots connected, so the input + send button render.
  await page.goto(gui.url);
  await openAskLattice(page);
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(page.locator('#chat-send')).toBeVisible();
  await expect(page.locator('.composer-setup')).toHaveCount(0);
});

/** The composer lives in the persistent Ask Gladys dock of the single 3-column
 *  layout; the dock is always visible (no view flip, no toggle), so there is
 *  nothing to open — just wait for the dock. */
async function openAskLattice(page: import('@playwright/test').Page) {
  await expect(page.locator('#ask-dock')).toBeVisible();
}

/** Open the Ask Lattice dock and return the composer input. bootGui boots
 *  connected, so the composer is active — no key setup needed. */
async function enableComposer(page: import('@playwright/test').Page, url: string) {
  await page.goto(url);
  await openAskLattice(page);
  await expect(page.locator('#chat-input')).toBeVisible();
  return page.locator('#chat-input');
}

test('read-only tool calls produce no activity cards (only data changes show)', async ({
  page,
}) => {
  // Async transport: POST /api/chat ACKs 202 {threadId, messageId} and the turn's events
  // arrive over the /api/stream WebSocket as 'chat-progress' frames. Mock BOTH — the 202
  // ack pins the messageId the client binds the turn to, and the mocked WebSocket pushes
  // the turn's events keyed to that same id. Routes are registered BEFORE navigation so
  // the client's boot-time WebSocket connects to the mock.
  const THREAD = 't-e2e';
  const MSG = 'm-e2e';
  // The turn: two reads (no data change → no feed event → no activity card) then a reply.
  const events: Record<string, unknown>[] = [
    { type: 'assistant_message_start', id: 'm0' },
    { type: 'tool_use', id: 'u1', name: 'list_rows' },
    { type: 'tool_result', toolUseId: 'u1', isError: false },
    { type: 'tool_use', id: 'u2', name: 'list_rows' },
    { type: 'tool_result', toolUseId: 'u2', isError: false },
    { type: 'assistant_message_start', id: 'm1' },
    { type: 'text_delta', delta: 'Found 3 rows.' },
    { type: 'done' },
  ];

  let streamSocket: import('@playwright/test').WebSocketRoute | null = null;
  // Pure mock (no connectToServer): this handler IS the server side of the socket.
  await page.routeWebSocket('**/api/stream', (ws) => {
    streamSocket = ws;
  });
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 202,
      headers: { 'content-type': 'application/json', 'x-thread-id': THREAD },
      body: JSON.stringify({ threadId: THREAD, messageId: MSG }),
    });
    // Push the turn's events over the mocked WebSocket. The client buffers any frame that
    // arrives before it binds the turn (on the 202) and replays it, so order is safe.
    for (const event of events) {
      streamSocket?.send(
        JSON.stringify({
          type: 'chat-progress',
          data: { threadId: THREAD, messageId: MSG, event },
        }),
      );
    }
  });

  const input = await enableComposer(page, gui.url);
  await input.fill('list everything');
  await input.press('Enter');

  await expect(page.locator('.chat-bubble.assistant')).toContainText('Found 3 rows.');
  await expect(page.locator('.tool-pill')).toHaveCount(0);
  await expect(page.locator('.feed-item')).toHaveCount(0);
});

// Reload recovery of an in-flight turn (async-transport durability). The chat client keys
// a running turn by messageId and, on reload, rebinds a persisted 'streaming'/'pending'
// last assistant row so its remaining events keep painting — BUT only when the row is
// FRESH. A stale row (orphaned by a process that died mid-turn) must render as an
// interrupted reply, not a permanent typing bubble that locks the composer forever.
async function mountStreamingThread(
  page: import('@playwright/test').Page,
  url: string,
  startedAt: string,
): Promise<void> {
  await page.route('**/api/chat/threads', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threads: [{ id: 'th-x', title: 'In-flight thread' }] }),
        })
      : route.continue(),
  );
  await page.route('**/api/chat/threads/th-x/messages', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { id: 'u1', role: 'user', text: 'do the thing', created_at: '2020-01-01T00:00:00.000Z' },
          {
            id: 'as-x',
            role: 'assistant',
            text: 'Working on it so far…',
            status: 'streaming',
            startedAt,
            created_at: '2020-01-01T00:00:01.000Z',
          },
        ],
      }),
    }),
  );
  await page.goto(url);
  await openAskLattice(page);
  await expect(page.locator('#chat-input')).toBeVisible();
}

test('reload rebinds a FRESH in-flight turn as live (composer stays locked)', async ({ page }) => {
  await mountStreamingThread(page, gui.url, new Date().toISOString());
  // The saved partial shows, and the composer is disabled — the turn is bound as live and
  // its remaining chat-progress frames will finalize it.
  await expect(page.locator('.chat-bubble.assistant')).toContainText('Working on it so far');
  await expect(page.locator('#chat-send')).toBeDisabled();
});

test('reload renders a STALE orphaned turn as interrupted (composer stays free)', async ({
  page,
}) => {
  // startedAt well beyond the freshness window → the owning process is presumed dead.
  await mountStreamingThread(page, gui.url, '2020-01-01T00:00:01.000Z');
  await expect(page.locator('.chat-bubble.assistant')).toContainText('Working on it so far');
  // Not bound, not locked — the user can send again immediately.
  await expect(page.locator('#chat-send')).toBeEnabled();
});

test('a follow-up typed mid-turn is queued and sent when the turn finishes', async ({ page }) => {
  // Turn 1 streams a reply but never sends `done`, so the composer stays busy.
  // A follow-up typed + Entered mid-stream must QUEUE (not drop); finishing turn 1
  // then flushes it as turn 2.
  const THREAD = 't-q';
  let posts = 0;
  const bodies: string[] = [];
  let socket: import('@playwright/test').WebSocketRoute | null = null;
  const send = (msg: string, event: Record<string, unknown>): void => {
    socket?.send(
      JSON.stringify({ type: 'chat-progress', data: { threadId: THREAD, messageId: msg, event } }),
    );
  };
  await page.routeWebSocket('**/api/stream', (ws) => {
    socket = ws;
  });
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    bodies.push(route.request().postData() || '');
    const n = posts;
    const msg = 'm' + String(n);
    await route.fulfill({
      status: 202,
      headers: { 'content-type': 'application/json', 'x-thread-id': THREAD },
      body: JSON.stringify({ threadId: THREAD, messageId: msg }),
    });
    // Turn 1: start + a delta, but withhold `done` (stays streaming). Turn 2: full.
    send(msg, { type: 'assistant_message_start', id: msg + '-a' });
    send(msg, { type: 'text_delta', delta: n === 1 ? 'First reply…' : 'Second reply.' });
    if (n === 2) send(msg, { type: 'done' });
  });

  const input = await enableComposer(page, gui.url);
  await input.fill('turn one');
  await input.press('Enter');
  await expect(page.locator('.chat-bubble.assistant')).toContainText('First reply');
  await expect(page.locator('#chat-send')).toBeDisabled();

  // Type a follow-up mid-stream → it queues (dimmed placeholder), the composer
  // clears, and NO second POST fires yet. (Pre-fix the message was dropped.)
  await input.fill('follow up while busy');
  await input.press('Enter');
  await expect(page.locator('.chat-msg.queued')).toHaveCount(1);
  await expect(page.locator('.chat-msg.queued')).toContainText('follow up while busy');
  await expect(input).toHaveValue('');
  expect(posts).toBe(1);

  // Finish turn 1 → the queued follow-up flushes as turn 2.
  send('m1', { type: 'done' });
  await expect.poll(() => posts).toBe(2);
  await expect(page.locator('.chat-msg.queued')).toHaveCount(0);
  await expect(page.locator('.chat-bubble.assistant').last()).toContainText('Second reply');
  expect(bodies[1]).toContain('follow up while busy');
});

test('the composer textarea grows to fit multi-line input', async ({ page }) => {
  const input = await enableComposer(page, gui.url);
  // Measure the textarea's LAYOUT height (offsetHeight), not boundingBox(): the
  // Ask Lattice panel scales in via a CSS `transform`, which scales boundingBox's
  // rendered rect mid-animation and made this flaky in headless CI. offsetHeight is
  // the true laid-out height (what the auto-grow sets) and is transform-immune.
  const heightOf = async () => input.evaluate((el) => (el as HTMLElement).offsetHeight);

  const oneLine = await heightOf();
  await input.fill(['line one', 'line two', 'line three', 'line four'].join('\n'));
  // fill() dispatches an input event, so the auto-grow handler has run.
  const grown = await heightOf();
  expect(grown).toBeGreaterThan(oneLine);

  // Clearing collapses it back to a single line.
  await input.fill('');
  expect(await heightOf()).toBeLessThanOrEqual(oneLine + 1);
});
