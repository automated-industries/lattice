import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers';

// Dashboards in the Analytics view: the sidebar lists them, each opens as ONE
// closable deduped tab (recovered dynamic-tab behavior: close falls back right
// neighbor → left → home; a width-based "⋯ N" overflow keeps the active tab
// visible), and the per-dashboard ⋯ menu renames/deletes. Rows are seeded
// through the generic rows API — without a page body, which only the assistant
// authoring tools may write; the canvas still mounts its frame.

let gui: BootedGui;

test.beforeAll(async () => {
  gui = await bootGui();
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

  // Open the second — two tabs; close the ACTIVE second one → neighbor activates.
  await page.locator(`.dash-item[data-dash-id="${b}"]`).click();
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(2);
  await page.locator(`.tab[data-key="dash:${b}"] .tab-close`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics/' + a);
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(1);

  // Close the last tab → the Analytics home (empty strip, hero visible).
  await page.locator(`.tab[data-key="dash:${a}"] .tab-close`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(0);
  await expect(page.locator('.analytics-home')).toBeVisible();
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

  // Delete → tab closes, list refreshes, home shows.
  await page.locator('#dash-menu-btn').click();
  await page.locator('#dash-menu [data-act="delete"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator(`.dash-item[data-dash-id="${id}"]`)).toHaveCount(0);
});

test('a stale dashboard link drops its tab and lands home', async ({ page }) => {
  await page.goto(gui.url + '#/analytics/no-such-dashboard');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/analytics');
  await expect(page.locator('#antabstrip-tabs .tab')).toHaveCount(0);
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
