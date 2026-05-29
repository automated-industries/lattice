import { test, expect } from '@playwright/test';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootGui, type BootedGui } from './helpers.js';

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui();
});
test.afterEach(async () => {
  await gui.close();
});

test('Database Settings danger zone deletes the active database after typed confirmation', async ({
  page,
}) => {
  // A sibling config so deleting the active DB can switch away to it.
  writeFileSync(
    join(gui.dir, 'beta.config.yml'),
    [
      'db: ./data/beta.db',
      'name: beta',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '    outputFile: items.md',
      '',
    ].join('\n'),
  );

  await page.goto(`${gui.url}#/settings/database`);

  const deleteBtn = page.locator('#db-delete-btn');
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // The confirm modal's red button is disabled until the name matches.
  const ok = page.locator('.modal-backdrop [data-act="ok"]');
  await expect(ok).toBeDisabled();
  await page.locator('#confirm-db-name').fill('e2e');
  await expect(ok).toBeEnabled();
  await ok.click();

  // The active config file is gone and the server switched to the sibling.
  await expect.poll(() => existsSync(gui.configPath)).toBe(false);
  const res = await page.request.get(`${gui.url}/api/databases`);
  const body = (await res.json()) as { current: { label: string } };
  expect(body.current.label).toBe('beta');
});
