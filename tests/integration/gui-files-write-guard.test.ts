import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Regression (S1, write side): the generic row route must NOT let a caller set a `files` row's
 * byte-LOCATION columns (ref_kind / ref_uri / ref_provider / blob_path / source_json). Forging
 * those let an attacker point a row at any host path (`/etc/passwd`, `/proc/self/environ`) or S3
 * bucket, then read it via `GET /api/files/:id/blob`. Only the server-side ingest/upload path
 * sets them; the HTTP route now refuses them (metadata columns stay editable).
 */
const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-files-guard-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'files-guard-test-key';
});
afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const cfgDir = dirs[dirs.length - 1]!;
  mkdirSync(join(cfgDir, 'data'), { recursive: true });
  const configPath = join(cfgDir, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '',
    ].join('\n'),
    'utf8',
  );
  const outputDir = join(resolve(configPath, '..'), 'context');
  mkdirSync(outputDir, { recursive: true });
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(handle);
  return handle;
}

async function postFiles(url: string, body: unknown): Promise<number> {
  const res = await fetch(`${url}/api/tables/files/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('generic files write refuses forged byte-location columns (S1)', () => {
  for (const col of ['ref_kind', 'ref_uri', 'ref_provider', 'blob_path', 'source_json']) {
    it(`refuses POST /api/tables/files/rows setting ${col} (403)`, async () => {
      const h = await boot();
      const body: Record<string, unknown> = { original_name: 'x' };
      body[col] = col === 'ref_kind' ? 'local_ref' : '/etc/passwd';
      expect(await postFiles(h.url, body)).toBe(403);
    });
  }

  it('the classic exploit shape (local_ref → /etc/passwd) is refused', async () => {
    const h = await boot();
    expect(
      await postFiles(h.url, {
        ref_kind: 'local_ref',
        ref_uri: '/etc/passwd',
        original_name: 'passwd',
      }),
    ).toBe(403);
  });

  it('a metadata-only files write is still allowed (does not touch location columns)', async () => {
    const h = await boot();
    // No location column → the location guard does not fire (may 4xx for other schema reasons,
    // but specifically NOT the 403 location refusal).
    const res = await fetch(`${h.url}/api/tables/files/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ original_name: 'note', artifact_type: 'note' }),
    });
    expect(res.status).not.toBe(403);
  });
});
