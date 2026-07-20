import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('ingested text renders a preview on the files row detail', async ({ page }) => {
  await page.goto(gui.url + '#/');
  await expect(page.locator('nav.dash-sidebar')).toBeVisible();

  // Ingest a text snippet into the native `files` entity (paste-text path).
  const res = await page.request.post(`${gui.url}/api/ingest/text`, {
    data: { title: 'notes.txt', text: 'PREVIEW MARKER 12345\nsecond line of the note' },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: string };

  // Open the file record detail directly via its Workspace tab hash route.
  await page.goto(`${gui.url}#/w/file/${id}`);
  // text/plain isn't a markdown mime, so it renders in a <pre> preview.
  const preview = page.locator('.file-preview pre');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('PREVIEW MARKER 12345');
});
