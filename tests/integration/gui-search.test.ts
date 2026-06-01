import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/** GET /api/search — generic full-text search across entities (Phase 1 LIKE). */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-search-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'search-test-key';
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-search-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  widgets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: widgets.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function postRow(url: string, table: string, row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${url}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  expect(r.status).toBeLessThan(300);
}

interface SearchResponse {
  query: string;
  groups: {
    table: string;
    count: number;
    more: boolean;
    hits: { id: string; snippet: string }[];
  }[];
}

describe('GET /api/search', () => {
  it('returns grouped hits across entities with snippets', async () => {
    const s = await boot();
    await postRow(s.url, 'widgets', { title: 'Annual budget planning' });
    await postRow(s.url, 'widgets', { title: 'Grocery list' });

    const res = await fetch(`${s.url}/api/search?q=${encodeURIComponent('budget')}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as SearchResponse;
    expect(d.query).toBe('budget');
    const widgets = d.groups.find((g) => g.table === 'widgets');
    expect(widgets).toBeTruthy();
    expect(widgets?.hits.length).toBe(1);
    expect(widgets?.hits[0]?.snippet.toLowerCase()).toContain('budget');
  });

  it('returns an empty result set for a non-matching query', async () => {
    const s = await boot();
    await postRow(s.url, 'widgets', { title: 'Grocery list' });
    const res = await fetch(`${s.url}/api/search?q=${encodeURIComponent('nonexistent-xyz')}`);
    const d = (await res.json()) as SearchResponse;
    expect(d.groups).toEqual([]);
  });
});
