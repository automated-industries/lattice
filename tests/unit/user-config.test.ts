import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  deleteDbCredential,
  deleteToken,
  getDbCredential,
  getOrCreateMasterKey,
  listDbCredentials,
  listTokens,
  readIdentity,
  readToken,
  saveDbCredential,
  writeIdentity,
  writeToken,
} from '../../src/framework/user-config.js';

describe('framework user-config', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-uc-'));
    savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
    savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
    process.env.LATTICE_CONFIG_DIR = tmpDir;
    delete process.env.LATTICE_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
    if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
    else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('configDir() + master key', () => {
    it('honors LATTICE_CONFIG_DIR override', () => {
      expect(configDir()).toBe(tmpDir);
    });

    it('LATTICE_ENCRYPTION_KEY env wins over the file', () => {
      process.env.LATTICE_ENCRYPTION_KEY = 'env-override-key';
      expect(getOrCreateMasterKey()).toBe('env-override-key');
      // Even though we read the env, we shouldn't have created a file.
      expect(existsSync(join(tmpDir, 'master.key'))).toBe(false);
    });

    it('auto-generates master.key on first call and returns the same value on subsequent calls', () => {
      const first = getOrCreateMasterKey();
      const second = getOrCreateMasterKey();
      expect(first).toBe(second);
      expect(existsSync(join(tmpDir, 'master.key'))).toBe(true);
      // 32 random bytes encoded base64 is 44 chars (with padding).
      expect(first.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe('identity.json round-trip', () => {
    it('returns empty strings when the file is missing', () => {
      const id = readIdentity();
      expect(id).toEqual({ display_name: '', email: '' });
    });

    it('round-trips write → read', () => {
      writeIdentity({ display_name: 'Alex Operator', email: 'alex@example.com' });
      expect(readIdentity()).toEqual({
        display_name: 'Alex Operator',
        email: 'alex@example.com',
      });
    });

    it('ignores unknown extra fields on write', () => {
      // Cast through unknown to attach an unrecognised field; writeIdentity
      // is required to drop anything outside the typed shape.
      writeIdentity({
        display_name: 'A',
        email: 'a@b',
        timezone: 'America/New_York',
      } as unknown as Parameters<typeof writeIdentity>[0]);
      const back = readIdentity();
      expect(back).toEqual({ display_name: 'A', email: 'a@b' });
    });
  });

  describe('db-credentials.enc', () => {
    it('save → list → get round-trip', () => {
      saveDbCredential('atlas', 'postgres://u:p@h:5432/db');
      saveDbCredential('beta', 'postgres://x:y@h2:5432/db2');
      expect(listDbCredentials()).toEqual(['atlas', 'beta']);
      expect(getDbCredential('atlas')).toBe('postgres://u:p@h:5432/db');
      expect(getDbCredential('missing')).toBeNull();
    });

    it('encrypts the file on disk', () => {
      saveDbCredential('a', 'postgres://supersecret-password@h/d');
      const raw = readFileSync(join(tmpDir, 'db-credentials.enc'), 'utf8');
      expect(raw).toMatch(/^enc:/);
      expect(raw).not.toContain('supersecret-password');
    });

    it('delete is idempotent', () => {
      saveDbCredential('a', 'url');
      deleteDbCredential('a');
      deleteDbCredential('a');
      expect(listDbCredentials()).toEqual([]);
    });
  });

  describe('keys/<label>.token', () => {
    it('write → read → list → delete', () => {
      writeToken('atlas', 'bearer-token-value');
      expect(readToken('atlas')).toBe('bearer-token-value');
      expect(listTokens()).toEqual(['atlas']);
      deleteToken('atlas');
      expect(readToken('atlas')).toBeNull();
      expect(listTokens()).toEqual([]);
    });

    it('rejects path-traversal labels', () => {
      expect(() => writeToken('../escape', 'x')).toThrow(/Invalid label/);
      expect(() => writeToken('foo/bar', 'x')).toThrow(/Invalid label/);
      expect(() => writeToken('.hidden', 'x')).toThrow(/Invalid label/);
    });

    it('writes token files with restrictive permissions on POSIX', () => {
      if (process.platform === 'win32') return; // best-effort only on Windows
      writeToken('atlas', 'token');
      const mode = statSync(join(tmpDir, 'keys', 'atlas.token')).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
