import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Composer file-attach: a picked file shows as a removable "file to add" chip in
// its own host directly above the chat box (not buried in the message feed).

let gui: BootedGui;
test.beforeAll(async () => {
  gui = await bootGui();
});
test.afterAll(async () => gui.close());

test('picking a file stages a removable chip above the composer, not in the feed', async ({
  page,
}) => {
  await page.goto(gui.url + '#/analytics');
  await page.waitForSelector('#rail-composer #chat-file', { state: 'attached' });

  const tmp = join(gui.dir, 'note.txt');
  writeFileSync(tmp, 'hello');
  // Set the hidden input the upload <label for> targets — the same path a native
  // pick takes (Playwright can't drive the OS dialog, but the change handler is
  // what stages the file).
  await page.setInputFiles('#chat-file', tmp);

  // The chip lands in the host ABOVE the composer, and reads "1 file to add".
  const tray = page.locator('#staging-tray-host .staging-tray');
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('note.txt');
  await expect(tray).toContainText('file to add');
  // …and NOT in the message feed (where it used to render).
  await expect(page.locator('#rail-feed .staging-tray')).toHaveCount(0);

  // Each chip is removable via its ✕.
  await page.locator('#staging-tray-host .staging-file-x').click();
  await expect(page.locator('#staging-tray-host .staging-tray')).toHaveCount(0);
});
