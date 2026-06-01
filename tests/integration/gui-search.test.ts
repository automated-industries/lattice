import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * GET /api/search — the non-AI full-text search route the header search bar
 * calls. Exercises the LIKE fallback tier (no per-table `fts` config), grouped
 * by table, scoped to validTables, with an optional `tables=` filter.
 */

interface FtsHit {
  id: string;
  snippet: string;
}
interface FtsGroup {
  table: string;
  count: number;
  more: boolean;
  hits: FtsHit[];
}
interface FtsResult {
  query: string;
  groups: FtsGroup[];
}

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
      '  articles:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      body: { type: text }',
      '    outputFile: articles.md',
      '  gadgets:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      label: { type: text }',
      '    outputFile: gadgets.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function seed(url: string, table: string, row: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${url}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: randomUUID(), ...row }),
  });
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
}

async function search(url: string, qs: string): Promise<FtsResult> {
  return (await (await fetch(`${url}/api/search?${qs}`)).json()) as FtsResult;
}

describe('GET /api/search', () => {
  it('returns hits grouped by table across all visible tables', async () => {
    const s = await boot();
    await seed(s.url, 'articles', { title: 'Kangaroo facts', body: 'a marsupial' });
    await seed(s.url, 'articles', { title: 'Cats', body: 'unrelated' });
    await seed(s.url, 'gadgets', { label: 'kangaroo-shaped stapler' });

    const result = await search(s.url, 'q=kangaroo');
    const byTable = Object.fromEntries(result.groups.map((g) => [g.table, g]));
    expect(byTable.articles?.count).toBe(1);
    expect(byTable.gadgets?.count).toBe(1);
    expect(byTable.articles?.hits[0]?.id).toBeTruthy();
  });

  it('scopes the search to a `tables=` filter', async () => {
    const s = await boot();
    await seed(s.url, 'articles', { title: 'kangaroo', body: 'x' });
    await seed(s.url, 'gadgets', { label: 'kangaroo' });

    const result = await search(s.url, 'q=kangaroo&tables=articles');
    expect(result.groups.map((g) => g.table)).toEqual(['articles']);
  });

  it('returns an empty result for a blank query without touching the DB', async () => {
    const s = await boot();
    const result = await search(s.url, 'q=');
    expect(result.groups).toEqual([]);
  });

  it('returns no groups when nothing matches', async () => {
    const s = await boot();
    await seed(s.url, 'articles', { title: 'nothing relevant here', body: 'x' });
    const result = await search(s.url, 'q=zzzznomatch');
    expect(result.groups).toEqual([]);
  });
});
