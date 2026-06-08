import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

function sidebarWidth(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10),
  );
}

test('mobile: the rail handle toggles the bottom drawer', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(gui.url);
  const rail = page.locator('#assistant-rail');
  const handle = page.locator('#rail-handle');
  await expect(handle).toBeVisible();
  await expect(rail).not.toHaveClass(/expanded/);

  await handle.click();
  await expect(rail).toHaveClass(/expanded/);

  await handle.click();
  await expect(rail).not.toHaveClass(/expanded/);
});

test('desktop: dragging the resize handle changes and persists the rail width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(gui.url);
  const before = await sidebarWidth(page);

  const handle = page.locator('#rail-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The rail is on the right; dragging the handle left widens it.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy, { steps: 10 });
  await page.mouse.up();

  const after = await sidebarWidth(page);
  expect(after).toBeGreaterThan(before);
  expect(after).toBeLessThanOrEqual(640);

  // Width persists across reload (localStorage).
  await page.reload();
  const persisted = await sidebarWidth(page);
  expect(persisted).toBe(after);
});
