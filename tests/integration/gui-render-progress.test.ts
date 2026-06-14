import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * v3.1 async background render: opening a workspace no longer blocks on render —
 * the server starts serving immediately and renders in the background, exposing a
 * live snapshot over `GET /api/render/status` and an SSE stream over
 * `GET /api/render/progress` (which replays a `snapshot` event on connect, so a
 * tab that connects after a fast render still paints). Also covers the owner-gated
 * cloud-config endpoints refusing a non-cloud (SQLite) database.
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

/** Read the render SSE until a frame with `event: <name>` arrives; return its parsed data. */
async function firstRenderEvent(
  url: string,
  name: string,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${url}/api/render/progress`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = frame.split('\n');
        const evLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const ev = evLine ? evLine.slice('event:'.length).trim() : 'message';
        if (ev !== name) continue;
        const json = dataLine.slice('data:'.length).trim();
        return JSON.parse(json) as Record<string, unknown>;
      }
    }
    throw new Error(`render stream closed before a "${name}" event`);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
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

  it('replays a snapshot event on SSE connect (covers connect-after-fast-render)', async () => {
    const s = await boot();
    const snap = await firstRenderEvent(s.url, 'snapshot');
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
