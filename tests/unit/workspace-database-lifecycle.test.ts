/**
 * Workspace and database lifecycle, without a server.
 *
 * Three questions, and the third is the one that used to have no good answer.
 *
 *   1. Can a script do it at all? Creating and removing a database, and removing
 *      a workspace, were request handlers — so the answer was "start a server and
 *      send yourself a request", which is not an answer.
 *
 *   2. Does deleting take what it should and nothing else? A delete that is too
 *      eager destroys files the user only ever pointed at; one that is too polite
 *      leaves a working credential for a database its operator was told this
 *      machine had been disconnected from. Both look identical from the outside —
 *      the call returns, the record is gone — so both are pinned here.
 *
 *   3. Do the two workspace-delete routes really share one implementation? A
 *      workspace can be removed while it is open and while nothing is open at
 *      all, so there are two doors to the same operation. They used to share a
 *      helper that lived in one of them, with a comment saying the two could
 *      never drift — which is a hope, not a mechanism. The check below is the
 *      mechanism: each route's own body may CALL the capability and may not
 *      perform the removal itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deleteWorkspace } from '../../src/ops/workspace-lifecycle.js';
import { createDatabase, deleteDatabase } from '../../src/ops/databases.js';
import { listConfigs } from '../../src/gui/config-paths.js';
import { workspaceErrorCode } from '../../src/ops/workspace-errors.js';
import {
  addAdoptedWorkspace,
  addWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
} from '../../src/framework/workspace.js';
import { CONFIG_SUBDIR, ROOT_DIRNAME, ensureRootAt } from '../../src/framework/lattice-root.js';
import { getDbCredential, saveDbCredential } from '../../src/framework/user-config.js';
import { stripCommentsForScan } from '../support/scan-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

let scratch: string;
const prev: Record<string, string | undefined> = {};
let seq = 0;

beforeEach(() => {
  // Everything — the registry, the key, the credential stores — stays inside a
  // scratch directory. Nothing in this file may touch the machine's own root.
  scratch = mkdtempSync(join(tmpdir(), 'lattice-ws-db-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
});

afterEach(() => {
  for (const [key, value] of Object.entries(prev)) {
    // A var that was absent goes back to absent, not to an empty string.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh, empty `.lattice` root — no shared registry state between tests. */
function newRoot(): string {
  seq++;
  return ensureRootAt(join(scratch, `root-${String(seq)}`));
}

/** A root whose OWN config dir holds the key and the encrypted credential store. */
function rootWithSecrets(): { root: string; store: string } {
  seq++;
  const root = join(scratch, `secret-root-${String(seq)}`, ROOT_DIRNAME);
  const store = join(root, CONFIG_SUBDIR);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'master.key'), randomBytes(32).toString('base64'), 'utf8');
  const prevCfg = process.env.LATTICE_CONFIG_DIR;
  const prevKey = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = store;
  // A machine-wide key would mask whether the purge reached the right store.
  delete process.env.LATTICE_ENCRYPTION_KEY;
  try {
    saveDbCredential('shared.config', 'postgres://acme:secret@db.example/acme');
  } finally {
    if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevCfg;
    if (prevKey !== undefined) process.env.LATTICE_ENCRYPTION_KEY = prevKey;
  }
  return { root, store };
}

/** Read the credential store belonging to `dir`, whatever the session is using. */
function inStore<T>(dir: string, fn: () => T): T {
  const prevCfg = process.env.LATTICE_CONFIG_DIR;
  const prevKey = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = dir;
  delete process.env.LATTICE_ENCRYPTION_KEY;
  try {
    return fn();
  } finally {
    if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevCfg;
    if (prevKey !== undefined) process.env.LATTICE_ENCRYPTION_KEY = prevKey;
  }
}

/** A workspace directory holding one starter database config. */
function workspaceWithOneDatabase(): string {
  seq++;
  const dir = join(scratch, `dbset-${String(seq)}`);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const configPath = join(dir, 'workspace.yml');
  writeFileSync(configPath, 'db: ./data/workspace.db\n\nentities: {}\n', 'utf8');
  return configPath;
}

// ── Databases: a script can add and remove them ────────────────────────────

describe('the databases inside a workspace, from a script', () => {
  it('creates one beside the others and lists it', async () => {
    const configPath = workspaceWithOneDatabase();

    const created = createDatabase({ configPath, name: 'Ledger 2026' });

    expect(existsSync(created.path)).toBe(true);
    // The name it reports is the one the SET lists it under, so a caller can pass
    // it straight back to a delete without re-deriving the convention. The
    // filename is a lossy slug of it and is deliberately NOT the answer here.
    expect(created.name).toBe('Ledger 2026');
    expect(created.path.endsWith('ledger-2026.config.yml')).toBe(true);
    expect(dirname(created.path)).toBe(dirname(configPath));
    // …and the set really does list it under that name, rather than under the
    // slug, which is what makes the round trip work.
    const labels = listConfigs(configPath).map((c) => c.label);
    expect(labels).toContain('Ledger 2026');
    // Scaffolded for real: the store's directory exists, so opening it works.
    expect(existsSync(join(dirname(configPath), 'data'))).toBe(true);
    expect(readFileSync(created.path, 'utf8')).toContain('entities: {}');
  });

  it('reports where the rows were, not merely whether a file went', async () => {
    // `deletedDbFile: null` is true of a shared database AND of a local one whose
    // store was never written. A caller that has to tell a person which of those
    // just happened cannot get it from that field, so the deletion carries the
    // store it classified before anything was unlinked.
    const configPath = workspaceWithOneDatabase();
    const local = createDatabase({ configPath, name: 'Never Opened' });

    const deleted = await deleteDatabase({ configPath, target: local.path });

    expect(deleted.deletedDbFile).toBeNull();
    expect(deleted.store).toEqual({
      kind: 'local',
      file: join(dirname(configPath), 'data', 'never-opened.db'),
    });

    const cloud = join(dirname(configPath), 'team.config.yml');
    writeFileSync(cloud, 'db: postgres://example/team\n\nentities: {}\n', 'utf8');
    const shared = await deleteDatabase({ configPath, target: cloud });
    expect(shared.deletedDbFile).toBeNull();
    expect(shared.store).toEqual({ kind: 'shared' });
  });

  it('refuses an empty name with a code a caller can branch on, not a status', () => {
    const configPath = workspaceWithOneDatabase();
    try {
      createDatabase({ configPath, name: '   ' });
      expect.unreachable('an empty name must be refused');
    } catch (e) {
      expect(workspaceErrorCode(e)).toBe('invalid_request');
    }
  });

  it('removes a database with its store and its write-ahead siblings', async () => {
    const configPath = workspaceWithOneDatabase();
    const created = createDatabase({ configPath, name: 'Scratch' });
    const store = join(dirname(configPath), 'data', 'scratch.db');
    writeFileSync(store, 'rows', 'utf8');
    writeFileSync(`${store}-wal`, 'wal', 'utf8');
    writeFileSync(`${store}-shm`, 'shm', 'utf8');

    const deleted = await deleteDatabase({ configPath, target: created.path });

    expect(deleted.deletedConfig).toBe('scratch.config.yml');
    expect(deleted.deletedDbFile).toBe(store);
    expect(existsSync(created.path)).toBe(false);
    expect(existsSync(store)).toBe(false);
    expect(existsSync(`${store}-wal`)).toBe(false);
    expect(existsSync(`${store}-shm`)).toBe(false);
    // The database that stayed is untouched, config and store alike.
    expect(deleted.remaining).toEqual([resolve(configPath)]);
    expect(existsSync(configPath)).toBe(true);
  });

  it('refuses a path outside the workspace rather than unlinking it', async () => {
    // Containment is the difference between "remove one of my databases" and
    // "unlink whatever path you are handed", and only one of those is the
    // operation this looks like.
    const configPath = workspaceWithOneDatabase();
    const outsider = join(scratch, 'not-mine.yml');
    writeFileSync(outsider, 'db: ./x.db\n\nentities: {}\n', 'utf8');

    await expect(deleteDatabase({ configPath, target: outsider })).rejects.toThrow(
      /Not a known database config/,
    );
    expect(existsSync(outsider)).toBe(true);
  });

  it('keeps the last database, so a workspace never opens into nothing', async () => {
    const configPath = workspaceWithOneDatabase();

    await expect(deleteDatabase({ configPath, target: configPath })).rejects.toThrow(
      /Cannot delete the only database/,
    );
    expect(existsSync(configPath)).toBe(true);

    // …and the rule is about the SET, not about which one happens to be open:
    // asking to remove the last one by any name is the same refusal.
    const second = createDatabase({ configPath, name: 'Second' });
    await deleteDatabase({ configPath, target: configPath });
    await expect(deleteDatabase({ configPath: second.path, target: second.path })).rejects.toThrow(
      /Cannot delete the only database/,
    );
  });

  it('aborts with nothing removed when the caller cannot release the target', async () => {
    // The hook exists for a caller that has the database OPEN. If it cannot let
    // go, deleting anyway leaves a process holding files that are gone — worse
    // than not deleting at all.
    const configPath = workspaceWithOneDatabase();
    const created = createDatabase({ configPath, name: 'Held' });

    await expect(
      deleteDatabase({
        configPath,
        target: created.path,
        releaseTarget: () => {
          throw new Error('still open');
        },
      }),
    ).rejects.toThrow(/still open/);
    expect(existsSync(created.path)).toBe(true);
  });

  it('hands the release hook the databases that will remain', async () => {
    const configPath = workspaceWithOneDatabase();
    const created = createDatabase({ configPath, name: 'Going' });
    let handed: string[] = [];

    await deleteDatabase({
      configPath,
      target: created.path,
      releaseTarget: (remaining) => {
        handed = remaining;
      },
    });

    // A caller switching away needs somewhere to switch TO, and it must not be
    // the one about to be unlinked.
    expect(handed).toEqual([resolve(configPath)]);
  });
});

// ── Workspaces: removing one takes what it should, and no more ─────────────

describe('removing a workspace, from a script', () => {
  it('drops the registry record and the folder it scaffolded', () => {
    const root = newRoot();
    const going = addWorkspace(root, { displayName: 'Going' });
    const staying = addWorkspace(root, { displayName: 'Staying' });
    const goingDir = resolveWorkspacePaths(root, going).dir;
    const stayingConfig = resolveWorkspacePaths(root, staying).configPath;

    const removal = deleteWorkspace({ root, id: going.id });

    expect(removal.workspace.id).toBe(going.id);
    expect(removal.removedDir).toBe(goingDir);
    expect(existsSync(goingDir)).toBe(false);
    expect(listWorkspaces(root).map((w) => w.id)).toEqual([staying.id]);
    // Nothing it should not: the neighbour keeps its files.
    expect(existsSync(stayingConfig)).toBe(true);
  });

  it('moves the active pointer off a workspace it just removed', () => {
    const root = newRoot();
    const first = addWorkspace(root, { displayName: 'First' });
    const second = addWorkspace(root, { displayName: 'Second' });
    expect(getActiveWorkspace(root)?.id).toBe(first.id);

    deleteWorkspace({ root, id: first.id });

    // A registry still pointing at a record that is gone resolves to nothing on
    // the next open, which reads as "no workspaces" rather than "one workspace".
    expect(getActiveWorkspace(root)?.id).toBe(second.id);
  });

  it('leaves the files of a workspace it only ever pointed at', () => {
    // Adopted in place: the user's own config, in the user's own directory. We
    // registered a pointer to it and a delete removes the pointer, not the work.
    const root = newRoot();
    const mine = join(scratch, 'my-project');
    mkdirSync(join(mine, 'context'), { recursive: true });
    const configPath = join(mine, 'lattice.config.yml');
    writeFileSync(configPath, 'db: ./data.db\n\nentities: {}\n', 'utf8');
    writeFileSync(join(mine, 'data.db'), 'rows', 'utf8');
    const ws = addAdoptedWorkspace(root, {
      displayName: 'Mine',
      db: './data.db',
      configPath,
      contextDir: join(mine, 'context'),
    });

    const removal = deleteWorkspace({ root, id: ws.id });

    expect(removal.removedDir).toBeNull();
    expect(removal.removedConfig).toBeNull();
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(mine, 'data.db'))).toBe(true);
    expect(listWorkspaces(root)).toEqual([]);
  });

  it('takes the local pointer and the credentials of a shared workspace with it', () => {
    // The dangerous case. Forgetting only the pointer leaves this machine able to
    // reconnect to a database its operator was told it had been disconnected from.
    const { root, store } = rootWithSecrets();
    const pointer = join(scratch, 'shared.config.yml');
    writeFileSync(pointer, 'db: ${LATTICE_DB:shared.config}\n\nentities: {}\n', 'utf8');
    const ws = addAdoptedWorkspace(root, {
      displayName: 'Shared',
      db: '${LATTICE_DB:shared.config}',
      configPath: pointer,
      contextDir: join(scratch, 'shared-context'),
    });

    const removal = deleteWorkspace({ root, id: ws.id });

    expect(removal.removedConfig).toBe(pointer);
    expect(removal.purgedLabel).toBe('shared.config');
    expect(existsSync(pointer)).toBe(false);
    inStore(store, () => {
      expect(getDbCredential('shared.config')).toBeNull();
    });
  });

  it('keeps a credential another registered workspace still points at', () => {
    const { root, store } = rootWithSecrets();
    const makePointer = (file: string): string => {
      const p = join(scratch, file);
      writeFileSync(p, 'db: ${LATTICE_DB:shared.config}\n\nentities: {}\n', 'utf8');
      return p;
    };
    const first = addAdoptedWorkspace(root, {
      displayName: 'One view',
      db: '${LATTICE_DB:shared.config}',
      configPath: makePointer('view-one.yml'),
      contextDir: join(scratch, 'ctx-one'),
    });
    addAdoptedWorkspace(root, {
      displayName: 'Another view',
      db: '${LATTICE_DB:shared.config}',
      configPath: makePointer('view-two.yml'),
      contextDir: join(scratch, 'ctx-two'),
    });

    const removal = deleteWorkspace({ root, id: first.id });

    expect(removal.purgedLabel).toBeNull();
    inStore(store, () => {
      expect(getDbCredential('shared.config')).toBe('postgres://acme:secret@db.example/acme');
    });
  });

  it('reports an unknown id with a code, and changes nothing', () => {
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'Only' });
    try {
      deleteWorkspace({ root, id: 'no-such-id' });
      expect.unreachable('an unknown id must be refused');
    } catch (e) {
      expect(workspaceErrorCode(e)).toBe('not_found');
    }
    expect(listWorkspaces(root).map((w) => w.id)).toEqual([ws.id]);
  });
});

// ── One capability, two doors ──────────────────────────────────────────────

describe('the two workspace-delete routes share one implementation', () => {
  /**
   * The CODE of the branch handling `pathname`, by brace matching from it.
   *
   * Comments are blanked first, for two reasons that both matter: prose about the
   * removal must not read as the removal (this whole check is about what a route
   * DOES, and the routes describe the rule at length), and a brace inside a
   * comment must not decide where the body ends.
   */
  function branchBody(text: string, pathname: string): string {
    const code = stripCommentsForScan(text);
    const marker = code.indexOf(`pathname === '${pathname}'`);
    expect(marker, `${pathname} is not handled in this file`).toBeGreaterThan(-1);
    const open = code.indexOf('{', marker);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${pathname}`);
  }

  const ROUTES = ['gui/server.ts', 'gui/workspaces-routes.ts'];

  it.each(ROUTES)('%s calls the capability rather than performing the removal', (file) => {
    const body = branchBody(readFileSync(join(SRC, file), 'utf8'), '/api/workspaces/delete');

    expect(body, 'the route must delegate the removal').toContain('deleteWorkspace(');
    // The three ways a route could quietly grow its own second copy of the
    // removal — which is precisely what "a shared helper and a comment saying it
    // must not drift" failed to prevent, because nothing checked.
    for (const inlined of [
      'removeWorkspace(',
      'cleanupWorkspaceFiles(',
      'rmSync(',
      'purgeWorkspaceSecrets(',
    ]) {
      expect(body, `${file} performs "${inlined}" itself instead of delegating`).not.toContain(
        inlined,
      );
    }
  });

  it('both routes name the same capability, and only that one', () => {
    // The census pins that every mutating route carries an annotation; this pins
    // that these two carry the SAME one, so a future split into two capabilities
    // has to be a deliberate edit here.
    const claimed = ROUTES.map((file) => {
      const body = readFileSync(join(SRC, file), 'utf8');
      const marker = body.indexOf(`pathname === '/api/workspaces/delete'`);
      const before = body.slice(0, marker);
      const tag = /@capability\s+(\S+)[\s\S]*$/.exec(before.slice(-600));
      return tag?.[1] ?? '(none)';
    });
    expect(claimed).toEqual(['workspace.delete', 'workspace.delete']);
  });
});
