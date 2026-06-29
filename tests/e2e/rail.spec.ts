import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

function outputsWidth(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--outputs-width'), 10),
  );
}

test('the header trigger opens and closes the floating Ask Lattice panel', async ({ page }) => {
  await page.goto(gui.url);
  const panel = page.locator('#ask-lattice-panel');
  await expect(panel).toBeHidden();

  await page.locator('#ask-lattice-trigger').click();
  await expect(panel).toBeVisible();

  await page.locator('#ask-lattice-close').click();
  await expect(panel).toBeHidden();
});

test('desktop: dragging the resize handle changes and persists the Outputs width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(gui.url);
  const before = await outputsWidth(page);

  const handle = page.locator('#outputs-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The Outputs column is on the right; dragging the handle left widens it.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy, { steps: 10 });
  await page.mouse.up();

  const after = await outputsWidth(page);
  expect(after).toBeGreaterThan(before);
  expect(after).toBeLessThanOrEqual(640);

  // Width persists across reload (localStorage).
  await page.reload();
  const persisted = await outputsWidth(page);
  expect(persisted).toBe(after);
});
