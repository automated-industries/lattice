import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * POST /api/databases/delete — destructive removal of a saved database.
 *   - non-active database: YAML + local SQLite file deleted, active unchanged.
 *   - active database: server switches to a sibling first, then deletes.
 *   - refuses to delete the only database, and refuses unknown paths.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-del-cfg-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'delete-db-test-key';
});

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
});

function writeConfig(dir: string, name: string, dbName: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      `db: ./data/${dbName}.db`,
      'name: ' + dbName,
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: items.md',
      '',
    ].join('\n'),
  );
  return p;
}

type ApiResult = { status: number; body: Record<string, unknown> };
async function api(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function bootWithTwo(): Promise<{ handle: GuiServerHandle; dir: string; aPath: string; bPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-del-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'context'), { recursive: true });
  const aPath = writeConfig(dir, 'alpha.config.yml', 'alpha');
  const bPath = writeConfig(dir, 'beta.config.yml', 'beta');
  const handle = await startGuiServer({
    configPath: aPath,
    outputDir: join(dir, 'context'),
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(handle);
  return { handle, dir, aPath, bPath };
}

describe('POST /api/databases/delete', () => {
  it('deletes a non-active database (YAML + local db file) without switching', async () => {
    const { handle, dir, bPath } = await bootWithTwo();
    // beta is not active and was never opened, so create its db file so we can
    // assert the file gets removed too.
    const betaDb = join(dir, 'data', 'beta.db');
    writeFileSync(betaDb, '');

    const r = await api(handle.url, '/api/databases/delete', { method: 'POST', body: { path: bPath } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.switchedTo).toBeNull();
    expect(r.body.deletedConfig).toBe('beta.config.yml');
    expect(existsSync(bPath)).toBe(false);
    expect(existsSync(betaDb)).toBe(false);

    // Active is still alpha; the list no longer includes beta.
    const list = await api(handle.url, '/api/databases');
    const cur = list.body.current as { path: string };
    expect(resolve(cur.path)).toContain('alpha.config.yml');
    const configs = list.body.configs as { path: string }[];
    expect(configs.some((c) => resolve(c.path) === resolve(bPath))).toBe(false);
  });

  it('switches away before deleting the active database', async () => {
    const { handle, dir, aPath, bPath } = await bootWithTwo();
    const alphaDb = join(dir, 'data', 'alpha.db');
    // alpha was opened on boot, so its db file exists.
    expect(existsSync(alphaDb)).toBe(true);

    const r = await api(handle.url, '/api/databases/delete', { method: 'POST', body: { path: aPath } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(resolve(r.body.switchedTo as string)).toBe(resolve(bPath));
    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(alphaDb)).toBe(false);

    // Server now serves beta as the active DB.
    const list = await api(handle.url, '/api/databases');
    const cur = list.body.current as { path: string };
    expect(resolve(cur.path)).toBe(resolve(bPath));
  });

  it('refuses to delete the only database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-del-solo-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'context'), { recursive: true });
    const only = writeConfig(dir, 'only.config.yml', 'only');
    const handle = await startGuiServer({
      configPath: only,
      outputDir: join(dir, 'context'),
      port: 0,
      host: '127.0.0.1',
      teamCloud: false,
      openBrowser: false,
    });
    servers.push(handle);

    const r = await api(handle.url, '/api/databases/delete', { method: 'POST', body: { path: only } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('only database');
    expect(existsSync(only)).toBe(true);
  });

  it('rejects an unknown config path', async () => {
    const { handle, dir } = await bootWithTwo();
    const bogus = join(dir, 'data', 'not-a-config.yml');
    const r = await api(handle.url, '/api/databases/delete', { method: 'POST', body: { path: bogus } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('known database config');
  });

  it('rejects a missing path', async () => {
    const { handle } = await bootWithTwo();
    const r = await api(handle.url, '/api/databases/delete', { method: 'POST', body: {} });
    expect(r.status).toBe(400);
  });
});
