import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers';

// Dashboards in the Analytics view: the sidebar lists them, clicking one opens it
// in the content pane (hash-routed), and the per-dashboard ⋯ menu renames/deletes.
// Rows are seeded through the generic rows API — without a page body, which only
// the assistant authoring tools may write; the canvas still mounts its frame.

let gui: BootedGui;

// These specs assert exact dashboard counts against a known set they create, so they
// opt out of the seeded Welcome dashboard (which would add one more).
test.beforeAll(async () => {
  gui = await bootGui({ welcome: false });
});
test.afterAll(async () => gui.close());

async function seed(title: string): Promise<string> {
  const row = await createRow(gui.url, 'dashboards', { title, description: title + ' overview' });
  return String(row.id);
}

test('sidebar lists dashboards; clicking one opens it; re-opening re-routes to the same one', async ({
  page,
}) => {
  const a = await seed('Revenue');
  const b = await seed('Pipeline');

  await page.goto(gui.url);
  // Dashboards is a collapsible accordion section now (TABLES opens by default); expand
  // it so the dashboard list is visible + its items are clickable.
  await page.locator('.section-toggle[data-group="nav-dashboards"]').click();
  await expect(page.locator('.dash-item')).toHaveCount(2);
  await expect(page.locator('#dash-list')).toContainText('Revenue');

  // Open one — the canvas mounts the page frame and we route to it.
  await page.locator(`.dash-item[data-dash-id="${a}"]`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/' + a);
  await expect(page.locator('.dash-title')).toHaveText('Revenue');
  await expect(page.locator('#dash-frame')).toBeVisible();

  // Re-opening from the sidebar just re-routes to the same dashboard.
  await page.locator(`.dash-item[data-dash-id="${a}"]`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/' + a);
  await expect(page.locator('.dash-title')).toHaveText('Revenue');

  // Open the second — it routes to its own page.
  await page.locator(`.dash-item[data-dash-id="${b}"]`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/' + b);
  await expect(page.locator('.dash-title')).toHaveText('Pipeline');

  // Navigating to the home route now lands on a dashboard whenever any exists —
  // the Ask-Lattice landing survives only as the zero-dashboards fallback.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/w\/dash\/.+/);
  await expect(page.locator('#dash-frame')).toBeVisible();
});

test('a dashboard on a cloud/team workspace (row carries _access) still opens — regression for the appendChild-of-string crash', async ({
  page,
}) => {
  const id = await seed('Cloud Board');

  // Cloud (Postgres + RLS) reads attach a per-row `_access` summary that local
  // SQLite never sets — the ONLY difference at this client layer. That summary
  // made the per-row visibility line render as a non-empty HTML STRING, which
  // renderDashboardPage used to appendChild() → TypeError → swallowed by the
  // .catch, which bounced to the analytics home. Dashboards therefore NEVER
  // opened on a shared workspace. Inject `_access` into the
  // dashboards reads to reproduce the cloud read exactly (nothing else about the
  // cloud matters to this path), so this runs in a real browser without a
  // Postgres backend but exercises the true failure trigger.
  await page.route('**/api/tables/dashboards/rows**', async (route) => {
    const resp = await route.fetch();
    let json: { rows?: Record<string, unknown>[]; id?: unknown } | null;
    try {
      json = (await resp.json()) as { rows?: Record<string, unknown>[]; id?: unknown };
    } catch {
      await route.fulfill({ response: resp });
      return;
    }
    const access = { visibility: 'everyone', ownedByMe: true };
    if (json && Array.isArray(json.rows)) {
      json.rows = json.rows.map((r) => ({ ...r, _access: access }));
    } else if (json?.id) {
      (json as Record<string, unknown>)._access = access;
    }
    await route.fulfill({ json });
  });

  await page.goto(gui.url + '#/w/dash/' + id);

  // The dashboard opens: its title + frame mount and we STAY on its route (the
  // pre-fix code threw and bounced to '#/analytics'). The visibility line — the
  // exact element that used to throw on appendChild — rendered into the slot.
  await expect(page.locator('.dash-title')).toHaveText('Cloud Board');
  await expect(page.locator('#dash-frame')).toBeVisible();
  await expect(page.locator('#dash-vis-slot .detail-vis')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/' + id);
});

test('an sql-driven dashboard loads its data (no "forbidden table") — broker regression', async ({
  page,
}) => {
  await createRow(gui.url, 'items', { name: 'x' });
  await createRow(gui.url, 'items', { name: 'y' });
  const id = await seed('SQL Board');

  // Inject an authored page that reads via lattice.sql — the aggregation path
  // Gladys uses for GROUP BY dashboards. The sql op carries no table, so the
  // broker's empty-table guard used to reject it as "forbidden table" before the
  // op even ran (so every aggregation dashboard showed "Error loading data").
  await page.route(`**/api/tables/dashboards/rows/${id}`, async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json.html =
      '<!doctype html><html><body><div id="out">pending</div>' +
      '<script>(async function(){try{' +
      'var r = await lattice.sql("SELECT COUNT(*) AS n FROM items");' +
      'var rows = (r && r.rows) ? r.rows : r;' +
      'document.getElementById("out").textContent = "n=" + (rows[0] && rows[0].n);' +
      '}catch(e){document.getElementById("out").textContent = "ERR:" + (e && e.message);}})();</script>' +
      '</body></html>';
    await route.fulfill({ json });
  });

  await page.goto(gui.url + '#/w/dash/' + id);
  const frame = page.frameLocator('#dash-frame');
  // The sql ran and returned the count — not the pre-fix "forbidden table" reject.
  await expect(frame.locator('#out')).toContainText('n=', { timeout: 10000 });
  await expect(frame.locator('#out')).not.toContainText('forbidden');
});

test('the ⋯ menu renames (sidebar + title follow) and deletes', async ({ page }) => {
  const id = await seed('Old Name');
  await page.goto(gui.url + '#/w/dash/' + id);
  await expect(page.locator('.dash-title')).toHaveText('Old Name');

  // Rename via the menu prompt.
  page.once('dialog', (d) => void d.accept('New Name'));
  await page.locator('#dash-menu-btn').click();
  await page.locator('#dash-menu [data-act="rename"]').click();
  await expect(page.locator('.dash-title')).toHaveText('New Name');
  await expect(page.locator(`.dash-item[data-dash-id="${id}"]`)).toContainText('New Name');

  // Delete → list refreshes and the view leaves the deleted dashboard's route.
  // (Home now redirects to another dashboard when one exists, so the landing
  // hash is '#/' only in the zero-dashboards case — assert the departure, not
  // a specific destination.) It now confirms first — accept the dialog.
  await page.locator('#dash-menu-btn').click();
  page.once('dialog', (d) => void d.accept());
  await page.locator('#dash-menu [data-act="delete"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe('#/w/dash/' + id);
  await expect(page.locator(`.dash-item[data-dash-id="${id}"]`)).toHaveCount(0);
});

test('a stale dashboard link lands on the home destination', async ({ page }) => {
  await page.goto(gui.url + '#/w/dash/no-such-dashboard');
  // Home destination = another dashboard when any exists, else the bare home
  // with the landing. Either way, never the stale route.
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toMatch(/^#\/(w\/dash\/(?!no-such-dashboard).+)?$/);
});

test('the + button opens-or-focuses the Welcome dashboard (never a duplicate route)', async ({
  page,
}) => {
  // This one needs the seeded Welcome dashboard, so it boots its own welcome:true gui.
  const wgui = await bootGui();
  try {
    await page.goto(wgui.url + '#/');
    await expect(page.locator('nav.dash-sidebar')).toBeVisible();
    // "+" opens the Welcome dashboard.
    await page.locator('#dash-new-btn').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/welcome-lattice');
    await expect(page.locator('.dash-title')).toHaveText('Welcome to Lattice!');
    // Clicking "+" again re-focuses the SAME dashboard route — never a second one.
    await page.locator('#dash-new-btn').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/dash/welcome-lattice');
    await expect(page.locator('.dash-title')).toHaveText('Welcome to Lattice!');
  } finally {
    await wgui.close();
  }
});
