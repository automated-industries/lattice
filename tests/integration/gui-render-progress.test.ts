import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { waitForStreamMessage } from './stream-helper.js';

/**
 * v3.1 async background render: opening a workspace no longer blocks on render —
 * the server starts serving immediately and renders in the background, exposing a
 * live snapshot over `GET /api/render/status` and `render-progress` /
 * `render-snapshot` messages on the multiplexed `/api/stream` WebSocket (which
 * replays a `render-snapshot` on connect, so a tab that connects after a fast
 * render still paints). Also covers the owner-gated cloud-config endpoints
 * refusing a non-cloud (SQLite) database.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-rp-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  teams:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    render: default-list',
      '    outputFile: teams.md',
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

/** Wait for a typed render message on the multiplexed `/api/stream` WebSocket. */
function firstRenderEvent(
  url: string,
  type: 'render-snapshot' | 'render-progress',
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return waitForStreamMessage(url, type, () => true, timeoutMs);
}

describe('GUI background render progress', () => {
  it('serves /api/render/status with a snapshot shape (open never blocks)', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/render/status`);
    expect(r.status).toBe(200);
    const snap = (await r.json()) as { phase?: string; tables?: Record<string, unknown> };
    expect(typeof snap.phase).toBe('string'); // idle | running | done | error
    expect(snap.tables && typeof snap.tables === 'object').toBe(true);
  });

  it('replays a snapshot on WebSocket connect (covers connect-after-fast-render)', async () => {
    const s = await boot();
    const snap = await firstRenderEvent(s.url, 'render-snapshot');
    expect(typeof snap.phase).toBe('string');
    expect(snap.tables && typeof snap.tables === 'object').toBe(true);
  });
});

describe('cloud-config endpoints refuse a non-cloud (SQLite) DB', () => {
  it('POST default-row-visibility 400s on a local database', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/schema/entities/teams/default-row-visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'everyone' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST never-share 400s on a local database', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/schema/entities/teams/never-share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    expect(r.status).toBe(400);
  });
});
