import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

// Bug #2 (3.0.1): opening an object used to preload entire related tables
// (≤500 rows each, over the network) to compute relationship-folder counts and
// parent-link names — slow on a remote cloud Postgres. The fix fills counts via
// a cheap indexed /count endpoint and parent names via a single-row fetch, with
// no whole-table download. This test proves it end-to-end against the real bundle.

let server: GuiServerHandle;
let configDir: string;
let projectId: string;

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

test.beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'lattice-e2e-objperf-'));
  process.env.LATTICE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lattice-e2e-objperf-home-'));
  process.env.LATTICE_ENCRYPTION_KEY = 'e2e-objperf-key';
  const configPath = join(configDir, 'lattice.config.yml');
  // projects 1──* tasks (tasks.project_id → belongsTo projects; projects → hasMany tasks).
  writeFileSync(
    configPath,
    [
      'db: ./data/main.db',
      'name: main',
      '',
      'entities:',
      '  projects:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      project_id: { type: uuid, ref: projects }',
      '      deleted_at: { type: text }',
      '',
    ].join('\n'),
  );
  const outputDir = join(resolve(configPath, '..'), 'context');
  mkdirSync(outputDir, { recursive: true });
  server = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });

  projectId = (await api('/api/tables/projects/rows', { name: 'Apollo' })).id as string;
  for (const title of ['Design', 'Build', 'Ship']) {
    await api('/api/tables/tasks/rows', { title, project_id: projectId });
  }
});

test.afterAll(async () => {
  await server.close();
  rmSync(configDir, { recursive: true, force: true });
});

test('opening an object fills folder counts via /count, with no whole-table fetch of the related table', async ({
  page,
}) => {
  const tableReqs: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/tables/')) tableReqs.push(u.pathname + u.search);
  });

  await page.goto(`${server.url}#/fs/projects/${projectId}`);

  // The "Tasks" relationship folder badge resolves from "…" to the real count.
  const badge = page.locator('.fs-folder-count');
  await expect(badge.first()).toHaveText('3 items');

  // It used the cheap count endpoint…
  expect(tableReqs.some((p) => /^\/api\/tables\/tasks\/count(\?|$)/.test(p))).toBe(true);
  // …and never downloaded the whole tasks table (the old behavior: GET
  // /api/tables/tasks/rows with no id).
  expect(tableReqs.some((p) => /^\/api\/tables\/tasks\/rows(\?|$)/.test(p))).toBe(false);
});

test('a parent link resolves its name via a single-row fetch (not a whole-table download)', async ({
  page,
}) => {
  const taskId = (await api('/api/tables/tasks/rows', { title: 'Plan', project_id: projectId }))
    .id as string;

  const tableReqs: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/tables/')) tableReqs.push(u.pathname);
  });

  await page.goto(`${server.url}#/fs/tasks/${taskId}`);

  // The "Project" parent link shows the resolved name (filled async).
  await expect(page.locator('.fs-link .bt-name')).toHaveText('Apollo');

  // Resolved by fetching the one referenced project row — not the whole table.
  expect(tableReqs).toContain(`/api/tables/projects/rows/${projectId}`);
  expect(tableReqs.some((p) => /^\/api\/tables\/projects\/rows$/.test(p))).toBe(false);
});
