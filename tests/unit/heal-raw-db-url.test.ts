/**
 * healRawDbUrl — a config that still stores a RAW `postgres://…` connection
 * string (password in cleartext on disk) is healed on open: the URL moves into
 * the encrypted credential store and the `db:` line becomes a
 * `${LATTICE_DB:label}` reference. Idempotent for already-referenced / SQLite
 * configs, and never clobbers an existing credential.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  healRawDbUrl,
  getDbCredential,
  saveDbCredential,
} from '../../src/framework/user-config.js';

let cfgDir: string;
let workDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.LATTICE_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), 'heal-cfg-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir; // credential store + master key live here
  workDir = mkdtempSync(join(tmpdir(), 'heal-work-'));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv;
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(db: string): string {
  const cfg = join(workDir, 'lattice.config.yml');
  writeFileSync(cfg, `name: Test\ndb: ${db}\nentities: {}\n`, 'utf8');
  return cfg;
}

describe('healRawDbUrl', () => {
  it('moves a raw postgres URL into the encrypted store and rewrites db: to a reference', () => {
    const url = 'postgres://u:sup3r-secret@host:5432/app_db';
    const cfg = writeConfig(url);

    const label = healRawDbUrl(cfg);
    expect(label).toBe('app_db'); // derived from the database name

    const yaml = readFileSync(cfg, 'utf8');
    expect(yaml).toContain('${LATTICE_DB:app_db}');
    expect(yaml).not.toContain('postgres://'); // no raw URL left on disk
    expect(yaml).not.toContain('sup3r-secret'); // no password left on disk
    // The URL is recoverable from the encrypted store under the label.
    expect(getDbCredential('app_db')).toBe(url);
  });

  it('is idempotent: a ${LATTICE_DB:…} reference is left untouched', () => {
    const cfg = writeConfig('${LATTICE_DB:app_db}');
    expect(healRawDbUrl(cfg)).toBeNull();
    expect(readFileSync(cfg, 'utf8')).toContain('${LATTICE_DB:app_db}');
  });

  it('leaves a SQLite path untouched', () => {
    const cfg = writeConfig('./data/lattice.db');
    expect(healRawDbUrl(cfg)).toBeNull();
    expect(readFileSync(cfg, 'utf8')).toContain('./data/lattice.db');
  });

  it('never clobbers an existing credential stored for a different URL', () => {
    // A credential already exists under the label the dbname would produce, but
    // for a DIFFERENT cloud — the heal must pick a fresh label, not overwrite it.
    saveDbCredential('app_db', 'postgres://other:pw@elsewhere:5432/app_db');
    const url = 'postgres://u:sup3r-secret@host:5432/app_db';
    const cfg = writeConfig(url);

    const label = healRawDbUrl(cfg);
    expect(label).not.toBe('app_db');
    expect(label!.startsWith('app_db-')).toBe(true);
    expect(getDbCredential('app_db')).toBe('postgres://other:pw@elsewhere:5432/app_db'); // intact
    expect(getDbCredential(label!)).toBe(url);
    expect(readFileSync(cfg, 'utf8')).toContain(`\${LATTICE_DB:${label!}}`);
  });
});
