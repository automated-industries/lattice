import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers';

// The single 3-column layout: left sidebar (Dashboards + Tables/Files/Markdown
// nav) │ center Workspace tabs (#content + #antabstrip) │ persistent Ask Gladys
// dock (#ask-dock). Builder surfaces (Data Model / Inputs) live in the Configure
// drawer (#settings-drawer, opened by the #configure-trigger wrench). There is no
// view flip — the workspace is always mounted; dashboards, tables, files, and
// configure routes are all reachable within the one layout.

let gui: BootedGui;

// These specs assert the EMPTY workspace baseline (no dashboards), so they opt out
// of the seeded Welcome dashboard. The seed + open-by-default behavior is covered
// by its own spec below.
//
// A FRESH isolated gui per test (not a shared beforeAll one, like smoke.spec.ts):
// bootGui mutates the global LATTICE_ROOT env, and the server resolves the workspace
// registry from it per request. A test that boots its own throwaway gui (test 1's
// welcome workspace) would otherwise leave the shared server pointed at a torn-down
// root, blanking every later test. Per-test boot keeps each spec hermetic.
test.beforeEach(async () => {
  gui = await bootGui({ welcome: false });
});
test.afterEach(async () => gui.close());

test('a new workspace opens the seeded Welcome dashboard by default', async ({ page }) => {
  const wgui = await bootGui(); // welcome seeded (the real default)
  try {
    await page.goto(wgui.url);
    // Boot opens the Welcome dashboard as a Workspace tab (not the empty home).
    // The legacy #/analytics/<id> landing normalizes to the single-layout #/w/dash/<id>.
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/welcome-lattice');
    // One 3-column layout, always mounted — no view flip.
    await expect(page.locator('.layout')).toBeVisible();
    await expect(page.locator('nav.dash-sidebar')).toBeVisible();
    await expect(page.locator('.dash-title')).toHaveText('Welcome to Lattice!');
    await expect(page.locator('#dash-frame')).toBeVisible();
    // It appears in the Dashboards sidebar like any other dashboard.
    await expect(page.locator('#dash-list')).toContainText('Welcome to Lattice!');
  } finally {
    await wgui.close();
  }
});

test('boot lands on the single-layout workspace with its empty states', async ({ page }) => {
  await page.goto(gui.url);
  // The empty landing (legacy #/analytics) normalizes to the workspace home —
  // the bare home hash ('' / '#' / '#/'), NOT a #/w/dash/* dashboard tab.
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^(#\/?)?$/);
  // The one 3-column layout is mounted — sidebar, center Workspace, and the
  // persistent Ask Gladys dock are all visible (no view flip, nothing parked hidden).
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('#ask-dock')).toBeVisible();
  // No dashboards yet — both empty states, and the tab strip is EMPTY (there is no
  // permanent tab; the home route shows the hero, no tab).
  await expect(page.locator('#dash-list')).toContainText('No dashboards yet');
  await expect(page.locator('.analytics-home h1')).toHaveText('Ask your company anything');
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(0);
});

test('the Configure trigger opens the drawer and reaches the Tables data-model surface', async ({
  page,
}) => {
  // The old two-view "each side remembers its last location" flip is gone; the
  // surviving intent is that the header trigger opens Configure and a specific
  // Configure surface (the Tables data model) is reachable, then closes back to
  // the workspace — all within the one layout, which stays mounted throughout.
  await page.goto(gui.url);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');

  // The wrench opens the Configure drawer over the (still-mounted) workspace.
  await page.locator('#configure-trigger').click();
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
  await expect(page.locator('.layout')).toBeVisible();

  // Reach the Tables data-model surface via its hash → Data Model → Tables.
  await page.evaluate(() => {
    location.hash = '#/tables';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  await expect(page.locator('.drawer-tab[data-tab="datamodel"]')).toHaveClass(/active/);
  await expect(page.locator('.dm-subtabs .tab[data-dmsub="tables"]')).toHaveClass(/active/);

  // Closing returns to the workspace home (the drawer hash resets to #/).
  await page.locator('#drawer-close').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await expect(page.locator('#settings-drawer')).toBeHidden();
});

test('app Back / Forward walk across the workspace ↔ Configure boundary', async ({ page }) => {
  // The "view flip" is gone, but the app's Back/Forward history still walks across
  // the workspace-home ↔ Configure-route boundary — the single-layout analog of the
  // old Analytics ⇄ Configure round trip.
  await page.goto(gui.url);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');

  // Open a Configure route (Data Model → Graph). The layout stays mounted.
  await page.evaluate(() => {
    location.hash = '#/graph';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);

  // Back returns to the workspace home; Forward returns to the Configure route.
  await page.locator('#nav-back-btn').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await page.locator('#nav-fwd-btn').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('.layout')).toBeVisible();
});

test('a Configure deep link boots straight into the Configure drawer', async ({ page }) => {
  // A deep link to a Configure route opens the drawer on that surface at boot —
  // no redirect away, and the single layout is mounted beneath it.
  await page.goto(gui.url + '#/graph');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/graph');
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
  await expect(page.locator('.drawer-tab[data-tab="datamodel"]')).toHaveClass(/active/);
  await expect(page.locator('.dm-subtabs .tab[data-dmsub="graph"]')).toHaveClass(/active/);
});
