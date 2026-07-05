import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

// Claude access is OAuth-only now: the per-user API-key settings UI (the
// "Advanced — use an API key instead" disclosure + the key field) is removed, and
// connect/disconnect moves out of Settings to the header account menu + the
// first-run wall. Those are covered by connect-wall.spec.ts and (Phase 5) the
// account-menu spec — so the two former API-key settings tests are dropped here.

test('settings expose NO voice provider option — dictation is always on-device', async ({
  page,
}) => {
  await page.goto(gui.url + '#/settings/user-config');
  const host = page.locator('#assistant-host');
  // The GUI offers no voice-provider choice whatsoever: on-device is the only
  // path, and the keyed/cloud route is reachable solely through the API. No
  // dropdown, no cloud key fields, no "Use for voice" label.
  await expect(host.locator('#asst-stt')).toHaveCount(0);
  await expect(host.locator('#asst-openai-key')).toHaveCount(0);
  await expect(host.locator('#asst-elevenlabs-key')).toHaveCount(0);
  await expect(host.getByText('Use for voice:')).toHaveCount(0);
});
