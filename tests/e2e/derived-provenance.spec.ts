import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Derived-table provenance in the Data Model:
 *  - Part A: a DERIVED table's detail shows its "Definition" — the input SOURCE(s) it is
 *    extracted from (e.g. Files), stated as AI extraction (no SQL), parallel to a computed
 *    table's SQL definition.
 *  - Part B: the Data Model draws ingestion connector lines from each input SOURCE to the
 *    DERIVED tables it feeds, matching the table-view lineage.
 *
 * The accurate source signal is the source-to-derived junction (files_<table>), NOT a blanket
 * "everything comes from Files": a native table with no such junction shows no Files source.
 */

const YAML = [
  'db: ./data/test.db',
  '',
  'entities:',
  '  companies:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '',
].join('\n');

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: YAML });
  await createRow(gui.url, 'companies', { name: 'Acme' });
  // Link Files -> companies (the ingestion provenance a document extraction creates).
  const res = await fetch(`${gui.url}/api/schema/junctions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ left: 'files', right: 'companies' }),
  });
  if (!res.ok) throw new Error('junction create failed: ' + res.status);
});
test.afterEach(async () => {
  await gui.close();
});

async function openDataModel(page: import('@playwright/test').Page) {
  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar');
  await page.evaluate(() => {
    window.location.hash = '#/tables';
  });
  await page.waitForSelector('.drawer-tab[data-tab="datamodel"].active', { timeout: 10000 });
  await page.waitForSelector('#model-tables-host .mt-card[data-table="companies"]', {
    timeout: 10000,
  });
}

test('the Data Model draws an ingestion line from Files to a derived table (Part B)', async ({
  page,
}) => {
  await openDataModel(page);
  // At least one input->derived ingestion connector is drawn (Files -> companies).
  await expect
    .poll(() => page.locator('#model-tables-host svg.mt-edges path.mt-edge-ingest').count(), {
      timeout: 6000,
    })
    .toBeGreaterThan(0);
});

test('a derived table shows its extraction Definition (Part A)', async ({ page }) => {
  await openDataModel(page);
  await page.locator('#model-tables-host .mt-card[data-table="companies"]').click();
  const deriv = page.locator('#mt-detail .mt-deriv-sec');
  await expect(deriv).toBeVisible({ timeout: 5000 });
  await expect(deriv).toContainText(/extracted from/i);
  // The source is a clickable Files chip (opens the Files table's detail).
  await expect(deriv.locator('.mt-deriv-src[data-lin="files"]')).toBeVisible();
});
