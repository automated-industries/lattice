/**
 * Renaming a workspace, and asking whether a database is reachable, without a
 * server.
 *
 * Both lived inside request handlers, and each had a way of being wrong that a
 * "did it throw?" test would not catch:
 *
 *   A rename writes TWO places — the workspace's own configuration and the
 *   registry record that lists it. Writing one is the failure that looks like
 *   success: the file says the new name, the switcher still says the old one, and
 *   nothing reports a problem. So the pair is asserted together, and the outcome
 *   has to SAY when there was no registry record, rather than letting the caller
 *   assume both happened.
 *
 *   A connection test that cannot connect has not failed — it has answered. If it
 *   threw, every caller would have to catch a fault to read a result, and the
 *   reason the database gave would be the first thing lost.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  renameWorkspace,
  testDatabaseConnection,
  MAX_WORKSPACE_NAME_CHARS,
} from '../../src/ops/workspace-config.js';
import { workspaceErrorCode } from '../../src/ops/workspace-errors.js';
import {
  addWorkspace,
  effectiveConfigPath,
  listWorkspaces,
} from '../../src/framework/workspace.js';
import { ensureRootAt } from '../../src/framework/lattice-root.js';

const dirs: string[] = [];
const prev: Record<string, string | undefined> = {};
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-ws-config-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  // Credentials and registries resolve inside the scratch dir, never the
  // machine's own config dir or home root.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
});

afterAll(() => {
  for (const [key, value] of Object.entries(prev)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bare workspace configuration on disk, outside any registry. */
function loneConfig(name = 'Before'): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-ws-cfg-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, [`name: ${name}`, 'db: ./data/test.db', ''].join('\n'), 'utf8');
  return configPath;
}

describe('renameWorkspace', () => {
  it('writes the configuration AND the registry record that lists it', () => {
    const root = ensureRootAt(join(scratch, `root-${String(dirs.length)}-${String(Date.now())}`));
    const ws = addWorkspace(root, { displayName: 'Before' });
    const configPath = effectiveConfigPath(root, ws);
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, ['name: Before', 'db: ./Data/database.db', ''].join('\n'), 'utf8');

    const result = renameWorkspace({ configPath, name: 'After', root });

    expect(result.name).toBe('After');
    // The half that is easy to skip: without it the switcher keeps the old label
    // and nothing anywhere says the rename only half happened.
    expect(result.workspaceId).toBe(ws.id);
    expect(listWorkspaces(root).map((w) => w.displayName)).toEqual(['After']);
    expect((parse(readFileSync(configPath, 'utf8')) as { name: string }).name).toBe('After');
  });

  it('reports that no registry record was updated instead of implying one was', () => {
    // A workspace opened on a plain configuration outside any root is a real,
    // supported case — so this is an outcome, not an error. It still has to be
    // distinguishable from the case above, or a caller cannot tell a full rename
    // from a rename the switcher will never show.
    const configPath = loneConfig();
    const result = renameWorkspace({ configPath, name: 'Renamed' });

    expect(result.workspaceId).toBeNull();
    expect((parse(readFileSync(configPath, 'utf8')) as { name: string }).name).toBe('Renamed');
  });

  it('keeps the rest of the configuration exactly as it was', () => {
    const configPath = loneConfig();
    renameWorkspace({ configPath, name: 'Renamed' });
    // Rewriting the file must not lose the line that says where the data is.
    expect((parse(readFileSync(configPath, 'utf8')) as { db: string }).db).toBe('./data/test.db');
  });

  it('refuses an empty name with a tagged reason, and writes nothing', () => {
    const configPath = loneConfig();
    const before = readFileSync(configPath, 'utf8');

    let caught: unknown;
    try {
      renameWorkspace({ configPath, name: '   ' });
    } catch (e) {
      caught = e;
    }
    // Tagged, so an adapter answers 400 rather than 500 — and so a command-line
    // caller can tell a refusal from a filesystem fault.
    expect(workspaceErrorCode(caught)).toBe('invalid_request');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses a name past the length bound the interface also enforces', () => {
    const configPath = loneConfig();
    let caught: unknown;
    try {
      renameWorkspace({ configPath, name: 'x'.repeat(MAX_WORKSPACE_NAME_CHARS + 1) });
    } catch (e) {
      caught = e;
    }
    expect(workspaceErrorCode(caught)).toBe('invalid_request');
  });
});

describe('testDatabaseConnection', () => {
  it('reaches a local database named relative to the configuration', async () => {
    const configPath = loneConfig();
    const result = await testDatabaseConnection({
      configPath,
      target: { type: 'sqlite', path: './data/probe.db' },
    });

    expect(result).toEqual({ ok: true });
    // Resolved against the configuration, not the process working directory —
    // otherwise the same relative path answers differently per caller.
    expect(existsSync(join(configPath, '..', 'data', 'probe.db'))).toBe(true);
  });

  it('ANSWERS with the reason a database could not be reached, rather than throwing', async () => {
    const configPath = loneConfig();
    const result = await testDatabaseConnection({
      configPath,
      target: {
        type: 'postgres',
        // Port 1 refuses immediately: no network wait, no external dependency.
        host: '127.0.0.1',
        port: 1,
        dbname: 'nothing',
        user: 'nobody',
        password: '',
      },
    });

    expect(result.ok).toBe(false);
    // The driver's own words. Without them the answer is "it did not work",
    // which tells the person nothing about which field to fix.
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});
