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

/** The composer lives in the Analytics view's always-visible assistant dock;
 *  the app boots into Analytics, so there is nothing to open — just wait for
 *  the dock. */
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

/** Build an SSE body for the chat stream from a list of events. */
function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

test('read-only tool calls produce no activity cards (only data changes show)', async ({
  page,
}) => {
  const input = await enableComposer(page, gui.url);

  // Mock a turn that only reads (two list_rows), then a text reply. Reads change
  // no data, so they emit no feed event — the rail shows the reply text and NO
  // activity cards (and no inline tool pills; that system was removed in favour
  // of the unified activity-card design).
  await page.route('**/api/chat', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-thread-id': 't-e2e' },
      body: sse([
        { type: 'assistant_message_start', id: 'm0' },
        { type: 'tool_use', id: 'u1', name: 'list_rows' },
        { type: 'tool_result', toolUseId: 'u1', isError: false },
        { type: 'tool_use', id: 'u2', name: 'list_rows' },
        { type: 'tool_result', toolUseId: 'u2', isError: false },
        { type: 'assistant_message_start', id: 'm1' },
        { type: 'text_delta', delta: 'Found 3 rows.' },
        { type: 'done' },
      ]),
    }),
  );

  await input.fill('list everything');
  await input.press('Enter');

  await expect(page.locator('.chat-bubble.assistant')).toContainText('Found 3 rows.');
  await expect(page.locator('.tool-pill')).toHaveCount(0);
  await expect(page.locator('.feed-item')).toHaveCount(0);
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
