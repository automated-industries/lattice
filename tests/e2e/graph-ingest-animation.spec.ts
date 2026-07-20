import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Brain-graph ingestion behavior. A file is a SOURCE, not an object: ingesting
 * one populates the `files` entity (visible in the sidebar Files section /
 * Configure drawer Inputs) but must NOT add a node to the brain graph, which
 * shows object↔object relationships only. The graph now lives in the Configure
 * drawer's own Graph tab (#graph-mount), reached via the `#/graph`
 * deep link; its nodes are still `g.gnode[data-id]`. This guards the "files is
 * hidden from the graph" invariant (GRAPH_HIDDEN_TABLES) end-to-end, and that
 * the graph keeps rendering real objects across an ingest.
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

test('an ingested file does not appear as a brain-graph node (files is a source)', async ({
  page,
}) => {
  // Seed one real object so the graph is non-empty.
  await createRow(gui.url, 'items', { name: 'seed' });
  await page.goto(gui.url + '#/graph');
  // Topology check (items IS a graph node): assert the node is present, not that
  // the force-graph reveal animation has finished — the reveal is slow in headless
  // CI and is covered separately by graph-layout.spec.
  await expect(page.locator('g.gnode[data-id="items"]')).toHaveCount(1, { timeout: 10000 });
  // No files yet → no files node (files is never a graph node regardless).
  await expect(page.locator('g.gnode[data-id="files"]')).toHaveCount(0);

  // Ingest a real file via the API.
  const res = await page.request.post(gui.url + '/api/sources/roots', {
    data: { path: srcDir, kind: 'folder' },
  });
  expect(res.ok()).toBeTruthy();

  // The file really landed (a `files` row now exists server-side)…
  await expect
    .poll(
      async () => {
        const r = await page.request.get(gui.url + '/api/tables/files/rows');
        if (!r.ok()) return 0;
        const body = await r.json();
        const rows = Array.isArray(body) ? body : (body.rows ?? []);
        return rows.length;
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);

  // …but reloading the graph shows NO files node (files is a source, not an
  // object), while the real `items` object remains.
  await page.reload();
  // Topology check (items IS a graph node): assert the node is present, not that
  // the force-graph reveal animation has finished — the reveal is slow in headless
  // CI and is covered separately by graph-layout.spec.
  await expect(page.locator('g.gnode[data-id="items"]')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('g.gnode[data-id="files"]')).toHaveCount(0);
});
