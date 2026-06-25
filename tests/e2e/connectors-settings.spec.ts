import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

// The connectors panel opens in a LEFT-sliding dialog from the Sources sidebar
// ("+ Add a Connector"), not the Settings drawer, and is fully data-driven off
// /api/connectors. It once rendered nothing because the module sat OUTSIDE the
// client IIFE and threw "fetchJson is not defined"; keeping it inside the wrapper
// is what makes the in-IIFE helpers visible. This fails loudly if that regresses,
// and asserts both connector cards render from their field specs (with logos).
test('the connectors dialog renders data-driven cards (helpers in scope)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(gui.url + '#/');
  await page.locator('#src-add-connector').click();

  const dlg = page.locator('#connectors-dialog');
  await expect(dlg).toBeVisible({ timeout: 5000 });

  const body = page.locator('#connectors-dialog-body');
  // Both connectors render as cards (data-driven), each with its logo + the
  // credential fields it declares — proof the form, not just the shell, rendered.
  await expect(body.getByText('Jira', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(body.getByText('Trello', { exact: true })).toBeVisible();
  await expect(body.locator('#cred-jira-site')).toBeVisible();
  await expect(body.locator('#cred-trello-apiKey')).toBeVisible();
  await expect(body.locator('.connector-icon').first()).toBeVisible();

  // The scope bug surfaced as an uncaught "fetchJson is not defined" before the
  // body was written — assert no page error escaped.
  expect(pageErrors).toEqual([]);
});
