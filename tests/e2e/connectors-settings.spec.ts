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

  await page.goto(gui.url + '#/folders');
  await page.locator('#src-add-connector').click();

  const dlg = page.locator('#connectors-dialog');
  await expect(dlg).toBeVisible({ timeout: 5000 });

  const body = page.locator('#connectors-dialog-body');
  // 5.0: connectors are data-driven MCP cards from /api/connectors. Bring-your-own
  // toolkits render a server-URL field; branded ones (a default MCP endpoint)
  // render a Connect button. None have the old credential fields anymore.
  await expect(body.getByText('Gmail', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(body.getByText('Jira', { exact: true })).toBeVisible();
  await expect(body.getByText('Custom MCP server', { exact: true })).toBeVisible();
  // The generic connector renders its MCP server-URL input — proof the per-card
  // form (not just the dialog shell) rendered.
  await expect(body.locator('#mcp-url-mcp')).toBeVisible();
  // The retired credential path is gone (Jira is now MCP, no #cred-jira-site).
  await expect(body.locator('#cred-jira-site')).toHaveCount(0);
  await expect(body.locator('.connector-icon').first()).toBeVisible();

  // The scope bug surfaced as an uncaught "fetchJson is not defined" before the
  // body was written — assert no page error escaped.
  expect(pageErrors).toEqual([]);
});
