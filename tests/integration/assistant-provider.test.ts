import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Connecting an OpenAI-compatible endpoint as the assistant backend, the same way a
 * Claude subscription is connected: save → it becomes active + reported connected;
 * switch → active flips; disconnect → falls back to Anthropic. No key is ever returned.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-provider-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY']) {
    saved[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'provider-endpoint-key';
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-provider-'));
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
      '      deleted_at: { type: text }',
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

const getConfig = (url: string) =>
  fetch(`${url}/api/assistant/config`).then((r) => r.json()) as Promise<Record<string, unknown>>;

describe('OpenAI-compatible provider connect endpoints', () => {
  it('connects, reports status (no key leaked), switches, and disconnects', async () => {
    const { url } = await boot();

    // Initially nothing is configured.
    let cfg = await getConfig(url);
    expect(cfg.connected).toBe(false);
    expect(cfg.activeProvider).toBe('anthropic');
    expect(cfg.openaiCompat).toEqual({ configured: false, model: null, baseUrl: null });

    // Connect an OpenAI-compatible endpoint.
    const connect = await fetch(`${url}/api/assistant/provider/openai-compat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
        model: 'gpt-4o',
      }),
    });
    expect(connect.status).toBe(200);

    cfg = await getConfig(url);
    expect(cfg.connected).toBe(true); // configured endpoint counts as connected
    expect(cfg.activeProvider).toBe('openai_compat');
    expect(cfg.openaiCompat).toEqual({
      configured: true,
      model: 'gpt-4o',
      baseUrl: 'https://api.example.com/v1',
    });
    // The API key is NEVER echoed back anywhere in the config.
    expect(JSON.stringify(cfg)).not.toContain('sk-secret');

    // Switch active provider back to Anthropic (endpoint stays configured).
    const sel = await fetch(`${url}/api/assistant/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    });
    expect(sel.status).toBe(200);
    cfg = await getConfig(url);
    expect(cfg.activeProvider).toBe('anthropic');
    expect((cfg.openaiCompat as { configured: boolean }).configured).toBe(true);

    // Disconnect the endpoint → active falls back to Anthropic, connected false.
    const del = await fetch(`${url}/api/assistant/provider/openai-compat`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    cfg = await getConfig(url);
    expect(cfg.connected).toBe(false);
    expect(cfg.activeProvider).toBe('anthropic');
    expect((cfg.openaiCompat as { configured: boolean }).configured).toBe(false);
  });

  it('validates input and refuses selecting an unconfigured provider', async () => {
    const { url } = await boot();
    const bad = (body: unknown) =>
      fetch(`${url}/api/assistant/provider/openai-compat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await bad({ baseUrl: 'not-a-url', model: 'm' })).status).toBe(400);
    expect((await bad({ baseUrl: 'https://x/v1' })).status).toBe(400); // no model

    const sel = await fetch(`${url}/api/assistant/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai_compat' }), // not configured
    });
    expect(sel.status).toBe(400);
  });
});
