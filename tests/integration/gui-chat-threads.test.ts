import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-threads-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'threads-test-key';
  // Claude access is OAuth-only: the GET /api/chat/* thread-replay routes sit
  // behind the server's AI-auth gate, which refuses them with 403
  // `claude_not_connected` when no subscription is connected. Seed a connected
  // subscription AFTER LATTICE_CONFIG_DIR/LATTICE_ENCRYPTION_KEY (the
  // machine-local store is keyed off the config dir + master key). These tests
  // only read persisted threads/messages — no model call is made — so seeding
  // auth is all the gate needs.
  seedClaudeOAuth();
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

  it('persists tool-call error text and includes it in replay', async () => {
    const server = await boot();
    await insert(server.url, 'chat_threads', { id: 't3', title: 'Errors' });
    const errorMsg = 'Failed to update row: constraint violation on unique field';
    await insert(server.url, 'chat_messages', {
      thread_id: 't3',
      role: 'assistant',
      // A turn with an errored tool call, persisted with errorText in toolCalls
      content_json: JSON.stringify({
        text: 'Let me try a different approach.',
        turns: [
          {
            text: 'Let me try a different approach.',
            tools: [
              { name: 'update_row', isError: false },
              { name: 'update_row', isError: true, errorText: errorMsg },
            ],
            events: [],
            // Cross-turn replay memory: includes errorText on errored calls
            toolCalls: [
              { id: 'u1', name: 'update_row', input: { id: 'r1' }, content: '{}', isError: false },
              {
                id: 'u2',
                name: 'update_row',
                input: { id: 'r2' },
                content: JSON.stringify({ error: errorMsg }),
                isError: true,
                errorText: errorMsg,
              },
            ],
          },
        ],
      }),
      source: 'ai',
      created_at: '2026-01-03T00:00:01.000Z',
    });

    const replay = (await fetch(`${server.url}/api/chat/threads/t3/messages`).then((r) =>
      r.json(),
    )) as {
      messages: {
        role: string;
        turns?: {
          tools?: { name: string; isError: boolean; errorText?: string }[];
        }[];
      }[];
    };
    const asst = replay.messages.find((m) => m.role === 'assistant');
    expect(asst?.turns?.[0]?.tools?.length).toBe(2);
    // First tool succeeded — no errorText
    expect(asst?.turns?.[0]?.tools?.[0]).toEqual({
      name: 'update_row',
      isError: false,
    });
    // Second tool failed — errorText is harvested from toolCalls and included
    expect(asst?.turns?.[0]?.tools?.[1]).toEqual({
      name: 'update_row',
      isError: true,
      errorText: errorMsg,
    });
  });

  it('replays threads without errorText (backward-compatible)', async () => {
    const server = await boot();
    await insert(server.url, 'chat_threads', { id: 't4', title: 'Old' });
    await insert(server.url, 'chat_messages', {
      thread_id: 't4',
      role: 'assistant',
      // An old persisted turn without errorText in toolCalls (backward-compat)
      content_json: JSON.stringify({
        text: 'Something went wrong.',
        turns: [
          {
            text: 'Something went wrong.',
            tools: [{ name: 'list_rows', isError: true }],
            events: [],
            // Old toolCalls format: no errorText field
            toolCalls: [
              {
                id: 'u1',
                name: 'list_rows',
                input: { table: 'items' },
                content: JSON.stringify({ error: 'Table not found' }),
                isError: true,
              },
            ],
          },
        ],
      }),
      source: 'ai',
      created_at: '2026-01-04T00:00:01.000Z',
    });

    const replay = (await fetch(`${server.url}/api/chat/threads/t4/messages`).then((r) =>
      r.json(),
    )) as {
      messages: {
        role: string;
        turns?: {
          tools?: { name: string; isError: boolean; errorText?: string }[];
        }[];
      }[];
    };
    const asst = replay.messages.find((m) => m.role === 'assistant');
    // Tool is present and marked as error; errorText is undefined (not in old record)
    expect(asst?.turns?.[0]?.tools?.[0]).toEqual({
      name: 'list_rows',
      isError: true,
    });
    expect(asst?.turns?.[0]?.tools?.[0]?.errorText).toBeUndefined();
  });

  it('truncates error text to ~500 chars on persist', async () => {
    const server = await boot();
    await insert(server.url, 'chat_threads', { id: 't5', title: 'LongError' });
    const longError = 'x'.repeat(600);
    await insert(server.url, 'chat_messages', {
      thread_id: 't5',
      role: 'assistant',
      content_json: JSON.stringify({
        text: 'Oops.',
        turns: [
          {
            text: 'Oops.',
            tools: [
              { name: 'create_row', isError: true, errorText: longError.slice(0, 500) + '…' },
            ],
            events: [],
            toolCalls: [
              {
                id: 'u1',
                name: 'create_row',
                input: {},
                content: JSON.stringify({ error: longError }),
                isError: true,
                errorText: longError.slice(0, 500) + '…',
              },
            ],
          },
        ],
      }),
      source: 'ai',
      created_at: '2026-01-05T00:00:01.000Z',
    });

    const replay = (await fetch(`${server.url}/api/chat/threads/t5/messages`).then((r) =>
      r.json(),
    )) as {
      messages: {
        role: string;
        turns?: {
          tools?: { errorText?: string }[];
        }[];
      }[];
    };
    const asst = replay.messages.find((m) => m.role === 'assistant');
    const errorText = asst?.turns?.[0]?.tools?.[0]?.errorText;
    // Verify it's truncated and includes ellipsis
    expect(errorText?.length).toBeLessThanOrEqual(502); // 500 + '…' (3 bytes as UTF-8)
    expect(errorText).toMatch(/^x{500}…$/);
  });
});
