import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

// The MCP Connectors panel renders INSIDE the Configure drawer's tab (the old
// left-sliding dialog is gone), fully data-driven off /api/connectors. The panel
// once rendered nothing because the module sat OUTSIDE the client IIFE and threw
// "fetchJson is not defined"; keeping it inside the wrapper is what makes the
// in-IIFE helpers visible. This fails loudly if that regresses, and asserts the
// add-by-URL form renders in the tab body.
test('the MCP Connectors tab renders the panel with the add-by-URL form', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // The #/settings/connectors hash opens the Configure drawer to the tab.
  await page.goto(gui.url + '#/settings/connectors');
  await expect(page.locator('#settings-drawer.open')).toBeVisible({ timeout: 5000 });

  // The tab is labelled "MCP Connectors" and hosts a full-width table + an
  // inline add form in its own mount (no dialog).
  await expect(page.locator('.drawer-tab[data-tab="connectors"]')).toHaveText('MCP Connectors');
  await expect(page.locator('#mcp-connectors-list')).toBeVisible({ timeout: 5000 });
  const form = page.locator('#mcp-connectors-form');
  await expect(form).toBeVisible({ timeout: 5000 });

  // The inline add form renders (URL field + Connect), with the pre-registered
  // client fields present but hidden until a server demands them.
  await expect(form.getByText('Add an MCP connector')).toBeVisible({ timeout: 5000 });
  await expect(form.locator('#mcp-add-url')).toBeVisible();
  await expect(form.locator('#mcp-client-fields')).toBeHidden();
  await expect(form.locator('button[data-conn-act="connect"]')).toBeVisible();

  // No branded connectors and no left-sliding connectors dialog anymore.
  await expect(page.getByText('Gmail', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Jira', { exact: true })).toHaveCount(0);
  await expect(page.locator('#connectors-dialog')).toHaveCount(0);

  // The scope bug surfaced as an uncaught "fetchJson is not defined" before the
  // body was written — assert no page error escaped.
  expect(pageErrors).toEqual([]);
});
