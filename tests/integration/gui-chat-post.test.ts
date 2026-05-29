import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * POST /api/chat — the assistant chat stream. We can exercise everything except
 * the live model round-trip without an API key:
 *   - no auth configured → 400
 *   - empty message (auth present) → 400
 *   - a real message persists the thread + user message before streaming; the
 *     model call is pointed at a dead endpoint so the stream fails fast and the
 *     handler still completes (covers the persist + streaming-catch paths).
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-chatpost-cfg-'));
  dirs.push(cfgDir);
  for (const k of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ENCRYPTION_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'chatpost-test-key';
  delete process.env.ANTHROPIC_API_KEY; // no ambient key should grant auth
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-chatpost-'));
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
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

async function setKey(url: string): Promise<void> {
  await fetch(`${url}/api/assistant/key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'anthropic', key: 'sk-ant-test-key' }),
  });
}

describe('POST /api/chat', () => {
  it('400s when no Claude auth is configured', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json()).error)).toMatch(/No Claude auth/i);
  });

  it('400s on an empty message once auth is set', async () => {
    const s = await boot();
    await setKey(s.url);
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json()).error)).toMatch(/message is required/i);
  });

  it('persists the thread + user message before streaming, then completes when the model call fails', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // nothing listens → fails fast
    const s = await boot();
    await setKey(s.url);
    const r = await fetch(`${s.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'remember this' }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-thread-id')).toBeTruthy();
    await r.text(); // drain the SSE stream — the handler ends after the failed call

    const threads = (await fetch(`${s.url}/api/chat/threads`).then((x) => x.json())) as {
      threads: { id: string }[];
    };
    expect(threads.threads.length).toBeGreaterThanOrEqual(1);
    const tid = threads.threads[0]!.id;
    const msgs = (await fetch(`${s.url}/api/chat/threads/${tid}/messages`).then((x) =>
      x.json(),
    )) as {
      messages: { role: string; text: string }[];
    };
    expect(msgs.messages.some((m) => m.role === 'user' && m.text === 'remember this')).toBe(true);
  });
});
