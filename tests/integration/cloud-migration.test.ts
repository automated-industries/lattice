import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../../src/framework/cloud-migration.js';

/**
 * Public API tests for the cloud-migration module. The HTTP wrapper
 * lives in tests/integration/dbconfig-v13.test.ts; this file tests
 * the npm-package surface directly so library consumers can rely on
 * the function signatures without going through the GUI.
 */

const dirs: string[] = [];
const opened: Lattice[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-migrate-'));
  dirs.push(d);
  return d;
}

function writeConfig(root: string, dbName: string): { configPath: string; dbPath: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  const dbPath = join(root, 'data', `${dbName}.db`);
  writeFileSync(
    configPath,
    [
      `db: ./data/${dbName}.db`,
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text, required: true }',
      '      notes: { type: text }',
      '    outputFile: items.md',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text, required: true }',
      '      status: { type: text }',
      '    outputFile: tasks.md',
    ].join('\n'),
  );
  return { configPath, dbPath };
}

async function openSource(
  root: string,
): Promise<{ db: Lattice; configPath: string; dbPath: string }> {
  const { configPath, dbPath } = writeConfig(root, 'source');
  const db = new Lattice({ config: configPath }, { encryptionKey: 'migration-test-key' });
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  return { db, configPath, dbPath };
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.LATTICE_ENCRYPTION_KEY = 'migration-test-key';
});

describe('migrateLatticeData()', () => {
  it('copies user-defined entities + native secrets + files into an empty target', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);

    // Seed source
    await source.insert('items', { name: 'Alpha', notes: 'first' });
    await source.insert('items', { name: 'Beta' });
    await source.insert('tasks', { title: 'Ship it', status: 'open' });
    await source.insert('secrets', {
      name: 'OPENAI_API_KEY',
      kind: 'api-key',
      value: 'sk-supersecret-12345',
    });

    // Target: a second SQLite file via file: URL
    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    const result = await migrateLatticeData(source, target);
    expect(result.tablesCopied.sort()).toEqual(['files', 'items', 'notes', 'secrets', 'tasks']);
    expect(result.rowsCopied).toBe(4); // 2 items + 1 task + 1 secret

    // Target has the rows
    const targetItems = (await target.query('items', {})) as Record<string, unknown>[];
    expect(targetItems).toHaveLength(2);
    expect(targetItems.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta']);
    const targetTasks = (await target.query('tasks', {})) as Record<string, unknown>[];
    expect(targetTasks).toHaveLength(1);
    expect(targetTasks[0]?.title).toBe('Ship it');

    // secrets.value round-trips (decrypted on target read)
    const targetSecrets = (await target.query('secrets', {})) as Record<string, unknown>[];
    expect(targetSecrets).toHaveLength(1);
    expect(targetSecrets[0]?.value).toBe('sk-supersecret-12345');

    // Raw read: target's secrets.value is encrypted on disk
    const targetDbPath = targetUrl.replace(/^file:/, '');
    const raw = new Database(targetDbPath);
    const rawRow = raw.prepare('SELECT value FROM secrets LIMIT 1').get() as { value: string };
    raw.close();
    expect(rawRow.value).toMatch(/^enc:/);
  });

  it('refuses migration when the target is non-empty', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);
    await source.insert('items', { name: 'A' });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);
    // Pre-populate the target so it's no longer empty
    await target.insert('items', { name: 'pre-existing' });

    await expect(migrateLatticeData(source, target)).rejects.toThrow(/not empty/);
  });

  it('skips _lattice_gui_* and __lattice_* tables', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);

    // Source has _lattice_gui_meta registered via openConfig in the real
    // GUI path; this test uses a bare Lattice without the GUI server,
    // so we just confirm the migration won't try to copy `__lattice_*`
    // by inspecting the result.
    await source.insert('items', { name: 'only-user-table-rows' });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    const result = await migrateLatticeData(source, target);
    expect(result.tablesCopied.some((t) => t.startsWith('__lattice_'))).toBe(false);
    expect(result.tablesCopied.some((t) => t.startsWith('_lattice_gui_'))).toBe(false);
  });

  it('reports per-table progress via onProgress', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);
    for (let i = 0; i < 5; i++) await source.insert('items', { name: `row-${i}` });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    const progress: { table: string; rowsCopied: number; rowsTotal: number }[] = [];
    await migrateLatticeData(source, target, {
      batchSize: 2,
      onProgress: (p) => progress.push({ ...p }),
    });

    const itemsProgress = progress.filter((p) => p.table === 'items');
    expect(itemsProgress.length).toBeGreaterThan(0);
    expect(itemsProgress[itemsProgress.length - 1]?.rowsTotal).toBe(5);
    expect(itemsProgress[itemsProgress.length - 1]?.rowsCopied).toBe(5);
  });
});

describe('archiveLocalSqlite()', () => {
  it('renames the SQLite file (and -shm/-wal siblings) to .local-bak', () => {
    const root = tempDir();
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'p.db');
    writeFileSync(dbPath, '');
    writeFileSync(`${dbPath}-shm`, '');
    writeFileSync(`${dbPath}-wal`, '');

    const backupPath = archiveLocalSqlite(dbPath);
    expect(backupPath).toBe(`${dbPath}.local-bak`);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.local-bak`)).toBe(true);
    expect(existsSync(`${dbPath}.local-bak-shm`)).toBe(true);
    expect(existsSync(`${dbPath}.local-bak-wal`)).toBe(true);
  });

  it('clears a stale .local-bak before renaming so retries leave no orphans', () => {
    const root = tempDir();
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'p.db');
    writeFileSync(dbPath, 'fresh');
    writeFileSync(`${dbPath}.local-bak`, 'stale');

    archiveLocalSqlite(dbPath);
    // The stale file is gone, replaced by the fresh one
    const backupContent = readFileSync(`${dbPath}.local-bak`, 'utf8');
    expect(backupContent).toBe('fresh');
  });

  it('throws when the source file does not exist', () => {
    const root = tempDir();
    expect(() => archiveLocalSqlite(join(root, 'missing.db'))).toThrow(/does not exist/);
  });
});
