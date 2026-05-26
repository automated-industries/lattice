import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Lattice } from '../../src/lattice.js';
import { NATIVE_ENTITY_DEFS, registerNativeEntities } from '../../src/framework/native-entities.js';
import { attachBlob } from '../../src/framework/blob-store.js';

describe('framework native entities', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-native-'));
    dbPath = join(tmpDir, 'test.db');
    db = new Lattice(dbPath, { encryptionKey: 'native-entity-test-key' });
    registerNativeEntities(db);
    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('registerNativeEntities()', () => {
    it('registers `secrets` and `files` tables', () => {
      const names = db.getRegisteredTableNames();
      expect(names).toContain('secrets');
      expect(names).toContain('files');
    });

    it('is idempotent — second call is a no-op', () => {
      expect(() => {
        registerNativeEntities(db);
      }).not.toThrow();
      const names = db.getRegisteredTableNames();
      expect(names.filter((n) => n === 'secrets')).toHaveLength(1);
      expect(names.filter((n) => n === 'files')).toHaveLength(1);
    });

    it('exports the canonical column shapes via NATIVE_ENTITY_DEFS', () => {
      expect(NATIVE_ENTITY_DEFS.secrets.columns).toMatchObject({
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        value: 'TEXT',
      });
      expect(NATIVE_ENTITY_DEFS.secrets.encrypted).toEqual({ columns: ['value'] });
      expect(NATIVE_ENTITY_DEFS.files.columns).toMatchObject({
        id: 'TEXT PRIMARY KEY',
        sha256: 'TEXT',
        blob_path: 'TEXT',
      });
    });
  });

  describe('secrets table encryption', () => {
    it('encrypts the `value` column at rest', async () => {
      const id = await db.insert('secrets', {
        name: 'API_KEY',
        kind: 'api-key',
        value: 'plaintext-supersecret-42',
      });

      // Read via Lattice — should decrypt.
      const row = await db.get('secrets', id);
      expect(row!.value).toBe('plaintext-supersecret-42');

      // Read raw via SQLite — should be enc:-prefixed.
      const raw = new Database(dbPath);
      const rawRow = raw
        .prepare('SELECT value, name, kind FROM secrets WHERE id = ?')
        .get(id) as Record<string, string>;
      raw.close();
      expect(rawRow.value).toMatch(/^enc:/);
      expect(rawRow.value).not.toContain('plaintext-supersecret-42');
      // Non-encrypted columns stay plaintext.
      expect(rawRow.name).toBe('API_KEY');
      expect(rawRow.kind).toBe('api-key');
    });

    it('throws at init time when a table has encrypted columns but no key is configured', () => {
      const dbPath2 = join(tmpDir, 'no-key.db');
      const db2 = new Lattice(dbPath2);
      registerNativeEntities(db2);
      // The validation runs in init()'s synchronous prefix so consumers
      // get a thrown Error rather than a Promise rejection — see the
      // comment on Lattice.init().
      expect(() => db2.init()).toThrow(/encryptionKey/);
    });
  });

  describe('files table', () => {
    it('accepts both legacy (path/kind) and content-addressed inserts', async () => {
      const legacy = await db.insert('files', {
        path: '/legacy/file.md',
        kind: 'markdown',
      });
      const modern = await db.insert('files', {
        original_name: 'document.pdf',
        mime: 'application/pdf',
        size_bytes: 12345,
        sha256: 'a'.repeat(64),
        blob_path: 'data/blobs/' + 'a'.repeat(64),
      });
      const legacyRow = await db.get('files', legacy);
      const modernRow = await db.get('files', modern);
      expect(legacyRow!.path).toBe('/legacy/file.md');
      expect(modernRow!.sha256).toBe('a'.repeat(64));
    });
  });

  describe('attachBlob()', () => {
    it('writes a file into data/blobs/<sha256> and returns metadata', async () => {
      const srcPath = join(tmpDir, 'source.txt');
      writeFileSync(srcPath, 'hello world\n', 'utf8');

      const meta = await attachBlob(srcPath, tmpDir);
      expect(meta.original_name).toBe('source.txt');
      expect(meta.size_bytes).toBeGreaterThan(0);
      expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.blob_path).toBe(`data/blobs/${meta.sha256}`);

      const blobAbs = join(tmpDir, meta.blob_path);
      expect(existsSync(blobAbs)).toBe(true);
      expect(statSync(blobAbs).size).toBe(meta.size_bytes);
    });

    it('is idempotent — re-attaching the same content does not duplicate', async () => {
      const a = join(tmpDir, 'a.txt');
      const b = join(tmpDir, 'b.txt');
      writeFileSync(a, 'same content', 'utf8');
      writeFileSync(b, 'same content', 'utf8');

      const ma = await attachBlob(a, tmpDir);
      const mb = await attachBlob(b, tmpDir);
      expect(ma.sha256).toBe(mb.sha256);
      // Both should land at the same blob path.
      expect(ma.blob_path).toBe(mb.blob_path);
    });
  });

  describe('encryption still works for entity-contexts after the refactor', () => {
    it('encrypts entity-context columns the same way it did before native tables', async () => {
      const dbPath3 = join(tmpDir, 'ec-test.db');
      const db3 = new Lattice(dbPath3, { encryptionKey: 'ec-test-key' });
      db3.define('vault', {
        columns: {
          id: 'TEXT PRIMARY KEY',
          label: 'TEXT NOT NULL',
          token: 'TEXT',
        },
        render: () => '',
        outputFile: '.schema-only/vault.md',
      });
      db3.defineEntityContext('vault', {
        slug: (r) => r.label as string,
        encrypted: { columns: ['token'] },
        directoryRoot: 'vault',
        files: {},
      });
      await db3.init();

      const id = await db3.insert('vault', { label: 'github', token: 'ghp_secret' });
      const row = await db3.get('vault', id);
      expect(row!.token).toBe('ghp_secret');

      const raw = new Database(dbPath3);
      const rawRow = raw.prepare('SELECT token FROM vault WHERE id = ?').get(id) as {
        token: string;
      };
      raw.close();
      expect(rawRow.token).toMatch(/^enc:/);
      db3.close();
    });
  });
});
