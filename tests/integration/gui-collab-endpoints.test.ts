import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * The team-collaboration read endpoints (last-edited-by, per-row history,
 * team users) degrade cleanly on a local SQLite DB — no team context, so
 * they return empty rather than erroring. The populated cloud behaviour is
 * verified manually against a real Postgres team at release time.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-collab-'));
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
      '      label: { type: text }',
      '    outputFile: widgets.md',
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

async function getJson(url: string): Promise<Record<string, unknown>> {
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

describe('team collaboration endpoints (local fallbacks)', () => {
  it('GET /api/team/users returns an empty list on local', async () => {
    const s = await boot();
    expect(await getJson(`${s.url}/api/team/users`)).toEqual({ users: [] });
  });

  it('GET /api/tables/:table/last-edited returns empty edits on local', async () => {
    const s = await boot();
    expect(await getJson(`${s.url}/api/tables/widgets/last-edited`)).toEqual({ edits: {} });
  });

  it('writes to an unknown table return 400 (not the cloud entity_unshared 409) on local', async () => {
    const s = await boot();
    const res = await fetch(`${s.url}/api/tables/nope/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID() }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown table/i);
  });

  it('GET /api/tables/:table/rows/:id/history returns empty history on local', async () => {
    const s = await boot();
    // Create a real row first so the path is exercised against a live id.
    const created = (await (
      await fetch(`${s.url}/api/tables/widgets/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: randomUUID(), label: 'A' }),
      })
    ).json()) as { id: string };
    expect(await getJson(`${s.url}/api/tables/widgets/rows/${created.id}/history`)).toEqual({
      history: [],
    });
  });
});
