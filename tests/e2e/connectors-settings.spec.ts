import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

// Regression: the Connectors settings tab once rendered nothing. renderConnectorsPanel
// was composed OUTSIDE the client IIFE (the module was appended LAST in
// modules/index.ts, after the wrapper closes), so it sat at true global scope and
// threw "fetchJson is not defined" the moment the tab was opened — before it wrote
// the drawer body. The tab highlighted but the body kept the previous tab's content.
// Keeping the module inside the wrapper (next to selectDrawerTab) is what makes the
// in-IIFE helpers visible. This test fails loudly if it ever drifts back out: the
// panel won't render and a page error fires.
test('Connectors settings tab renders the connectors panel (helpers in scope)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Open the drawer on a different tab first, then switch to Connectors — the
  // exact path that reproduced the scope bug.
  await page.goto(gui.url + '#/settings/user-config');
  await page.locator('.drawer-tab[data-tab="connectors"]').click();

  const body = page.locator('#drawer-body');
  // The header + the Jira card (credential form) render only if renderConnectorsPanel
  // ran to completion (it calls the IIFE-scoped fetchJson on its first line). Assert on
  // the panel's own headings (the "Connectors" h3 and the "Jira" toolkit h4) and the
  // Jira site-URL field — proof the credential form, not just the shell, rendered.
  await expect(body.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible({
    timeout: 5000,
  });
  await expect(body.getByRole('heading', { name: 'Jira', exact: true })).toBeVisible();
  await expect(body.locator('#jira-site')).toBeVisible();

  // The bug surfaced as an uncaught "fetchJson is not defined" before the body was
  // written — assert no page error escaped.
  expect(pageErrors).toEqual([]);
});
