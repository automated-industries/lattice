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
  // No key configured → the composer shows the setup prompt, not a textarea.
  await expect(page.locator('.composer-setup')).toContainText('Set a Claude API token');
  await expect(page.locator('#chat-input')).toHaveCount(0);

  // Store a (test) Claude key the same way User Settings → Assistant does.
  const res = await page.request.put(`${gui.url}/api/assistant/key`, {
    data: { kind: 'anthropic', key: 'sk-ant-e2e-test-key' },
  });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  // With auth present, the composer renders an input + send button.
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(page.locator('#chat-send')).toBeVisible();
  await expect(page.locator('.composer-setup')).toHaveCount(0);
});
