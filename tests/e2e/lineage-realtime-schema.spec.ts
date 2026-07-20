import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Realtime schema refresh: a schema change made AFTER the client loaded — e.g. the
 * assistant creating a computed table server-side — must appear in the Data Model / graph
 * / table-view lineage WITHOUT a manual reload. The client already refreshes the entity
 * list on an `op:'schema'` feed event; it must ALSO drop the cached schema-graph edges
 * (mtEdgesCache) so the new relationship (a `computes` edge to the view) is picked up.
 */

const YAML = [
  'db: ./data/test.db',
  '',
  'entities:',
  '  points:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '',
].join('\n');

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: YAML });
  await createRow(gui.url, 'points', { name: 'p1' });
  // Extracted from documents → a files_points junction, so the table has a lineage panel
  // (Files upstream) even before the computed view exists.
  const r = await fetch(`${gui.url}/api/schema/junctions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ left: 'files', right: 'points' }),
  });
  if (!r.ok) throw new Error('junction create failed: ' + r.status);
});
test.afterEach(async () => {
  await gui.close();
});

test('an assistant-created computed table appears in the lineage without a reload', async ({
  page,
}) => {
  await page.goto(gui.url + '#/');
  await page.waitForSelector('nav.dash-sidebar');
  await page.evaluate(() => {
    window.location.hash = '#/w/table/points';
  });
  await page.waitForSelector('#table-lineage .lineage-wrap', { timeout: 10000 });
  // No computed consumer yet.
  await expect(page.locator('#lin-down .mt-card[data-table="points_summary"]')).toHaveCount(0);

  // Create the computed view server-side (as the assistant's tool would) — NO page reload.
  const res = await page.request.post(`${gui.url}/api/computed-tables`, {
    data: {
      name: 'points_summary',
      def: { base: 'points', fields: { label: { kind: 'alias', source: 'name' } } },
    },
  });
  expect(res.ok()).toBeTruthy();

  // The realtime op:'schema' event drops the stale graph-edge cache + re-renders, so the
  // computed view shows as a downstream consumer without the user reloading.
  await expect(page.locator('#lin-down .mt-card[data-table="points_summary"]')).toHaveCount(1, {
    timeout: 10000,
  });
});
