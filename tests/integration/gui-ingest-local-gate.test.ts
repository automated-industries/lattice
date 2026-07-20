import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Regression (S2): `/api/ingest/file` (body.path) reads an ARBITRARY path off the server's disk.
 * It is now gated behind `localFileOpenEnabled()` (LATTICE_LOCAL_OPEN), which is OFF on team
 * cloud — so a hosted tenant can no longer POST {path:'/proc/self/environ'} and read
 * host/cross-tenant secrets. With local open enabled (desktop/CLI, the default) local ingest
 * still works.
 *
 * The `/api/ingest/*` family is behind a "provider connected" gate (`claude_not_connected`) that
 * runs FIRST, so these tests set the managed model auth so a provider resolves — otherwise every
 * request 403s before reaching the local-open gate, and we'd be asserting the wrong 403. We then
 * assert the SPECIFIC error text to prove which gate fired.
 */
const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'LATTICE_CONFIG_DIR',
  'LATTICE_ENCRYPTION_KEY',
  'LATTICE_LOCAL_OPEN',
  'LATTICE_MANAGED_MODEL_AUTH',
  'ANTHROPIC_API_KEY',
];

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-ingest-gate-'));
  dirs.push(cfgDir);
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'ingest-gate-test-key';
  // Managed provider present → the assistant gate passes, so the request reaches the local-open
  // gate under test. (No real model call is made; /api/ingest/file's extraction records failures
  // on the row rather than throwing.)
  process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
  process.env.ANTHROPIC_API_KEY = 'test-managed-key';
});
afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = savedEnv[k];
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

async function ingestFile(url: string, path: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${url}/api/ingest/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error };
}

describe('local file ingest is gated by localFileOpenEnabled (S2)', () => {
  it('refuses /api/ingest/file when local open is disabled (cloud) — with the local-open error, not the AI gate', async () => {
    process.env.LATTICE_LOCAL_OPEN = '0';
    const h = await boot();
    const r = await ingestFile(h.url, '/etc/hosts');
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/local file ingest is disabled/i); // MY gate, not claude_not_connected
  });

  it('the classic exploit (/proc/self/environ) is refused on cloud', async () => {
    process.env.LATTICE_LOCAL_OPEN = '0';
    const h = await boot();
    const r = await ingestFile(h.url, '/proc/self/environ');
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/local file ingest is disabled/i);
  });

  it('does NOT hit the local-open gate when it is enabled (desktop/CLI default)', async () => {
    delete process.env.LATTICE_LOCAL_OPEN; // default: enabled
    const h = await boot();
    const f = join(dirs[dirs.length - 1]!, 'note.txt');
    writeFileSync(f, 'hello from a local file');
    const r = await ingestFile(h.url, f);
    // The local-open gate is passed (the file is read); extraction may fail on the fake managed
    // key, but that is recorded on the row (201), never the local-open 403 refusal.
    expect(r.error ?? '').not.toMatch(/local file ingest is disabled/i);
    expect(r.status).not.toBe(403);
  });
});
