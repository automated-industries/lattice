import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_SUBDIR, ROOT_DIRNAME } from '../../src/framework/lattice-root.js';
import {
  getDbCredential,
  getS3ConfigRaw,
  listDbCredentials,
  purgeWorkspaceSecrets,
  readIdentity,
  readToken,
  saveDbCredential,
  saveS3ConfigRaw,
  writeIdentity,
  writeToken,
} from '../../src/framework/user-config.js';
import { cleanupWorkspaceFiles } from '../../src/gui/workspaces-routes.js';
import {
  addWorkspace,
  removeWorkspace,
  type WorkspaceRecord,
} from '../../src/framework/workspace.js';

/**
 * Removing a cloud workspace has to remove what this machine kept in order to
 * reconnect to it. Dropping the registry pointer while leaving a decryptable
 * connection string and the S3 keys behind means the machine is still, quietly,
 * able to reach a database its operator believes it has been disconnected from.
 *
 * The remote database itself is not touched — this is only about local material.
 */

const dirs: string[] = [];
let ambientCfg: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  prevEnv = {
    LATTICE_CONFIG_DIR: process.env.LATTICE_CONFIG_DIR,
    LATTICE_ENCRYPTION_KEY: process.env.LATTICE_ENCRYPTION_KEY,
  };
  // A machine-wide key would mask whether the purge reads the right store.
  delete process.env.LATTICE_ENCRYPTION_KEY;
  ambientCfg = tmp('lattice-ambient-cfg-');
  process.env.LATTICE_CONFIG_DIR = ambientCfg;
});

afterEach(() => {
  restoreEnv('LATTICE_CONFIG_DIR');
  restoreEnv('LATTICE_ENCRYPTION_KEY');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function restoreEnv(name: 'LATTICE_CONFIG_DIR' | 'LATTICE_ENCRYPTION_KEY'): void {
  const v = prevEnv[name];
  if (v === undefined) {
    if (name === 'LATTICE_CONFIG_DIR') delete process.env.LATTICE_CONFIG_DIR;
    else delete process.env.LATTICE_ENCRYPTION_KEY;
    return;
  }
  process.env[name] = v;
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Run `fn` with the machine-local store pointed at `dir`. */
function inStore<T>(dir: string, fn: () => T): T {
  const prev = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prev;
  }
}

/**
 * A root whose OWN `.config` holds the key material and the encrypted stores —
 * the shape of a root that a session did not create and is not currently using.
 */
function makeRootWithSecrets(): { root: string; store: string } {
  const base = tmp('lattice-root-');
  const root = join(base, ROOT_DIRNAME);
  const store = join(root, CONFIG_SUBDIR);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'master.key'), randomBytes(32).toString('base64'), 'utf8');
  inStore(store, () => {
    saveDbCredential('acme.config', 'postgres://acme:secret@db.example/acme');
    saveDbCredential('other.config', 'postgres://other:secret@db.example/other');
    saveS3ConfigRaw('acme.config', { bucket: 'acme', accessKeyId: 'AK', secretAccessKey: 'SK' });
    saveS3ConfigRaw('other.config', {
      bucket: 'other',
      accessKeyId: 'AK2',
      secretAccessKey: 'SK2',
    });
    writeToken('acme.config', 'bearer-acme');
    writeToken('other.config', 'bearer-other');
    writeIdentity({ display_name: 'Owner', email: 'owner@example.test' });
  });
  return { root, store };
}

describe('purgeWorkspaceSecrets', () => {
  it('removes the named workspace’s credential, S3 keys and token from the root’s own store', () => {
    const { root, store } = makeRootWithSecrets();

    const result = purgeWorkspaceSecrets(root, 'acme.config');

    expect(result.dirs).toContain(store);
    inStore(store, () => {
      expect(getDbCredential('acme.config')).toBeNull();
      expect(getS3ConfigRaw('acme.config')).toBeNull();
      expect(readToken('acme.config')).toBeNull();
    });
  });

  it('leaves every other workspace’s credentials intact', () => {
    const { root, store } = makeRootWithSecrets();

    purgeWorkspaceSecrets(root, 'acme.config');

    inStore(store, () => {
      expect(getDbCredential('other.config')).toBe('postgres://other:secret@db.example/other');
      expect(getS3ConfigRaw('other.config')).toMatchObject({ bucket: 'other' });
      expect(readToken('other.config')).toBe('bearer-other');
      expect(listDbCredentials()).toEqual(['other.config']);
    });
  });

  it('leaves the root’s shared material alone', () => {
    const { root, store } = makeRootWithSecrets();
    const keyBefore = readFileSync(join(store, 'master.key'), 'utf8');

    purgeWorkspaceSecrets(root, 'acme.config');

    // The master key is shared by every workspace under this root; deleting it
    // would strand the ones that remain.
    expect(readFileSync(join(store, 'master.key'), 'utf8')).toBe(keyBefore);
    inStore(store, () => {
      expect(readIdentity().email).toBe('owner@example.test');
    });
  });

  it('reaches the deleted root’s store even when the session’s store is elsewhere', () => {
    const { root, store } = makeRootWithSecrets();
    // The session is using a completely different config dir — the situation in
    // which "forgetting the pointer" used to leave working credentials behind.
    expect(process.env.LATTICE_CONFIG_DIR).toBe(ambientCfg);
    expect(store).not.toBe(ambientCfg);

    purgeWorkspaceSecrets(root, 'acme.config');

    inStore(store, () => {
      expect(getDbCredential('acme.config')).toBeNull();
    });
  });

  it('is a no-op for a label that was never stored', () => {
    const { root, store } = makeRootWithSecrets();
    expect(() => purgeWorkspaceSecrets(root, 'never-used')).not.toThrow();
    inStore(store, () => {
      expect(listDbCredentials()).toEqual(['acme.config', 'other.config']);
    });
  });

  it('fails loudly when the store cannot be read, rather than reporting success', () => {
    const { root, store } = makeRootWithSecrets();
    // An unreadable store is exactly when a quiet "removed" is most dangerous:
    // the credential is still on disk and still works for whoever holds the key.
    writeFileSync(join(store, 'db-credentials.enc'), 'enc:not-actually-decryptable\n', 'utf8');

    expect(() => purgeWorkspaceSecrets(root, 'acme.config')).toThrow(/db-credentials\.enc/);
  });
});

describe('deleting a cloud workspace', () => {
  function registerCloud(root: string, name: string, label: string): WorkspaceRecord {
    return addWorkspace(root, { displayName: name, db: '${LATTICE_DB:' + label + '}' });
  }

  it('purges that workspace’s stored credentials', () => {
    const { root, store } = makeRootWithSecrets();
    const ws = registerCloud(root, 'Acme', 'acme.config');
    registerCloud(root, 'Other', 'other.config');
    removeWorkspace(root, ws.id);

    cleanupWorkspaceFiles(root, ws);

    inStore(store, () => {
      expect(getDbCredential('acme.config')).toBeNull();
      expect(readToken('acme.config')).toBeNull();
      // The workspace that is still registered keeps everything.
      expect(getDbCredential('other.config')).toBe('postgres://other:secret@db.example/other');
      expect(readToken('other.config')).toBe('bearer-other');
    });
  });

  it('keeps a credential another registered workspace still points at', () => {
    const { root, store } = makeRootWithSecrets();
    const ws = registerCloud(root, 'Acme', 'acme.config');
    registerCloud(root, 'Acme (second view)', 'acme.config');
    removeWorkspace(root, ws.id);

    cleanupWorkspaceFiles(root, ws);

    inStore(store, () => {
      expect(getDbCredential('acme.config')).toBe('postgres://acme:secret@db.example/acme');
    });
  });

  it('propagates a purge failure instead of reporting a clean delete', () => {
    const { root, store } = makeRootWithSecrets();
    const ws = registerCloud(root, 'Acme', 'acme.config');
    removeWorkspace(root, ws.id);
    writeFileSync(join(store, 'db-credentials.enc'), 'enc:not-actually-decryptable\n', 'utf8');

    expect(() => {
      cleanupWorkspaceFiles(root, ws);
    }).toThrow(/db-credentials\.enc/);
  });

  it('does not touch stored credentials when a LOCAL workspace is deleted', () => {
    const { root, store } = makeRootWithSecrets();
    const ws = addWorkspace(root, { displayName: 'Just Local' });
    removeWorkspace(root, ws.id);

    cleanupWorkspaceFiles(root, ws);

    expect(existsSync(join(root, 'Workspaces', ws.dir))).toBe(false);
    inStore(store, () => {
      expect(listDbCredentials()).toEqual(['acme.config', 'other.config']);
    });
  });
});
