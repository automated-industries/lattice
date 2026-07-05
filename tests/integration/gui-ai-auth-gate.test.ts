import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { resolveClaudeAuth, isClaudeConnected } from '../../src/gui/assistant-routes.js';
import { seedClaudeOAuth, clearClaudeOAuth } from '../helpers/claude-auth.js';

/**
 * Phase 1 backbone: Claude access is OAuth-only and enforced SERVER-SIDE. A
 * hidden client button can't gate the AI routes (they're directly HTTP-reachable),
 * so a single gate refuses every AI-mutating route with 403 `claude_not_connected`
 * when no subscription is connected — proven here without any client rendering.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-authgate-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'authgate-test-key';
  delete process.env.ANTHROPIC_API_KEY;
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-authgate-'));
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

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('AI-auth gate (server-side)', () => {
  it('refuses every AI-mutating route with 403 claude_not_connected when disconnected', async () => {
    const s = await boot();
    for (const path of [
      '/api/chat',
      '/api/ingest/url',
      '/api/import/apply',
      '/api/questions/q1/answer',
    ]) {
      const r = await post(s.url, path, { message: 'hi' });
      expect(r.status, `${path} should be gated`).toBe(403);
      expect(String((await r.json()).error)).toBe('claude_not_connected');
    }
  });

  it('lets AI routes through once a Claude subscription is connected', async () => {
    const s = await boot();
    seedClaudeOAuth();
    // The gate passes → the chat handler runs and rejects the empty message with
    // its own 400 (NOT the gate's 403), proving the request reached the handler.
    const r = await post(s.url, '/api/chat', { message: '   ' });
    expect(r.status).toBe(400);
    expect(String((await r.json()).error)).toMatch(/message is required/i);
  });

  it('GET /api/assistant/config reports the single connected truth', async () => {
    const s = await boot();
    const before = await fetch(`${s.url}/api/assistant/config`).then((x) => x.json());
    expect(before.connected).toBe(false);
    seedClaudeOAuth();
    const after = await fetch(`${s.url}/api/assistant/config`).then((x) => x.json());
    expect(after.connected).toBe(true);
  });
});

describe('resolveClaudeAuth is OAuth-only (no API-key fallback)', () => {
  it('returns null with a stray ANTHROPIC_API_KEY and no subscription', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-ignored';
    expect(await resolveClaudeAuth(null)).toBeNull();
    expect(await isClaudeConnected(null)).toBe(false);
  });

  it('returns the OAuth authToken when a subscription is connected', async () => {
    seedClaudeOAuth('tok-abc');
    const auth = await resolveClaudeAuth(null);
    expect(auth).toMatchObject({ authToken: 'tok-abc' });
    expect(await isClaudeConnected(null)).toBe(true);
    clearClaudeOAuth();
    expect(await isClaudeConnected(null)).toBe(false);
  });
});
