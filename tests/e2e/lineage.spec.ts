import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * The data-lineage map below a table's rows: it reuses the Data Model explorer cards
 * (.mt-card) + the Entity/Field toggle, shows upstream SOURCES on the left (a derived table
 * always has Files as its ingestion source), THIS table in the middle, downstream CONSUMERS
 * on the right, and draws connecting lines (svg.mt-edges). Clicking a card opens it in the
 * Data Model tab.
 */

const YAML = [
  'db: ./data/test.db',
  '',
  'entities:',
  '  companies:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '  deals:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      title: { type: text }',
  '      company_id: { type: uuid }',
  '    relations:',
  '      company: { type: belongsTo, table: companies, foreignKey: company_id }',
  '',
].join('\n');

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: YAML });
  const c = (await createRow(gui.url, 'companies', { name: 'Acme' })) as { id: string };
  await createRow(gui.url, 'deals', { title: 'Acme round', company_id: c.id });
});
test.afterEach(async () => {
  await gui.close();
});

async function openTable(page: import('@playwright/test').Page, table: string) {
  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar');
  await page.evaluate((t) => {
    window.location.hash = '#/w/table/' + t;
  }, table);
  await page.waitForSelector('#table-lineage .lineage-wrap', { timeout: 10000 });
}

test('a derived child table shows Files + its belongsTo parent upstream, with connecting lines', async ({
  page,
}) => {
  await openTable(page, 'deals');
  // The lineage sits BELOW the SQL runner (after the results), not above it.
  const order = await page.evaluate(() => {
    const runner = document.querySelector('.sql-runner');
    const lineage = document.querySelector('#table-lineage');
    if (!runner || !lineage) return 'missing';
    // eslint-disable-next-line no-bitwise
    return runner.compareDocumentPosition(lineage) & Node.DOCUMENT_POSITION_FOLLOWING
      ? 'below'
      : 'above';
  });
  expect(order).toBe('below');

  // Reuses the explorer cards + the Entity/Field toggle.
  await expect(page.locator('#table-lineage .mt-seg-btn[data-lin-level="field"]')).toBeVisible();
  // THIS table centred.
  await expect(page.locator('#lin-center .mt-card[data-table="deals"]')).toBeVisible();
  // Upstream: Files (ingestion source — no table exists without a source) AND the
  // belongsTo parent `companies`.
  await expect(page.locator('#lin-up .mt-card[data-table="files"]')).toBeVisible();
  await expect(page.locator('#lin-up .mt-card[data-table="companies"]')).toBeVisible();
  // Connecting lines are drawn (source → this).
  await expect
    .poll(() => page.locator('#lin-tiers svg.mt-edges path').count(), { timeout: 5000 })
    .toBeGreaterThan(0);
});

test('the parent table shows its child as a downstream consumer; clicking a card opens the Data Model tab', async ({
  page,
}) => {
  await openTable(page, 'companies');
  await expect(page.locator('#lin-center .mt-card[data-table="companies"]')).toBeVisible();
  // Files upstream (companies is derived), deals downstream (it references companies).
  await expect(page.locator('#lin-up .mt-card[data-table="files"]')).toBeVisible();
  await expect(page.locator('#lin-down .mt-card[data-table="deals"]')).toBeVisible();
  // Clicking a linked card opens it selected in the Data Model Configure tab.
  await page.locator('#lin-down .mt-card[data-table="deals"]').click();
  await expect(page.locator('#settings-drawer.open')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.drawer-tab[data-tab="datamodel"].active')).toBeVisible();
  await expect(page.locator('#mt-detail')).toBeVisible({ timeout: 5000 });
});
