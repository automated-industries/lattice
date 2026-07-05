import { test, expect } from '@playwright/test';
import { bootGui, type BootedGui } from './helpers.js';

// The first-run connect wall: a connected Claude subscription is mandatory, so
// when none is connected an un-skippable full-screen overlay gates the whole app
// before any workspace loads. Seeded-connected boots (the default) never see it.

test('gates the whole app with an un-skippable wall when Claude is not connected', async ({
  page,
}) => {
  const gui: BootedGui = await bootGui({ connected: false });
  try {
    await page.goto(gui.url);
    const wall = page.locator('#connect-wall');
    await expect(wall).toBeVisible();
    // It covers the viewport (over the topbar + everything).
    const box = await wall.boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    expect(box?.width).toBeGreaterThan(vw - 4);
    // The Connect affordance points at the surface-agnostic OAuth start route.
    await expect(page.locator('#connect-wall-start')).toHaveAttribute(
      'href',
      '/api/assistant/oauth/start',
    );
    // No skip / close / dismiss control exists.
    await expect(page.locator('#connect-wall button:has-text("Skip")')).toHaveCount(0);
    await expect(page.locator('#connect-wall .connect-wall-card')).toContainText('Connect Claude');
  } finally {
    await gui.close();
  }
});

test('no wall when a Claude subscription is connected', async ({ page }) => {
  const gui: BootedGui = await bootGui(); // connected by default
  try {
    await page.goto(gui.url);
    // The app boots normally; the wall never mounts.
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('#connect-wall')).toHaveCount(0);
  } finally {
    await gui.close();
  }
});
