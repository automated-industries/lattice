import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('User Settings shows the Assistant panel; saving a Claude key flips it to "Set"', async ({
  page,
}) => {
  await page.goto(gui.url + '#/settings/user-config');
  const host = page.locator('#assistant-host');
  await expect(host.getByText('Claude API token (chat)')).toBeVisible();
  // Initially not set.
  await expect(host.locator('.feed-source').first()).toHaveText('Not set');
  // Enter + save a key.
  await page.locator('#asst-anthropic-key').fill('sk-ant-test-key-123');
  await page.locator('#asst-anthropic-save').click();
  // Panel re-renders with the key marked Set + a Clear button appears.
  await expect(host.locator('#asst-anthropic-clear')).toBeVisible({ timeout: 5000 });
  await expect(host.locator('.feed-source').first()).toHaveText('Set');
});

test('subscription OAuth link is hidden until ANTHROPIC_OAUTH_* is configured', async ({
  page,
}) => {
  await page.goto(gui.url + '#/settings/user-config');
  const host = page.locator('#assistant-host');
  await expect(host.getByText('Claude API token (chat)')).toBeVisible();
  // oauthEnabled is false (no env) → the dormant message, not a Connect link.
  await expect(host.getByText('set the')).toBeVisible();
  await expect(host.locator('a[href="/api/assistant/oauth/start"]')).toHaveCount(0);
});
