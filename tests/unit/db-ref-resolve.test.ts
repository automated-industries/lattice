import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath, parseDbRef, isDbRefShaped } from '../../src/config/parser.js';

/**
 * #1.1/#1.2 — a `${LATTICE_DB:<label>}` reference whose label is malformed (e.g.
 * the default join label "Cloud workspace", which has a space) used to fall
 * THROUGH resolveDbPath to filesystem-path resolution → a literal
 * `${LATTICE_DB:…}` file (0-byte on Windows) → a silent empty local DB. Now it
 * throws. Sanitizing the label (slugify) makes it round-trip as a valid ref.
 */
let cfgDir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), 'lattice-ref-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir; // isolate the credential store
});
afterEach(() => {
  if (saved.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = saved.LATTICE_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('#1.1/#1.2 ${LATTICE_DB:…} reference resolution', () => {
  it('throws on a shaped-but-malformed reference (the exact "Cloud workspace" bug)', () => {
    expect(() => resolveDbPath('${LATTICE_DB:Cloud workspace}', '/tmp')).toThrow(
      /malformed|LATTICE_DB/i,
    );
    expect(() => resolveDbPath('${LATTICE_DB:a:b}', '/tmp')).toThrow();
  });

  it('throws clearly on a valid label with no saved credential (no path fallthrough)', () => {
    expect(() => resolveDbPath('${LATTICE_DB:validlabel}', '/tmp')).toThrow(/credential/i);
  });

  it('refuses to treat any unexpanded ${…} value as a filesystem path', () => {
    expect(() => resolveDbPath('${SOMETHING_ELSE}', '/tmp')).toThrow();
  });

  it('passes through postgres / file / memory connection strings', () => {
    expect(resolveDbPath('postgres://h/db', '/tmp')).toBe('postgres://h/db');
    expect(resolveDbPath('postgresql://h/db', '/tmp')).toBe('postgresql://h/db');
    expect(resolveDbPath(':memory:', '/tmp')).toBe(':memory:');
  });

  it('resolves a plain relative path against the config dir', () => {
    expect(resolveDbPath('./Data/x.db', '/tmp/cfg')).toBe('/tmp/cfg/Data/x.db');
  });

  it('parseDbRef/isDbRefShaped: a sanitized label is valid; a spaced one is shaped-but-invalid', () => {
    expect(parseDbRef('${LATTICE_DB:cloud-workspace}')).toEqual({ label: 'cloud-workspace' });
    expect(parseDbRef('${LATTICE_DB:Cloud workspace}')).toBeNull();
    expect(isDbRefShaped('${LATTICE_DB:Cloud workspace}')).toBe(true);
    expect(isDbRefShaped('./x.db')).toBe(false);
  });
});
