import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * GET /api/files/:id/blob + POST /api/files/:id/open-in-finder error/gate paths
 * — all coverable without a real binary file or spawning a process.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-blob-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'LATTICE_LOCAL_OPEN']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'blob-test-key';
  delete process.env.LATTICE_LOCAL_OPEN;
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-blob-'));
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

async function ingestText(url: string): Promise<string> {
  const res = await fetch(`${url}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'note.txt', text: 'just some text' }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('files blob + open-in-finder', () => {
  it('404s the blob for an unknown file id', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/files/does-not-exist/blob`);
    expect(r.status).toBe(404);
    expect(String((await r.json()).error)).toMatch(/not found/i);
  });

  it('404s the blob for a text-only file (no underlying bytes)', async () => {
    const s = await boot();
    const id = await ingestText(s.url);
    const r = await fetch(`${s.url}/api/files/${id}/blob`);
    expect(r.status).toBe(404);
    expect(String((await r.json()).error)).toMatch(/no underlying blob/i);
  });

  it('reports open-in-finder disabled unless LATTICE_LOCAL_OPEN=1', async () => {
    const s = await boot();
    const id = await ingestText(s.url);
    const r = await fetch(`${s.url}/api/files/${id}/open-in-finder`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await r.json()).enabled).toBe(false);
  });

  it('404s open-in-finder for a text-only file when local-open is enabled', async () => {
    process.env.LATTICE_LOCAL_OPEN = '1';
    const s = await boot();
    const id = await ingestText(s.url);
    const r = await fetch(`${s.url}/api/files/${id}/open-in-finder`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(String((await r.json()).error)).toMatch(/no local path/i);
  });
});
