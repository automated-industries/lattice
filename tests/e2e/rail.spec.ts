import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

// Measure the rendered width of the Ask Gladys dock. The dock width is driven by
// the `--ask-dock-width` grid column, but that custom property is only set on the
// root once the user drags (or on restore from localStorage) — so read the real
// laid-out width off the element itself, which is valid before and after a drag.
function dockWidth(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const dock = document.getElementById('ask-dock');
    return dock ? Math.round(dock.getBoundingClientRect().width) : NaN;
  });
}

test('the wrench toggles the Configure drawer over the always-visible workspace', async ({
  page,
}) => {
  await page.goto(gui.url + '#/');
  // Single layout: the workspace + the Ask Gladys dock are ALWAYS visible (there is
  // no view flip). The Configure drawer starts closed.
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('#ask-dock')).toBeVisible();
  await expect(page.locator('#settings-drawer')).toBeHidden();

  // The wrench opens the Configure drawer; the workspace + dock stay visible beneath it.
  await page.locator('#configure-trigger').click();
  await expect(page.locator('#settings-drawer')).toBeVisible();
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('#ask-dock')).toBeVisible();

  // Clicking the wrench again collapses the drawer, back to the bare workspace.
  await page.locator('#configure-trigger').click();
  await expect(page.locator('#settings-drawer')).toBeHidden();
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('#ask-dock')).toBeVisible();
});

test('desktop: dragging the resize handle changes and persists the Ask Gladys dock width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(gui.url + '#/');
  await expect(page.locator('.layout')).toBeVisible();
  const before = await dockWidth(page);

  const handle = page.locator('#ask-dock-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The Ask Gladys dock is the rightmost column; dragging its left-edge handle left widens it.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy, { steps: 10 });
  await page.mouse.up();

  const after = await dockWidth(page);
  expect(after).toBeGreaterThan(before);
  expect(after).toBeLessThanOrEqual(640);

  // Width persists across reload (localStorage: lattice.askDockWidth).
  await page.reload();
  await expect(page.locator('.layout')).toBeVisible();
  const persisted = await dockWidth(page);
  expect(persisted).toBe(after);
});
