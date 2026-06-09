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
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    render: default-list',
      '    outputFile: notes.md',
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

    const replay = (await fetch(`${server.url}/api/chat/threads/t1/messages`).then((r) =>
      r.json(),
    )) as {
      messages: { role: string; text: string }[];
    };
    expect(replay.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
  });

  it("replays an assistant turn's persisted data-change events (rail activity cards)", async () => {
    const server = await boot();
    await insert(server.url, 'chat_threads', { id: 't2', title: 'Cleanup' });
    await insert(server.url, 'chat_messages', {
      thread_id: 't2',
      role: 'assistant',
      // A turn that deleted two tables, persisted the way runChat now records it:
      // per-turn `events` (mutations only) drive the collapsed replay cards.
      content_json: JSON.stringify({
        text: 'Done — removed them.',
        turns: [
          {
            text: 'Done — removed them.',
            tools: [{ name: 'delete_entity', isError: false }],
            events: [
              { op: 'schema.delete_entity', table: 'a', rowId: null, summary: 'Deleted table a' },
              { op: 'schema.delete_entity', table: 'b', rowId: null, summary: 'Deleted table b' },
            ],
            // SERVER-SIDE-ONLY detail must NOT survive into the replay response.
            toolCalls: [
              { id: 'u1', name: 'delete_entity', input: {}, content: '{}', isError: false },
            ],
          },
        ],
      }),
      source: 'ai',
      created_at: '2026-01-02T00:00:01.000Z',
    });

    const replay = (await fetch(`${server.url}/api/chat/threads/t2/messages`).then((r) =>
      r.json(),
    )) as {
      messages: {
        role: string;
        turns?: {
          events?: { op: string; table: string | null; summary: string }[];
          toolCalls?: unknown[];
        }[];
      }[];
    };
    const asst = replay.messages.find((m) => m.role === 'assistant');
    expect(asst?.turns?.[0]?.events?.length).toBe(2);
    expect(asst?.turns?.[0]?.events?.[0]?.op).toBe('schema.delete_entity');
    expect(asst?.turns?.[0]?.events?.[1]?.summary).toBe('Deleted table b');
    // toolCalls are server-side memory only — stripped from the GUI replay.
    expect(asst?.turns?.[0]?.toolCalls).toBeUndefined();
  });
});
