import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async ({ page }) => {
  gui = await bootGui();
  // The composer (and its single Send button, which now ingests staged files) only
  // renders when the assistant is configured — as it always is in real use.
  await page.request.put(`${gui.url}/api/assistant/key`, {
    data: { kind: 'anthropic', key: 'sk-ant-e2e-test-key' },
  });
});
test.afterEach(async () => {
  await gui.close();
});

// Dispatch a synthetic file drop on the floating Ask Lattice panel (browsers block
// real paths). Open the panel first so its drop handler is wired + its feed visible.
async function openAssistant(page: import('@playwright/test').Page) {
  await expect(page.locator('#ask-dock')).toBeVisible();
  // The composer must have rendered (its Send button ingests the staged batch)…
  await expect(page.locator('#chat-send')).toBeVisible();
  // …and the document-level file drop zone must be WIRED before we dispatch a
  // synthetic drop. initFileDropZone() appends the overlay + sets __fileDropWired
  // once its drop/dragover listeners are live; dropping before that races the
  // handler and the files never stage.
  await page.locator('.file-drop-overlay').waitFor({ state: 'attached' });
}
async function dropFiles(page: import('@playwright/test').Page, names: string[]) {
  await page.evaluate((fileNames) => {
    const panel = document.getElementById('ask-dock')!;
    const dt = new DataTransfer();
    for (const name of fileNames) {
      dt.items.add(new File(['hello ' + name], name, { type: 'text/markdown' }));
    }
    // The drop is scoped to the chat dock, so the event must land INSIDE its rect
    // (the handler hit-tests clientX/clientY against the target) — dispatch at its
    // center, not the default (0,0) which falls outside a docked panel.
    const r = panel.getBoundingClientRect();
    panel.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  }, names);
}

test('dropping a file stages it for review, then Send ingests it', async ({ page }) => {
  // Delay the ingest response so the transient pending row is observable.
  await page.route('**/api/ingest/upload', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'file-1', extraction_status: 'extracted' }),
    });
  });

  await page.goto(gui.url + '#/');
  await openAssistant(page);

  await dropFiles(page, ['memo.md']);

  // The file is STAGED (listed in the tray), not ingested immediately.
  await expect(page.locator('.staging-tray')).toBeVisible();
  await expect(page.locator('.staging-file-name')).toContainText('memo.md');
  await expect(page.locator('.feed-item.feed-pending')).toHaveCount(0);

  // The main composer Send ingests the staged files (no separate tray Send) →
  // the activity pill's running indicator appears while the request is in flight
  // (the ingest now flows through the unified activity-menu background-task
  // tracker, not a bespoke feed row)…
  await page.locator('#chat-send').click();
  await expect(page.locator('.staging-tray')).toHaveCount(0);
  await expect(page.locator('#activity-running')).toBeVisible();

  // …and clears once ingest resolves.
  await expect(page.locator('#activity-running')).toBeHidden({ timeout: 6000 });
});

test('staged files can be removed with ✕, and nothing ingests until Send', async ({ page }) => {
  let ingestCalls = 0;
  await page.route('**/api/ingest/upload', async (route) => {
    ingestCalls++;
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"x"}' });
  });

  await page.goto(gui.url + '#/');
  await openAssistant(page);

  await dropFiles(page, ['a.md', 'b.md']);
  await expect(page.locator('.staging-file')).toHaveCount(2);

  // The per-file ✕ removes a single file → the tray now lists one.
  await page.locator('.staging-file-x').first().click();
  await expect(page.locator('.staging-file')).toHaveCount(1);

  // Removing the last one empties the tray. Nothing ingested — Send was never clicked.
  await page.locator('.staging-file-x').first().click();
  await expect(page.locator('.staging-tray')).toHaveCount(0);
  expect(ingestCalls).toBe(0);
});

test('a multi-file drop stages all, and Send caps concurrent uploads with batch progress', async ({
  page,
}) => {
  // Track how many ingest requests are in flight at once. The fix's whole point
  // is that a bulk send must NOT saturate the browser's ~6-per-host HTTP/1.1
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
      body: JSON.stringify({
        id: 'file-' + maxInFlight + '-' + inFlight,
        extraction_status: 'extracted',
      }),
    });
  });

  await page.goto(gui.url + '#/');
  await openAssistant(page);

  const FILE_COUNT = 7;
  await dropFiles(
    page,
    Array.from({ length: FILE_COUNT }, (_, i) => 'doc-' + i + '.md'),
  );

  // All files are staged; nothing ingests until Send.
  await expect(page.locator('.staging-file')).toHaveCount(FILE_COUNT);
  await expect(page.locator('.ingest-progress')).toHaveCount(0);

  await page.locator('#chat-send').click();

  // The batch progress shows in the activity-menu background-task tracker while
  // the queue drains — the pill's running indicator, and a single task
  // ("Analyzing N of 7 files…") with a progress bar in the popover…
  await expect(page.locator('#activity-running')).toBeVisible();
  await page.locator('#activity-pill').click(); // open the popover to inspect the task
  await expect(page.locator('#bg-tasks .bg-task')).toContainText('of ' + FILE_COUNT);

  // …and the tracker clears once every file is analyzed.
  await expect(page.locator('#activity-running')).toBeHidden({ timeout: 15000 });

  // The connection-budget guarantee: never more than the cap in flight at once.
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(3);
});
