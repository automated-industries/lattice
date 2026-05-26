import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import {
  getDbCredential,
  listDbCredentials,
  saveDbCredential,
} from '../../src/framework/user-config.js';
import { resolveDbPath } from '../../src/config/parser.js';

/**
 * Project Config "Database" panel endpoints.
 *
 *   - GET /api/dbconfig — shape of the current config
 *   - POST /api/dbconfig/save — Postgres saves to db-credentials.enc +
 *     rewrites the YAML to `${LATTICE_DB:<label>}`; SQLite rewrites the
 *     `db:` line in place
 *   - POST /api/dbconfig/test — probes a candidate connection without
 *     swapping
 *   - POST /api/dbconfig/connect — re-opens the active configPath
 *   - GET /api/dbconfig/labels — saved Postgres labels
 *
 * Plus a small unit check on `resolveDbPath`'s YAML-parser hook.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-dbcfg-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Isolate ~/.lattice/ writes per test.
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-cfg-'));
  dirs.push(cfgDir);
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'dbconfig-test-key';
});

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
});

function writeSqliteConfig(
  root: string,
  dbName: string,
): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: ./data/${dbName}.db`,
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
  return { configPath, outputDir };
}

async function startGui(): Promise<{ handle: GuiServerHandle; configPath: string }> {
  const root = tempDir();
  const { configPath, outputDir } = writeSqliteConfig(root, 'project');
  const handle = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    host: '127.0.0.1',
    teamCloud: false,
    openBrowser: false,
  });
  servers.push(handle);
  return { handle, configPath };
}

type ApiResult = { status: number; body: Record<string, unknown> };
async function api(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body };
}

describe('dbconfig endpoints', () => {
  it('GET /api/dbconfig describes a SQLite project', async () => {
    const { handle } = await startGui();
    const r = await api(handle.url, '/api/dbconfig');
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('sqlite');
    expect(r.body.dbFile).toBe('project.db');
    expect(r.body.teamEnabled).toBe(false);
  });

  it('POST /api/dbconfig/save persists a Postgres URL encrypted + rewrites the YAML', async () => {
    const { handle, configPath } = await startGui();
    const r = await api(handle.url, '/api/dbconfig/save', {
      method: 'POST',
      body: {
        type: 'postgres',
        label: 'atlas',
        host: 'pg.example.test',
        port: 5432,
        dbname: 'app',
        user: 'lattice_user',
        password: 'sup3r-secret!',
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.label).toBe('atlas');

    // YAML now references the label, not the raw URL.
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('${LATTICE_DB:atlas}');
    expect(yaml).not.toContain('sup3r-secret!');

    // db-credentials.enc holds the URL.
    expect(listDbCredentials()).toEqual(['atlas']);
    const stored = getDbCredential('atlas');
    expect(stored).toMatch(/^postgres:\/\//);
    expect(stored).toContain('pg.example.test');
    expect(stored).toContain('5432');
    expect(stored).toContain('/app');
  });

  it('POST /api/dbconfig/save with SQLite rewrites the db: line', async () => {
    const { handle, configPath } = await startGui();
    const r = await api(handle.url, '/api/dbconfig/save', {
      method: 'POST',
      body: { type: 'sqlite', path: './data/alt.db' },
    });
    expect(r.status).toBe(200);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toMatch(/db:\s+\.\/data\/alt\.db/);
  });

  it('rejects malformed bodies with 400', async () => {
    const { handle } = await startGui();
    const r = await api(handle.url, '/api/dbconfig/save', {
      method: 'POST',
      body: {
        type: 'postgres',
        label: 'has space!',
        host: 'h',
        dbname: 'd',
        user: 'u',
        password: 'p',
        port: 5432,
      },
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/dbconfig/test returns ok:false for an unreachable Postgres', async () => {
    const { handle } = await startGui();
    const r = await api(handle.url, '/api/dbconfig/test', {
      method: 'POST',
      body: {
        type: 'postgres',
        label: 'unreachable',
        host: '127.0.0.1',
        port: 1, // closed port
        dbname: 'x',
        user: 'u',
        password: 'p',
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
  });

  it('GET /api/dbconfig/labels returns saved Postgres labels', async () => {
    const { handle } = await startGui();
    await api(handle.url, '/api/dbconfig/save', {
      method: 'POST',
      body: {
        type: 'postgres',
        label: 'atlas',
        host: 'h',
        port: 5432,
        dbname: 'd',
        user: 'u',
        password: 'p',
      },
    });
    await api(handle.url, '/api/dbconfig/save', {
      method: 'POST',
      body: {
        type: 'postgres',
        label: 'beta',
        host: 'h',
        port: 5432,
        dbname: 'd',
        user: 'u',
        password: 'p',
      },
    });
    const r = await api(handle.url, '/api/dbconfig/labels');
    // Second save also rewrites YAML to ${LATTICE_DB:beta}. The labels
    // endpoint reports both.
    expect(r.body.labels.sort()).toEqual(['atlas', 'beta']);
  });
});

describe('config parser — ${LATTICE_DB:<label>} resolver', () => {
  it('resolves a saved label to its stored URL', () => {
    const dir = tempDir();
    saveDbCredential('atlas', 'postgres://u:p@h:5432/d');
    expect(resolveDbPath('${LATTICE_DB:atlas}', dir)).toBe('postgres://u:p@h:5432/d');
  });

  it('throws when the label is not saved', () => {
    const dir = tempDir();
    expect(() => resolveDbPath('${LATTICE_DB:missing}', dir)).toThrow(/no credential is saved/);
  });

  it('passes Postgres URLs through verbatim', () => {
    expect(resolveDbPath('postgres://x:y@h/d', '/tmp')).toBe('postgres://x:y@h/d');
  });

  it('resolves relative SQLite paths against the config directory', () => {
    const r = resolveDbPath('./data/foo.db', '/some/dir');
    expect(r).toBe('/some/dir/data/foo.db');
  });
});
