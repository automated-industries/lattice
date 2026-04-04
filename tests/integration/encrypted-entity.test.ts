import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

describe('encrypted entity context — integration', () => {
  let db: Lattice;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enc-'));
    dbPath = join(tmpDir, 'test.db');

    db = new Lattice(dbPath, { encryptionKey: 'test-secret-key-42' });

    db.define('secrets', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        value: 'TEXT',
        description: 'TEXT',
        created_at: 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        updated_at: 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '.schema-only/secrets.md',
    });

    db.defineEntityContext('secrets', {
      slug: (r) => r.name as string,
      protected: true,
      encrypted: { columns: ['value'] },
      directoryRoot: 'secrets',
      files: {},
    });

    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('encrypts value on insert and decrypts on get', async () => {
    const pk = await db.insert('secrets', {
      name: 'API_KEY',
      value: 'sk-ant-secret-123',
      description: 'Test key',
    });

    // Read decrypted via Lattice
    const row = await db.get('secrets', pk);
    expect(row!.value).toBe('sk-ant-secret-123');
    expect(row!.description).toBe('Test key'); // not encrypted

    // Read raw via SQLite — should be encrypted
    const raw = new Database(dbPath);
    const rawRow = raw
      .prepare('SELECT value, description FROM secrets WHERE id = ?')
      .get(pk) as Record<string, string>;
    raw.close();

    expect(rawRow.value).toMatch(/^enc:/);
    expect(rawRow.value).not.toContain('sk-ant-secret-123');
    expect(rawRow.description).toBe('Test key'); // not encrypted (not in columns list)
  });

  it('encrypts on update and decrypts on query', async () => {
    const pk = await db.insert('secrets', { name: 'TOKEN', value: 'old-value' });
    await db.update('secrets', pk, { value: 'new-value' });

    const rows = await db.query('secrets', { where: { name: 'TOKEN' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('new-value');

    // Raw check
    const raw = new Database(dbPath);
    const rawRow = raw.prepare('SELECT value FROM secrets WHERE id = ?').get(pk) as Record<
      string,
      string
    >;
    raw.close();
    expect(rawRow.value).toMatch(/^enc:/);
  });

  it('handles plaintext passthrough for migration safety', async () => {
    // Insert raw plaintext directly (simulating pre-encryption data)
    const raw = new Database(dbPath);
    raw
      .prepare(
        "INSERT INTO secrets (id, name, value, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      )
      .run('legacy-1', 'OLD_KEY', 'plaintext-value');
    raw.close();

    // Lattice should read it fine (plaintext passthrough)
    const row = await db.get('secrets', 'legacy-1');
    expect(row!.value).toBe('plaintext-value');
  });
});

describe('encrypted entity context — error handling', () => {
  it('throws when encrypted entity defined without encryptionKey', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enc-err-'));
    const db = new Lattice(join(tmpDir, 'test.db'));

    db.define('secrets', {
      columns: { id: 'TEXT PRIMARY KEY', value: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/secrets.md',
    });

    db.defineEntityContext('secrets', {
      slug: (r) => r.id as string,
      encrypted: true,
      files: {},
    });

    expect(() => db.init()).toThrow(/encryptionKey/);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
