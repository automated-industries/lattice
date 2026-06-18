import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { resolveClaudeAuth } from '../../src/gui/assistant-routes.js';
import {
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../src/framework/user-config.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Isolate the env fallback so assertions reflect only the stored credential.
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Credentials are now machine-level (assistant-credentials.enc under the
  // config dir), not in the workspace DB — so point the config dir at a fresh
  // temp dir per test. Without this the store would land in the real ~/.lattice
  // and leak the key between tests (and pollute the dev machine).
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-assistant-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'assistant-test-key';
});

afterEach(async () => {
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
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

  it('keeps a stored key when a different workspace opens (machine-level, not per-DB)', async () => {
    // Workspace A: store the key.
    const a = writeMinimalConfig();
    const serverA = await startGuiServer({
      configPath: a.configPath,
      outputDir: a.outputDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(serverA);
    const put = await fetch(`${serverA.url}/api/assistant/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-cross-workspace' }),
    });
    expect(put.status).toBe(200);

    // Workspace B: a DIFFERENT database (different config + db file), same
    // machine config dir. The key must still be present — this is the
    // regression: creating/switching a workspace used to de-attach it.
    const b = writeMinimalConfig();
    expect(b.configPath).not.toBe(a.configPath);
    const serverB = await startGuiServer({
      configPath: b.configPath,
      outputDir: b.outputDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(serverB);
    const cfgB = (await fetch(`${serverB.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    } & Record<string, unknown>;
    expect(cfgB.hasAnthropicKey).toBe(true);
    expect(JSON.stringify(cfgB)).not.toContain('sk-ant-cross-workspace');
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

  it('clearing the key is authoritative — it suppresses the env fallback and stays cleared', async () => {
    const { configPath, outputDir } = writeMinimalConfig();
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // An env key is present (an env-supplied key the user wants to remove).
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-supplied';

    // Store a key, then clear it via the API.
    const put = await fetch(`${server.url}/api/assistant/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-stored-do-not-use' }),
    });
    expect(put.status).toBe(200);
    const del = await fetch(`${server.url}/api/assistant/key`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    // The config must report NO key — the env fallback is suppressed by the
    // authoritative "cleared" sentinel (this is the bug: env flipped it back to
    // true after clear).
    const cfg = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    };
    expect(cfg.hasAnthropicKey).toBe(false);

    // And the auth resolver returns nothing while cleared (no OAuth set), so the
    // cleared key does NOT resolve via the env var.
    expect(await resolveClaudeAuth(null)).toBeNull();

    // OAuth ALWAYS wins, even with a cleared key + a live env key present.
    setAssistantCredential('claude_oauth', JSON.stringify({ access_token: 'oauth-tok' }));
    try {
      const auth = await resolveClaudeAuth(null);
      expect(auth?.authToken).toBe('oauth-tok');
      expect(auth?.apiKey).toBeUndefined();
    } finally {
      deleteAssistantCredential('claude_oauth');
    }

    // Saving a new key un-clears the sentinel → presence flips back to true.
    const put2 = await fetch(`${server.url}/api/assistant/key`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-fresh-do-not-use' }),
    });
    expect(put2.status).toBe(200);
    const cfg2 = (await fetch(`${server.url}/api/assistant/config`).then((r) => r.json())) as {
      hasAnthropicKey: boolean;
    };
    expect(cfg2.hasAnthropicKey).toBe(true);
  });
});
