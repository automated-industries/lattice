import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import {
  isOwnedLocalBlob,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../../src/framework/cloud-migration.js';

/**
 * Phase-C data-safety tests for the cloud-migration module:
 *   - per-table rowcount assertion (defensive future-proofing)
 *   - owned-local-blob detection + reporting via MigrationResult.blobsNotMigrated
 *
 * Reuses the verified SQLite source→target harness from
 * cloud-migration.test.ts (NOT `new Lattice(':memory:')` — that does not
 * exercise the real migration path). Tests are written test-first: they
 * fail on the pre-edit code (no assertion, no blobsNotMigrated, no
 * isOwnedLocalBlob export) and pass after the edits land.
 */

const dirs: string[] = [];
const opened: Lattice[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-migrate-blob-'));
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

describe('isOwnedLocalBlob()', () => {
  it("classifies the four ref_kinds + NULL-with-no-bytes correctly", () => {
    // ref_kind === 'blob' → owned-local bytes under data/blobs/
    expect(isOwnedLocalBlob({ ref_kind: 'blob', blob_path: 'data/blobs/aaa', sha256: 'aaa' })).toBe(
      true,
    );
    // legacy NULL ref_kind WITH blob_path → bytes physically exist under data/blobs/
    expect(isOwnedLocalBlob({ ref_kind: null, blob_path: 'data/blobs/bbb' })).toBe(true);
    // local_ref → ref_uri is a machine-local absolute path
    expect(isOwnedLocalBlob({ ref_kind: 'local_ref', ref_uri: '/Users/x/doc.pdf' })).toBe(true);
    // cloud_ref → NOT owned-local (S3 or external URL), even with an opportunistic blob_path
    expect(isOwnedLocalBlob({ ref_kind: 'cloud_ref', ref_uri: 's3://b/k' })).toBe(false);
    expect(
      isOwnedLocalBlob({ ref_kind: 'cloud_ref', ref_uri: 's3://b/k', blob_path: 'data/blobs/ccc' }),
    ).toBe(false);
    // NULL ref_kind with NO blob_path and NO path → nothing owned-local
    expect(isOwnedLocalBlob({ ref_kind: null })).toBe(false);
    // legacy `path`-only row → owned-local
    expect(isOwnedLocalBlob({ ref_kind: null, path: '/data/old/file.txt' })).toBe(true);
  });
});

describe('migrateLatticeData() — blob safety', () => {
  it('(a) happy path: no false warning, soft-delete-consistent counts', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);

    // Seed user rows + a secret.
    await source.insert('items', { name: 'Alpha' });
    await source.insert('items', { name: 'Beta' });
    await source.insert('tasks', { title: 'Ship it', status: 'open' });
    await source.insert('secrets', {
      name: 'OPENAI_API_KEY',
      kind: 'api-key',
      value: 'sk-supersecret-12345',
    });

    // files rows that are ALL cloud_ref — NONE should count toward
    // blobsNotMigrated, INCLUDING one cloud_ref that also carries an
    // opportunistic blob_path (must not over-count).
    await source.insert('files', {
      ref_kind: 'cloud_ref',
      ref_provider: 's3',
      ref_uri: 's3://bucket/key-1',
      sha256: 'x1',
    });
    await source.insert('files', {
      ref_kind: 'cloud_ref',
      ref_provider: 's3',
      ref_uri: 's3://bucket/key-2',
      sha256: 'x2',
      blob_path: 'data/blobs/opportunistic',
    });

    // Insert a row then soft-delete it (set deleted_at directly) so a
    // table carries a soft-deleted row. This PINS the soft-delete-consistent
    // count semantic: a future swap to countActive would exclude this row
    // and make the per-table assertion mismatch (and this test) fail loudly.
    const softId = await source.insert('items', { name: 'Gamma-to-delete' });
    await source.update('items', softId, { deleted_at: new Date().toISOString() });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    const result = await migrateLatticeData(source, target);

    // No throw, and no false warning.
    expect(result.blobsNotMigrated).toBeUndefined();

    // Per-table: target.count(table, {}) equals source query(table, {}) length,
    // including the soft-deleted items row.
    for (const table of result.tablesCopied) {
      const srcRows = (await source.query(table, {})) as Record<string, unknown>[];
      const tgtCount = await target.count(table, {});
      expect(tgtCount).toBe(srcRows.length);
    }

    // items carries the soft-deleted row in both source and target (unfiltered).
    const srcItems = (await source.query('items', {})) as Record<string, unknown>[];
    expect(srcItems).toHaveLength(3); // Alpha, Beta, Gamma(soft-deleted)
    expect(await target.count('items', {})).toBe(3);
    // files: 2 cloud_ref rows copied
    expect(await target.count('files', {})).toBe(2);
  });

  it('(b) reports owned-local blobs (cloud_ref excluded)', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);

    await source.insert('files', { ref_kind: 'blob', blob_path: 'data/blobs/aaa', sha256: 'aaa' });
    await source.insert('files', { ref_kind: null, blob_path: 'data/blobs/bbb' });
    await source.insert('files', { ref_kind: 'local_ref', ref_uri: '/Users/x/doc.pdf' });
    await source.insert('files', { ref_kind: 'cloud_ref', ref_uri: 's3://b/k' });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    const result = await migrateLatticeData(source, target);

    // Rows DID copy (counts match — no throw).
    expect(await target.count('files', {})).toBe(4);
    // blob + null-with-blob_path + local_ref are owned-local; cloud_ref excluded.
    expect(result.blobsNotMigrated).toBe(3);
  });

  it('(c) per-table rowcount mismatch throws; source stays queryable', async () => {
    const root = tempDir();
    const { db: source, configPath } = await openSource(root);

    await source.insert('items', { name: 'Alpha' });
    await source.insert('files', { ref_kind: 'cloud_ref', ref_uri: 's3://b/k' });

    const targetUrl = `file:${join(root, 'data', 'target.db')}`;
    const target = await openTargetLatticeForMigration(configPath, targetUrl, 'migration-test-key');
    opened.push(target);

    // Fault injection: the natural trigger — a silently-dropped upsert — needs
    // this seam, which is exactly the future silent failure the assertion guards.
    // Wrap `target` in a Proxy whose `count('files', …)` returns a wrong number,
    // forcing targetCount !== rows.length for the files table.
    const faultyTarget = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'count') {
          return async (table: string, opts: Record<string, unknown> = {}): Promise<number> => {
            const real = await t.count(table, opts);
            return table === 'files' ? real + 1 : real;
          };
        }
        const value = Reflect.get(t, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });

    await expect(migrateLatticeData(source, faultyTarget)).rejects.toThrow(
      /row-count mismatch for table "files"/,
    );

    // The throw aborts before any caller archive step — source is untouched.
    const srcItems = (await source.query('items', {})) as Record<string, unknown>[];
    expect(srcItems).toHaveLength(1);
  });
});
