import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteFileForConfig, deleteDatabaseFiles } from '../../src/gui/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-del-'));
  dirs.push(d);
  return d;
}

function writeConfig(dir: string, name: string, dbLine: string): string {
  const p = join(dir, name);
  // Quote the db value — bare `:memory:` would be parsed by YAML as a mapping.
  writeFileSync(p, `db: ${JSON.stringify(dbLine)}\n\nentities:\n  items:\n    fields:\n      id: { type: uuid, primaryKey: true }\n    outputFile: items.md\n`);
  return p;
}

describe('sqliteFileForConfig', () => {
  it('resolves a local SQLite path relative to the config dir', () => {
    const dir = tmp();
    const cfg = writeConfig(dir, 'a.config.yml', './data/a.db');
    expect(sqliteFileForConfig(cfg)).toBe(join(dir, 'data', 'a.db'));
  });

  it('returns null for a Postgres URL', () => {
    const dir = tmp();
    const cfg = writeConfig(dir, 'pg.config.yml', 'postgres://u:p@host:5432/db');
    expect(sqliteFileForConfig(cfg)).toBeNull();
  });

  it('returns null for a ${LATTICE_DB:label} reference', () => {
    const dir = tmp();
    const cfg = writeConfig(dir, 'lbl.config.yml', '${LATTICE_DB:atlas}');
    expect(sqliteFileForConfig(cfg)).toBeNull();
  });

  it('returns null for :memory: and file: URLs', () => {
    const dir = tmp();
    expect(sqliteFileForConfig(writeConfig(dir, 'mem.config.yml', ':memory:'))).toBeNull();
    expect(sqliteFileForConfig(writeConfig(dir, 'file.config.yml', 'file:./x.db'))).toBeNull();
  });
});

describe('deleteDatabaseFiles', () => {
  it('removes the YAML + the SQLite file and its WAL/SHM/journal sidecars', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'data'), { recursive: true });
    const cfg = writeConfig(dir, 'a.config.yml', './data/a.db');
    const dbFile = join(dir, 'data', 'a.db');
    writeFileSync(dbFile, '');
    writeFileSync(dbFile + '-wal', '');
    writeFileSync(dbFile + '-shm', '');

    const result = deleteDatabaseFiles(cfg);
    expect(result.deletedConfig).toBe('a.config.yml');
    expect(result.deletedDbFile).toBe(dbFile);
    expect(existsSync(cfg)).toBe(false);
    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(dbFile + '-wal')).toBe(false);
    expect(existsSync(dbFile + '-shm')).toBe(false);
  });

  it('removes only the YAML for a cloud config (leaves no db file claim)', () => {
    const dir = tmp();
    const cfg = writeConfig(dir, 'pg.config.yml', 'postgres://u:p@host:5432/db');
    const result = deleteDatabaseFiles(cfg);
    expect(result.deletedConfig).toBe('pg.config.yml');
    expect(result.deletedDbFile).toBeNull();
    expect(existsSync(cfg)).toBe(false);
  });

  it('tolerates a local config whose db file does not exist', () => {
    const dir = tmp();
    const cfg = writeConfig(dir, 'a.config.yml', './data/missing.db');
    const result = deleteDatabaseFiles(cfg);
    expect(result.deletedDbFile).toBeNull();
    expect(existsSync(cfg)).toBe(false);
  });
});
