import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

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
 * Read the feed SSE stream until a parsed `data:` event satisfies `match`,
 * or reject after `timeoutMs`. Returns the matching event.
 */
async function waitForFeedEvent(
  url: string,
  match: (e: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${url}/api/feed/stream`, { signal: ac.signal });
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
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const json = dataLine.slice('data:'.length).trim();
        if (!json) continue;
        const event = JSON.parse(json) as Record<string, unknown>;
        if (match(event)) return event;
      }
    }
    throw new Error('feed stream closed before a matching event');
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
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
    // The bubble names the row by its title-ish column, not a faceless "a row".
    expect(event.summary).toBe('Added Feed Team to teams');
  });

  it('keeps an open stream alive across a schema reopen (feed bus survives)', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // One long-lived stream connection, opened BEFORE the schema change.
    // Creating an entity disposes + re-opens the active DB; the connection's
    // feed subscription must survive that reopen, or the activity rail (and the
    // live sidebar refresh that keys off it) silently goes dead after the first
    // data-model edit. The schema event is published AFTER the reopen, so
    // receiving it on this pre-existing stream proves the bus was preserved.
    const eventPromise = waitForFeedEvent(
      server.url,
      (e) => e.op === 'schema' && e.table === 'widgets',
    );

    await new Promise((r) => setTimeout(r, 100));
    const post = await fetch(`${server.url}/api/schema/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'widgets' }),
    });
    expect(post.status).toBe(200);

    const event = await eventPromise;
    expect(event.op).toBe('schema');
    expect(event.table).toBe('widgets');
  });

  it('streams only NEW events — no audit backfill (the rail is conversation-scoped)', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // A pre-existing edit BEFORE connecting — it lands in the audit log only.
    const pre = await fetch(`${server.url}/api/tables/teams/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pre-existing Team' }),
    });
    const { id: preId } = (await pre.json()) as { id: string };

    // Connect, then make a NEW edit. The stream carries new events only — the
    // global audit backfill was removed (history replays per-conversation from
    // the persisted per-turn events). So the FIRST insert this stream sees must
    // be the NEW row, never the pre-existing one.
    const eventPromise = waitForFeedEvent(
      server.url,
      (e) => e.op === 'insert' && e.table === 'teams',
    );
    await new Promise((r) => setTimeout(r, 100));
    const post = await fetch(`${server.url}/api/tables/teams/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Team' }),
    });
    const { id: newId } = (await post.json()) as { id: string };

    const event = await eventPromise;
    expect(event.rowId).toBe(newId);
    expect(event.rowId).not.toBe(preId);
    expect(event.summary).toBe('Added New Team to teams');
  });
});
