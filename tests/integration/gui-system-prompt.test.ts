/**
 * The /api/cloud/system-prompt route on a LOCAL (SQLite) workspace: there's no
 * cloud, so the GET reports it's unsupported (the UI hides the editor) and the
 * POST refuses. The owner/member gating + DB enforcement on a real cloud is proven
 * in cloud-system-prompt-postgres.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV = ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY'];

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-sp-cfg-'));
  dirs.push(cfgDir);
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'sp-test-key';
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-sp-'));
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
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

describe('system-prompt route on a local workspace', () => {
  it('GET reports unsupported (no cloud) and never returns prompt text', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/cloud/system-prompt`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { supported?: boolean; canEdit?: boolean; prompt?: unknown };
    expect(body.supported).toBe(false);
    expect(body.canEdit).toBe(false);
    expect(body.prompt).toBeUndefined();
  });

  it('POST refuses with 400 on a non-cloud database', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/cloud/system-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'should not save' }),
    });
    expect(r.status).toBe(400);
  });
});
