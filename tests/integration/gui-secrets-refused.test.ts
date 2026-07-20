import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Regression (S4): the generic row-CRUD route must NOT expose the `secrets` table. `secrets.value`
 * is encrypted-at-rest and DECRYPTED on read, so a bare `GET /api/tables/secrets/rows` used to
 * ship cleartext API keys / OAuth tokens as JSON — the payload for the DNS-rebinding gap (S5).
 * There is no dedicated secrets HTTP route and the GUI never reads secrets this way, so the route
 * refuses the table outright (read AND write). A normal user table stays fully served.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-secrets-refuse-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'secrets-refuse-test-key';
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

describe('generic table route refuses the secrets credential store (S4)', () => {
  it('GET /api/tables/secrets/rows is refused (403), never returning decrypted values', async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/tables/secrets/rows`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // No rows array, no leaked value column — just the refusal.
    expect(body.rows).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('value');
  });

  it('GET a single secrets row is refused (403)', async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/tables/secrets/rows/any-id`);
    expect(res.status).toBe(403);
  });

  it('POST to secrets via the generic route is refused (403) — no attacker-written credentials', async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/tables/secrets/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', value: 'sk-attacker' }),
    });
    expect(res.status).toBe(403);
  });

  it('a normal user table is unaffected (still served)', async () => {
    const h = await boot();
    const created = await fetch(`${h.url}/api/tables/items/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hello' }),
    });
    expect(created.status).toBeLessThan(300);
    const list = await fetch(`${h.url}/api/tables/items/rows`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { rows: { name: string }[] };
    expect(body.rows.some((r) => r.name === 'hello')).toBe(true);
  });
});
