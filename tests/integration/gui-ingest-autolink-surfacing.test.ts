import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #6 — ingest auto-link must SURFACE failures (Rule 16), not silently return [].
// Here createAnthropicClient throws, simulating an LLM-client init failure; the
// auto-link path must log loudly (previously it swallowed the error with a bare
// `catch { return []; }`) while still ingesting the file.
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return {
    ...(actual as object),
    createAnthropicClient: () => {
      throw new Error('init boom');
    },
  };
});
vi.mock('../../src/gui/ai/summarize.js', async (orig) => {
  const actual = await orig();
  return {
    ...(actual as object),
    summarizeText: () => Promise.resolve('summary'),
    classifyLinks: () => Promise.resolve([]),
    extractObjects: () => Promise.resolve([]),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-al-cfg-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'al-test-key';
});
afterEach(async () => {
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-al-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  projects:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: projects.md',
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

describe('#6 ingest auto-link surfaces failures (Rule 16)', () => {
  it('logs a failed LLM client init loudly instead of swallowing it', async () => {
    const server = await boot();
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Notes about the quarterly plan', title: 'memo' }),
    });
    const body = (await res.json()) as { id?: string };
    spy.mockRestore();

    // The file still ingests (auto-link degrades gracefully)...
    expect(res.ok).toBe(true);
    expect(body.id).toBeTruthy();
    // ...but the auto-link failure was surfaced loudly (was a silent `catch {}`).
    expect(errs.some((m) => m.includes('[ingest]') && /client init failed/i.test(m))).toBe(true);
  });
});
