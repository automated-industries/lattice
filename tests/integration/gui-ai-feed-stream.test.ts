import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { waitForStreamMessage } from './stream-helper.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeMinimalConfig(): { configPath: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-feed-'));
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
  return { configPath, outputDir: join(root, 'context') };
}

/**
 * Wait for a `feed` message on the multiplexed `/api/stream` WebSocket whose
 * payload satisfies `match`.
 */
function waitForFeedEvent(
  url: string,
  match: (e: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return waitForStreamMessage(url, 'feed', match, timeoutMs);
}

describe('GUI activity feed stream', () => {
  it('publishes an insert event when a row is created', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Start listening first, then trigger the mutation, then await the event.
    const eventPromise = waitForFeedEvent(
      server.url,
      (e) => e.op === 'insert' && e.table === 'teams',
    );

    // Give the SSE connection a moment to attach before mutating.
    await new Promise((r) => setTimeout(r, 100));
    const post = await fetch(`${server.url}/api/tables/teams/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Feed Team' }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const event = await eventPromise;
    expect(event.op).toBe('insert');
    expect(event.table).toBe('teams');
    expect(event.source).toBe('gui');
    expect(event.rowId).toBe(id);
    expect(typeof event.seq).toBe('number');
    expect(typeof event.summary).toBe('string');
  });
});
