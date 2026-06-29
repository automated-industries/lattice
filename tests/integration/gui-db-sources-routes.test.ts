import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

// Routes for connecting an external database as an Input (`/api/db-sources`).
// These cover the deterministic paths that need no real external DB — listing,
// the connect error paths (missing creds, unsupported dialect), and unknown-id
// guards. The real connect→introspect→import path is covered by the gated
// db-source-import-postgres integration test.

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'lattice-dbsrc-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const s = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(s);
  return s;
}

const get = (s: GuiServerHandle, p: string) => fetch(`${s.url}${p}`);
const post = (s: GuiServerHandle, p: string, body?: unknown) =>
  fetch(`${s.url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('/api/db-sources', () => {
  it('lists no connected databases on a fresh workspace', async () => {
    const s = await boot();
    const r = await get(s, '/api/db-sources');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { sources: unknown[] }).sources).toEqual([]);
  });

  it('rejects a connect with no credentials (422)', async () => {
    const s = await boot();
    const r = await post(s, '/api/db-sources/connect', {});
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/connection string|host/i);
  });

  it('rejects a non-Postgres connection string (422)', async () => {
    const s = await boot();
    const r = await post(s, '/api/db-sources/connect', { connectionString: 'mysql://h/db' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/Postgres-family/);
  });

  it('404s an unknown connection on tables / refresh / delete', async () => {
    const s = await boot();
    expect(
      (await get(s, '/api/db-sources/00000000-0000-0000-0000-000000000000/tables')).status,
    ).toBe(404);
    expect(
      (await post(s, '/api/db-sources/00000000-0000-0000-0000-000000000000/refresh')).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${s.url}/api/db-sources/00000000-0000-0000-0000-000000000000`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
  });
});
