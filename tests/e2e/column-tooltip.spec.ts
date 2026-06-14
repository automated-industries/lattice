import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

// Feature (3.0.1): every column shows its definition on hover — the resolved
// description (authored or built-in) plus the column's type/role — on the
// classic table headers AND the object-view field labels. This drives the real
// bundle end-to-end: author a description via the API, then confirm it lands in
// the header `title` and the field-label `title`.
let server: GuiServerHandle;
let configDir: string;
let widgetId: string;

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.url}${path}`, {
    method: body ? (path.includes('/gui-meta/') ? 'PUT' : 'POST') : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

test.beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'lattice-e2e-tooltip-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-tooltip-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-tooltip-key';
  const configPath = join(configDir, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/main.db',
      'name: main',
      '',
      'entities:',
      '  widgets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '',
    ].join('\n'),
  );
  const outputDir = join(resolve(configPath, '..'), 'context');
  mkdirSync(outputDir, { recursive: true });
  server = await startGuiServer({ configPath, outputDir, port: 0, host: '127.0.0.1', openBrowser: false });

  widgetId = (await api('/api/tables/widgets/rows', { name: 'Gadget' })).id as string;
  // Author a definition for the `name` column.
  await api('/api/gui-meta/columns/widgets/name', { description: 'The display label of the widget.' });
});

test.afterAll(async () => {
  await server.close();
  rmSync(configDir, { recursive: true, force: true });
});

test('classic table header carries the definition tooltip (description + type)', async ({ page }) => {
  // Advanced mode renders the classic table view (the screenshot surface).
  await page.addInitScript(() => window.localStorage.setItem('lattice-advanced-mode', '1'));
  await page.goto(`${server.url}#/objects/widgets`);

  // The `name` header's title combines the authored description and the type.
  const nameHeader = page.locator('th[title*="The display label of the widget."]');
  await expect(nameHeader).toBeVisible();
  await expect(nameHeader).toHaveAttribute('title', /\(text\)/); // type/role appended
});

test('object-view field label carries the definition tooltip', async ({ page }) => {
  await page.goto(`${server.url}#/fs/widgets/${widgetId}`);
  const label = page.locator('.fs-field-label[title*="The display label of the widget."]');
  await expect(label).toBeVisible();
});
