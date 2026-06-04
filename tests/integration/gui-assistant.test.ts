import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  // Isolate the env fallback so assertions reflect only the stored DB row.
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeMinimalConfig(): { configPath: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-assistant-'));
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

describe('assistant key storage', () => {
  it('reports no key, accepts one, then clears it — never returning the value', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const cfg0 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    };
    expect(cfg0.hasAnthropicKey).toBe(false);

    const put = await fetch(`${server.url}/api/assistant/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-test-do-not-use' }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as Record<string, unknown>;
    expect(putBody.ok).toBe(true);
    // The endpoint must never echo the stored token back.
    expect(JSON.stringify(putBody)).not.toContain('sk-ant-test-do-not-use');

    const cfg1 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    } & Record<string, unknown>;
    expect(cfg1.hasAnthropicKey).toBe(true);
    expect(JSON.stringify(cfg1)).not.toContain('sk-ant-test-do-not-use');

    const del = await fetch(`${server.url}/api/assistant/key`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const cfg2 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    };
    expect(cfg2.hasAnthropicKey).toBe(false);
  });

  it('stores + clears an explicit voice-provider preference', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const cfg0 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      sttPreference: string;
    };
    expect(cfg0.sttPreference).toBe('auto');

    const put = await fetch(`${server.url}/api/assistant/stt-provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs' }),
    });
    expect(put.status).toBe(200);
    const cfg1 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      sttPreference: string;
    };
    expect(cfg1.sttPreference).toBe('elevenlabs');

    await fetch(`${server.url}/api/assistant/stt-provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'auto' }),
    });
    const cfg2 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      sttPreference: string;
    };
    expect(cfg2.sttPreference).toBe('auto');

    const bad = await fetch(`${server.url}/api/assistant/stt-provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects an empty key with 400', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);
    const res = await fetch(`${server.url}/api/assistant/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('falls back to the ANTHROPIC_API_KEY env var for presence', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';
    const cfg = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    };
    expect(cfg.hasAnthropicKey).toBe(true);
  });
});
