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

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-threads-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    ['db: ./data/test.db', '', 'entities:', '  notes:', '    fields:', '      id: { type: uuid, primaryKey: true }', '      body: { type: text }', '    render: default-list', '    outputFile: notes.md', ''].join('\n'),
  );
  const server = await startGuiServer({ configPath, outputDir: join(root, 'context'), port: 0, openBrowser: false });
  servers.push(server);
  return server;
}

async function insert(url: string, table: string, row: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${url}/api/tables/${table}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('chat thread endpoints', () => {
  it('lists threads and replays a conversation in order', async () => {
    const server = await boot();
    const tid = await insert(server.url, 'chat_threads', { id: 't1', title: 'Greetings' });
    await insert(server.url, 'chat_messages', {
      thread_id: tid,
      role: 'user',
      content_json: JSON.stringify({ text: 'hello' }),
      source: 'gui',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insert(server.url, 'chat_messages', {
      thread_id: tid,
      role: 'assistant',
      content_json: JSON.stringify({ text: 'hi there' }),
      source: 'ai',
      created_at: '2026-01-01T00:00:01.000Z',
    });

    const list = (await fetch(`${server.url}/api/chat/threads`).then((r) => r.json())) as {
      threads: { id: string; title: string }[];
    };
    expect(list.threads.some((t) => t.id === 't1' && t.title === 'Greetings')).toBe(true);

    const replay = (await fetch(`${server.url}/api/chat/threads/t1/messages`).then((r) => r.json())) as {
      messages: { role: string; text: string }[];
    };
    expect(replay.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
  });
});
