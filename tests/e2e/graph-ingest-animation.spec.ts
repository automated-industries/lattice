import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * 4.3 — live brain-graph ingestion animation. While the graph is the visible
 * view, ingesting a file (which emits source:'ingest' feed events) makes the new
 * object appear on the graph LIVE — no reload — and bubble in (gnode-bubble-in).
 */

let gui: BootedGui;
let srcDir: string;
test.beforeEach(async () => {
  gui = await bootGui();
  srcDir = mkdtempSync(join(tmpdir(), 'lattice-anim-e2e-'));
  writeFileSync(join(srcDir, 'note.txt'), 'hello from an ingested file');
});
test.afterEach(async () => {
  await gui.close();
  rmSync(srcDir, { recursive: true, force: true });
});

test('a newly ingested object bubbles into the graph live (no reload)', async ({ page }) => {
  // Seed one object so the graph is non-empty + the delta baseline is established.
  await createRow(gui.url, 'items', { name: 'seed' });
  await page.goto(gui.url + '#/graph');
  await expect(page.locator('g.gnode[data-table="items"]')).toBeVisible({ timeout: 5000 });
  // `files` has no rows yet → no node.
  await expect(page.locator('g.gnode[data-table="files"]')).toHaveCount(0);

  // Ingest a file via the real API; the server emits source:'ingest' feed events
  // over the stream the page is listening on.
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  // The files node appears LIVE (the animation re-rendered the graph in place)…
  const filesNode = page.locator('g.gnode[data-table="files"]');
  await expect(filesNode).toBeVisible({ timeout: 10000 });
  // …and bubbles in (the delta animation marked the new node).
  await expect(filesNode).toHaveClass(/gnode-bubble-in/, { timeout: 10000 });
});
