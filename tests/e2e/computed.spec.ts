import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

// Computed tables in the GUI: the full-page builder (#/computed/new →
// name + base + field rows → Preview gates Create), the read-only surfaces a
// computed view gets on its collection + record pages, and the Tables
// explorer's computed-tier integration ("+ New", the detail-panel actions).

const YAML = [
  'db: ./data/app.db',
  'name: computed-e2e',
  '',
  'entities:',
  '  items:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      priority: { type: integer }',
  '      deleted_at: { type: text }',
  '    outputFile: items.md',
  '',
].join('\n');

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: YAML });
  await createRow(gui.url, 'items', { name: 'first item', priority: 3 });
  await createRow(gui.url, 'items', { name: 'second item', priority: 1 });
});
test.afterEach(async () => {
  await gui.close();
});

/** Create a computed view through the same HTTP path the builder uses. */
async function createComputed(base: string, name: string): Promise<void> {
  const res = await fetch(`${base}/api/computed-tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      def: { base: 'items', fields: { title: { kind: 'alias', source: 'name' } } },
    }),
  });
  if (!res.ok) throw new Error(`createComputed failed: ${res.status} ${await res.text()}`);
}

test('builder: name + base + fields → Preview gates Create → lands on the view', async ({
  page,
}) => {
  await page.goto(gui.url + '#/computed/new');
  // The builder is a Tables-section surface — it shows the Tables breadcrumb back
  // to the Data Model → Tables explorer (the old fixed Configure tab strip is gone).
  await expect(page.locator('.computed-builder')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.computed-builder .fs-crumbs a[href="#/tables"]')).toHaveText(
    'Tables',
  );

  // Create is gated until a preview succeeds.
  await expect(page.locator('#cb-save-btn')).toBeDisabled();

  await page.fill('#cb-name', 'item_summary');
  await page.selectOption('#cb-base', 'items');
  // The base change fetches the reachable fields; the alias picker fills in.
  await expect(page.locator('.cb-f-source option[value="name"]')).toHaveCount(1, {
    timeout: 5000,
  });

  // Field 1 — Copy a field (alias): title ← name.
  const row1 = page.locator('.cb-field').nth(0);
  await row1.locator('.cb-field-name').fill('title');
  await row1.locator('.cb-f-source').selectOption('name');

  // Field 2 — Calculation: is_urgent ← priority >= 3.
  await page.locator('#cb-add-field').click();
  const row2 = page.locator('.cb-field').nth(1);
  await row2.locator('.cb-field-name').fill('is_urgent');
  await row2.locator('.cb-field-kind').selectOption('calc');
  await row2.locator('.cb-expr').fill('priority >= 3');

  // Preview: sample rows render, every field is stamped ✓, the compiled SQL
  // fills the collapsed details block, and Create unlocks.
  await page.locator('#cb-preview-btn').click();
  await expect(page.locator('.cb-preview-table')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.cb-preview-table')).toContainText('first item');
  await expect(page.locator('.cb-mark-ok')).toHaveCount(2);
  await expect(page.locator('#cb-sql')).toBeVisible();
  await page.locator('#cb-sql summary').click();
  await expect(page.locator('#cb-sql-pre')).toContainText('SELECT');
  await expect(page.locator('#cb-save-btn')).toBeEnabled();

  // Create → the entities payload refreshes and we land on the view's rows.
  await page.locator('#cb-save-btn').click();
  // Save lands on the view's rows; the legacy #/fs/<name> target normalizes to the
  // canonical single-layout table tab.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/item_summary');
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fs-rows-table')).toContainText('first item');
});

test('a compile error surfaces in the strip and marks the failing field', async ({ page }) => {
  await page.goto(gui.url + '#/computed/new');
  await expect(page.locator('.computed-builder')).toBeVisible({ timeout: 5000 });
  await page.selectOption('#cb-base', 'items');
  const row = page.locator('.cb-field').nth(0);
  await row.locator('.cb-field-name').fill('broken');
  await row.locator('.cb-field-kind').selectOption('calc');
  await row.locator('.cb-expr').fill('no_such_column + 1');
  await page.locator('#cb-preview-btn').click();
  await expect(page.locator('#cb-error')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#cb-error')).toContainText('broken');
  await expect(page.locator('.cb-mark-err')).toHaveCount(1);
  await expect(page.locator('#cb-save-btn')).toBeDisabled();
});

test('computed rows are read-only: badge + note, no editing affordances', async ({ page }) => {
  await createComputed(gui.url, 'item_summary');

  // Collection page: a computed table renders through the SAME SQL runner as any table
  // (its view is queryable), with no Formatted/Markdown toggle. The read-only guarantee
  // comes from the SQL endpoint being read-only + the record view below.
  await page.goto(gui.url + '#/w/table/item_summary');
  await expect(page.locator('.sql-runner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fs-rows-table')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.fs-view-toggle')).toHaveCount(0);

  // Record page: badge + note, a read-only field list, and neither the
  // actions menu nor the editing toggle.
  await page.locator('.fs-rows-table tbody tr').first().click();
  await expect(page).toHaveURL(/#\/w\/table\/item_summary\/[^/]+$/);
  await expect(page.locator('.fs-computed-badge')).toBeVisible();
  await expect(page.locator('.fs-computed-note')).toBeVisible();
  await expect(page.locator('.fs-computed-fields')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#file-menu-btn')).toHaveCount(0);
  await expect(page.locator('.fs-view-toggle')).toHaveCount(0);
});

test('Tables explorer: "+ New" entry point and the computed detail panel', async ({ page }) => {
  await createComputed(gui.url, 'item_summary');

  // The Tables explorer now lives in the Configure drawer's Data Model → Tables
  // subtab; #/tables opens the drawer there and mounts #model-tables-host.
  await page.goto(gui.url + '#/tables');
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
  // The computed card renders in the Computed Tables tier with its ƒ flag.
  const card = page.locator('.mt-card[data-table="item_summary"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.mt-card-flag')).toBeVisible();

  // The detail panel: computed sub-line, Edit definition →, Refresh (streams
  // to the one-line status), and the lazy Definition (SQL) block.
  await card.click();
  const panel = page.locator('#mt-detail');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.mt-detail-sub')).toContainText('computed view');
  await expect(panel.locator('a[href="#/computed/item_summary"]')).toContainText('Edit definition');
  await panel.locator('#mt-computed-refresh').click();
  await expect(panel.locator('#mt-computed-refresh-status')).toHaveText('Refreshed', {
    timeout: 5000,
  });
  await panel.locator('#mt-computed-sql summary').click();
  await expect(panel.locator('#mt-computed-sqlpre')).toContainText('SELECT', { timeout: 5000 });

  // "+ New" in the tier header opens the builder.
  await page.locator('#mt-computed-new').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/computed/new');
  await expect(page.locator('.computed-builder')).toBeVisible();
});

test('edit mode: loads the definition, saves, and Remove returns to Tables', async ({ page }) => {
  await createComputed(gui.url, 'item_summary');

  await page.goto(gui.url + '#/computed/item_summary');
  await expect(page.locator('.computed-builder')).toBeVisible({ timeout: 5000 });
  // Edit mode: the name is fixed (no name input) and the saved definition is
  // loaded — base selected, field row filled.
  await expect(page.locator('#cb-name')).toHaveCount(0);
  await expect(page.locator('#cb-base')).toHaveValue('items');
  await expect(page.locator('.cb-field-name').first()).toHaveValue('title');
  await expect(page.locator('#cb-refresh-btn')).toBeVisible();

  // Save (no preview gate in edit mode) → lands on the view's rows (legacy #/fs/<name>
  // normalizes to the canonical table tab).
  await page.locator('#cb-save-btn').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/w/table/item_summary');

  // Remove deletes the view and returns to the Tables explorer. It now confirms
  // first (guarding against a stray click) — accept the dialog.
  await page.goto(gui.url + '#/computed/item_summary');
  await expect(page.locator('#cb-delete-btn')).toBeVisible({ timeout: 5000 });
  page.once('dialog', (d) => void d.accept());
  await page.locator('#cb-delete-btn').click();
  // Remove returns to the Tables explorer; #/tables is a Configure-drawer route, so
  // the hash stays #/tables (it does not normalize away).
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tables');
  // Wait for the explorer to re-render in the drawer, then confirm the card is gone.
  await expect(page.locator('#model-tables-host .mt')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.mt-card[data-table="item_summary"]')).toHaveCount(0);
});
