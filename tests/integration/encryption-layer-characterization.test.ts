import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { encrypt, deriveKey } from '../../src/security/encryption.js';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const KEY = 'characterization-secret-key-99';

function makeDb(dbPath: string, opts: { withKey?: boolean } = {}): Lattice {
  const db = new Lattice(dbPath, opts.withKey === false ? {} : { encryptionKey: KEY });
  db.define('vault', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      secret: 'TEXT',
      note: 'TEXT',
      created_at: 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
      updated_at: 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.schema-only/vault.md',
    encrypted: { columns: ['secret'] },
  });
  return db;
}

describe('EncryptionLayer extraction — characterization', () => {
  let tmpDir: string;
  let dbPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enc-char-'));
    dbPath = join(tmpDir, 'test.db');
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips: encrypts at rest, decrypts on read; non-targeted columns plaintext', async () => {
    const db = makeDb(dbPath);
    await db.init();
    try {
      const pk = await db.insert('vault', {
        name: 'API_KEY',
        secret: 'sk-super-secret-xyz',
        note: 'a plaintext note',
      });
      const got = await db.get('vault', pk);
      expect(got!.secret).toBe('sk-super-secret-xyz');
      expect(got!.note).toBe('a plaintext note');
      const queried = await db.query('vault', { where: { name: 'API_KEY' } });
      expect(queried).toHaveLength(1);
      expect(queried[0].secret).toBe('sk-super-secret-xyz');
      const raw = new Database(dbPath);
      const rawRow = raw.prepare('SELECT secret, note FROM vault WHERE id = ?').get(pk) as Record<
        string,
        string
      >;
      raw.close();
      expect(rawRow.secret).toMatch(/^enc:/);
      expect(rawRow.secret).not.toContain('sk-super-secret-xyz');
      expect(rawRow.note).toBe('a plaintext note');
    } finally {
      db.close();
    }
  });

  it('decrypts ciphertext written under the SAME at-rest format by the leaf primitives', async () => {
    const seed = new Database(dbPath);
    const preCipher = encrypt('legacy-at-rest-value', deriveKey(KEY));
    expect(preCipher).toMatch(/^enc:/);
    const db = makeDb(dbPath);
    await db.init();
    try {
      seed
        .prepare(
          "INSERT INTO vault (id, name, secret, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        )
        .run('legacy-1', 'LEGACY', preCipher);
      seed.close();
      const row = await db.get('vault', 'legacy-1');
      expect(row!.secret).toBe('legacy-at-rest-value');
      const seed2 = new Database(dbPath);
      seed2
        .prepare(
          "INSERT INTO vault (id, name, secret, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        )
        .run('plain-1', 'PLAIN', 'never-encrypted');
      seed2.close();
      const plainRow = await db.get('vault', 'plain-1');
      expect(plainRow!.secret).toBe('never-encrypted');
    } finally {
      db.close();
    }
  });

  it('key-validation throws SYNCHRONOUSLY from init() (not a rejected Promise)', () => {
    const db = makeDb(dbPath, { withKey: false });
    expect(() => db.init()).toThrow(/encryptionKey/);
    db.close();
  });

  it('init() resolves normally when an encrypted table HAS a key (no spurious throw)', async () => {
    const db = makeDb(dbPath);
    await expect(db.init()).resolves.toBeUndefined();
    db.close();
  });
});
