import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('composer is gated until a Claude key is set', async ({ page }) => {
  await page.goto(gui.url);
  await openAskLattice(page);
  // No key configured → the composer shows the setup prompt, not a textarea.
  await expect(page.locator('.composer-setup')).toContainText('Set a Claude API token');
  await expect(page.locator('#chat-input')).toHaveCount(0);

  // Store a (test) Claude key the same way User Settings → Assistant does.
  const res = await page.request.put(`${gui.url}/api/assistant/key`, {
    data: { kind: 'anthropic', key: 'sk-ant-e2e-test-key' },
  });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await openAskLattice(page);
  // With auth present, the composer renders an input + send button.
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(page.locator('#chat-send')).toBeVisible();
  await expect(page.locator('.composer-setup')).toHaveCount(0);
});

/** Open the floating "Ask Lattice" panel. In the 5.0 reframe the composer (and its
 *  input / mic / send) lives inside this collapsed panel, so it must be opened
 *  before any composer element is visible. */
async function openAskLattice(page: import('@playwright/test').Page) {
  await page.locator('#ask-lattice-trigger').click();
  await expect(page.locator('#ask-lattice-panel')).toBeVisible();
}

/** Enable the composer (store a test key + reload), open the Ask Lattice panel,
 *  and return the input locator. */
async function enableComposer(page: import('@playwright/test').Page, url: string) {
  await page.request.put(`${url}/api/assistant/key`, {
    data: { kind: 'anthropic', key: 'sk-ant-e2e-test-key' },
  });
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
