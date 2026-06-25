import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyticsEnabled,
  configDir,
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
  deleteDbCredential,
  deleteToken,
  getDbCredential,
  getOrCreateAnalyticsId,
  getOrCreateMasterKey,
  listDbCredentials,
  listTokens,
  readIdentity,
  readPreferences,
  readToken,
  saveDbCredential,
  writeIdentity,
  writePreferences,
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

  describe('analytics client id', () => {
    it('generates a stable anonymized id, persists it, and reuses it across calls', () => {
      const first = getOrCreateAnalyticsId();
      // Looks like a UUID, contains no PII.
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      // Persisted to disk + reused (one machine = one id forever).
      expect(existsSync(join(tmpDir, 'analytics-id'))).toBe(true);
      expect(getOrCreateAnalyticsId()).toBe(first);
      // The on-disk value IS the returned id.
      expect(readFileSync(join(tmpDir, 'analytics-id'), 'utf8').trim()).toBe(first);
    });
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

  describe('preferences.json round-trip', () => {
    const DEFAULTS = {
      show_system_tables: false,
      analytics: true,
      // On-device dictation is the keyless default (no API key, audio stays local).
      voice_provider: 'local',
      aggressiveness: 0.85,
    };

    it('returns defaults when the file is missing (analytics on by default)', () => {
      const prefs = readPreferences();
      expect(prefs).toEqual(DEFAULTS);
    });

    it("round-trips the on-device 'local' voice provider (the keyless default)", () => {
      writePreferences({
        show_system_tables: false,
        analytics: true,
        voice_provider: 'local',
        aggressiveness: 0.85,
      });
      expect(readPreferences().voice_provider).toBe('local');
    });

    it('round-trips write → read (incl. analytics consent + voice/aggressiveness prefs)', () => {
      writePreferences({
        show_system_tables: true,
        analytics: true,
        voice_provider: 'elevenlabs',
        aggressiveness: 0.8,
      });
      expect(readPreferences()).toEqual({
        show_system_tables: true,
        analytics: true,
        voice_provider: 'elevenlabs',
        aggressiveness: 0.8,
      });
      writePreferences({
        show_system_tables: false,
        analytics: false,
        voice_provider: 'openai',
        aggressiveness: 0,
      });
      expect(readPreferences()).toEqual({
        show_system_tables: false,
        analytics: false,
        voice_provider: 'openai',
        aggressiveness: 0,
      });
    });

    it('per-key falls back to defaults for invalid voice_provider / out-of-range aggressiveness', () => {
      const path = join(tmpDir, 'preferences.json');
      writeFileSync(
        path,
        JSON.stringify({ show_system_tables: true, voice_provider: 'whisper', aggressiveness: 9 }),
        'utf8',
      );
      const prefs = readPreferences();
      expect(prefs.show_system_tables).toBe(true);
      expect(prefs.voice_provider).toBe('local'); // unknown value → default
      expect(prefs.aggressiveness).toBe(1); // clamped into [0, 1]
    });

    it('drops unknown extra fields on write (forward-compat)', () => {
      writePreferences({
        show_system_tables: true,
        analytics: true,
        voice_provider: 'auto',
        aggressiveness: 0.5,
        sidebar_dense: false,
      } as unknown as Parameters<typeof writePreferences>[0]);
      const raw = readFileSync(join(tmpDir, 'preferences.json'), 'utf8');
      expect(raw).toContain('show_system_tables');
      expect(raw).toContain('analytics');
      expect(raw).toContain('voice_provider');
      expect(raw).toContain('aggressiveness');
      expect(raw).not.toContain('sidebar_dense');
    });

    it('falls back to defaults when the file is malformed', () => {
      const path = join(tmpDir, 'preferences.json');
      writePreferences({
        show_system_tables: true,
        analytics: false,
        voice_provider: 'openai',
        aggressiveness: 0.2,
      });
      // Corrupt the file in place.
      writeFileSync(path, '{not json', 'utf8');
      expect(readPreferences()).toEqual(DEFAULTS);
    });
  });

  describe('analyticsEnabled() consent gate', () => {
    const savedDnt = process.env.DO_NOT_TRACK;
    const savedScarf = process.env.SCARF_ANALYTICS;
    afterEach(() => {
      if (savedDnt === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = savedDnt;
      if (savedScarf === undefined) delete process.env.SCARF_ANALYTICS;
      else process.env.SCARF_ANALYTICS = savedScarf;
    });

    it('defaults to enabled (opt-out model)', () => {
      delete process.env.DO_NOT_TRACK;
      delete process.env.SCARF_ANALYTICS;
      expect(analyticsEnabled()).toBe(true);
    });

    it('honors the analytics preference', () => {
      delete process.env.DO_NOT_TRACK;
      delete process.env.SCARF_ANALYTICS;
      writePreferences({ show_system_tables: false, analytics: false });
      expect(analyticsEnabled()).toBe(false);
    });

    it('env DO_NOT_TRACK / SCARF_ANALYTICS always win over the preference', () => {
      writePreferences({ show_system_tables: false, analytics: true });
      process.env.DO_NOT_TRACK = '1';
      expect(analyticsEnabled()).toBe(false);
      delete process.env.DO_NOT_TRACK;
      process.env.SCARF_ANALYTICS = 'false';
      expect(analyticsEnabled()).toBe(false);
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

  describe('assistant-credentials.enc', () => {
    it('set → get → delete round-trip by kind', () => {
      expect(getAssistantCredential('anthropic_api_key')).toBeNull();
      setAssistantCredential('anthropic_api_key', 'sk-ant-123');
      setAssistantCredential('openai_api_key', 'sk-oai-456');
      expect(getAssistantCredential('anthropic_api_key')).toBe('sk-ant-123');
      expect(getAssistantCredential('openai_api_key')).toBe('sk-oai-456');
      deleteAssistantCredential('anthropic_api_key');
      expect(getAssistantCredential('anthropic_api_key')).toBeNull();
      // Deleting one kind leaves the others intact.
      expect(getAssistantCredential('openai_api_key')).toBe('sk-oai-456');
    });

    it('encrypts the file on disk (key never stored in plaintext)', () => {
      setAssistantCredential('anthropic_api_key', 'sk-ant-supersecret-token');
      const raw = readFileSync(join(tmpDir, 'assistant-credentials.enc'), 'utf8');
      expect(raw).toMatch(/^enc:/);
      expect(raw).not.toContain('sk-ant-supersecret-token');
    });

    it('delete is idempotent', () => {
      setAssistantCredential('anthropic_api_key', 'x');
      deleteAssistantCredential('anthropic_api_key');
      deleteAssistantCredential('anthropic_api_key');
      expect(getAssistantCredential('anthropic_api_key')).toBeNull();
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
      expect(() => {
        writeToken('../escape', 'x');
      }).toThrow(/Invalid label/);
      expect(() => {
        writeToken('foo/bar', 'x');
      }).toThrow(/Invalid label/);
      expect(() => {
        writeToken('.hidden', 'x');
      }).toThrow(/Invalid label/);
    });

    it('writes token files with restrictive permissions on POSIX', () => {
      if (process.platform === 'win32') return; // best-effort only on Windows
      writeToken('atlas', 'token');
      const mode = statSync(join(tmpDir, 'keys', 'atlas.token')).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
