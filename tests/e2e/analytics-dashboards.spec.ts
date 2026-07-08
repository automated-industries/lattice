import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers';

// Dashboards in the Analytics view: the sidebar lists them, each opens as ONE
// closable deduped tab (recovered dynamic-tab behavior: close falls back right
// neighbor → left → home; a width-based "⋯ N" overflow keeps the active tab
// visible), and the per-dashboard ⋯ menu renames/deletes. Rows are seeded
// through the generic rows API — without a page body, which only the assistant
// authoring tools may write; the canvas still mounts its frame.

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

test('sidebar lists dashboards; opening = one deduped tab; close falls back to home', async ({
  page,
}) => {
  const a = await seed('Revenue');
  const b = await seed('Pipeline');

  await page.goto(gui.url);
  await expect(page.locator('.dash-item')).toHaveCount(2);
  await expect(page.locator('#dash-list')).toContainText('Revenue');

  // Open one — a closable tab appears, the canvas mounts the page frame.
  await page.locator(`.dash-item[data-dash-id="${a}"]`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics/' + a);
  await expect(page.locator(`.tab[data-key="dash:${a}"]`)).toHaveCount(1);
  await expect(page.locator('.dash-title')).toHaveText('Revenue');
  await expect(page.locator('#dash-frame')).toBeVisible();

  // Re-opening from the sidebar never duplicates the tab.
  await page.locator(`.dash-item[data-dash-id="${a}"]`).click();
  await expect(page.locator(`.tab[data-key="dash:${a}"]`)).toHaveCount(1);

  // Open the second — three tabs (the permanent "New Dashboard" + two opened);
  // close the ACTIVE second one → neighbor activates.
  await page.locator(`.dash-item[data-dash-id="${b}"]`).click();
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(3);
  await page.locator(`.tab[data-key="dash:${b}"] .tab-close`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics/' + a);
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(2);

  // Close the last dashboard tab → the Analytics home (only the permanent
  // "New Dashboard" tab remains, hero visible).
  await page.locator(`.tab[data-key="dash:${a}"] .tab-close`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(1);
  await expect(page.locator('#antabstrip-tabs .tab[data-key="new"]')).toBeVisible();
  await expect(page.locator('.analytics-home')).toBeVisible();
});

test('a dashboard on a cloud/team workspace (row carries _access) still opens — regression for the appendChild-of-string crash', async ({
  page,
}) => {
  const id = await seed('Cloud Board');

  // Cloud (Postgres + RLS) reads attach a per-row `_access` summary that local
  // SQLite never sets — the ONLY difference at this client layer. That summary
  // made the per-row visibility line render as a non-empty HTML STRING, which
  // renderDashboardPage used to appendChild() → TypeError → swallowed by the
  // .catch, which closed the tab and bounced to the analytics home. Dashboards
  // therefore NEVER opened on a shared workspace. Inject `_access` into the
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

  await page.goto(gui.url + '#/analytics/' + id);

  // The dashboard opens: its title + frame mount and we STAY on its route (the
  // pre-fix code threw and bounced to '#/analytics'). The visibility line — the
  // exact element that used to throw on appendChild — rendered into the slot.
  await expect(page.locator('.dash-title')).toHaveText('Cloud Board');
  await expect(page.locator('#dash-frame')).toBeVisible();
  await expect(page.locator('#dash-vis-slot .detail-vis')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics/' + id);
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

  await page.goto(gui.url + '#/analytics/' + id);
  const frame = page.frameLocator('#dash-frame');
  // The sql ran and returned the count — not the pre-fix "forbidden table" reject.
  await expect(frame.locator('#out')).toContainText('n=', { timeout: 10000 });
  await expect(frame.locator('#out')).not.toContainText('forbidden');
});

test('the ⋯ menu renames (sidebar + tab + title follow) and deletes', async ({ page }) => {
  const id = await seed('Old Name');
  await page.goto(gui.url + '#/analytics/' + id);
  await expect(page.locator('.dash-title')).toHaveText('Old Name');

  // Rename via the menu prompt.
  page.once('dialog', (d) => void d.accept('New Name'));
  await page.locator('#dash-menu-btn').click();
  await page.locator('#dash-menu [data-act="rename"]').click();
  await expect(page.locator('.dash-title')).toHaveText('New Name');
  await expect(page.locator(`.tab[data-key="dash:${id}"]`)).toContainText('New Name');
  await expect(page.locator(`.dash-item[data-dash-id="${id}"]`)).toContainText('New Name');

  // Delete → tab closes, list refreshes, home shows. It now confirms first
  // (guarding against a stray click) — accept the dialog.
  await page.locator('#dash-menu-btn').click();
  page.once('dialog', (d) => void d.accept());
  await page.locator('#dash-menu [data-act="delete"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator(`.dash-item[data-dash-id="${id}"]`)).toHaveCount(0);
});

test('a stale dashboard link drops its tab and lands home', async ({ page }) => {
  await page.goto(gui.url + '#/analytics/no-such-dashboard');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  // Only the permanent "New Dashboard" tab remains.
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(1);
  await expect(page.locator('#antabstrip-tabs .tab[data-key="new"]')).toBeVisible();
});

test('many open tabs collapse into a "⋯ N" overflow with the active tab visible', async ({
  page,
}) => {
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(await seed('Board ' + String(i).padStart(2, '0')));

  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(gui.url);
  // Open all twelve.
  for (const id of ids) {
    await page.locator(`.dash-item[data-dash-id="${id}"]`).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics/' + id);
  }
  // The strip cannot fit twelve: the overflow button shows a count, and the
  // ACTIVE (last-opened) tab is still visible in the strip.
  const ov = page.locator('#antab-overflow-btn');
  await expect(ov).toBeVisible();
  await expect(ov).toContainText('⋯');
  await expect(
    page.locator(`#antabstrip-tabs .tab[data-key="dash:${ids[ids.length - 1]}"]`),
  ).toBeVisible();

  // The overflow menu lists the hidden (trailing, non-active) tabs and
  // activates one — whichever it holds first.
  await ov.click();
  const menu = page.locator('#antab-overflow-menu');
  await expect(menu).toBeVisible();
  const first = menu.locator('.tab-ov-item').first();
  const key = await first.getAttribute('data-key');
  expect(key).toBeTruthy();
  await first.click();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe('#/analytics/' + String(key).replace(/^dash:/, ''));
});
