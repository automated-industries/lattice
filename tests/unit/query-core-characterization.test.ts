import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

/**
 * Characterization test for the read surface (query/get vs getActive/countActive/
 * getByNaturalKey). It pins the load-bearing DECRYPTION ASYMMETRY so a later
 * refactor of these methods cannot silently change which ones decrypt:
 *
 *   - `query()` and `get()` DECRYPT sealed/encrypted columns before returning.
 *   - `getActive()` and `getByNaturalKey()` return the RAW (still-encrypted)
 *     stored value for that same column.
 *
 * If a refactor accidentally makes getActive/getByNaturalKey decrypt, or makes
 * query/get stop decrypting, exactly one of these assertions flips and the test
 * fails — which is the whole point.
 */
describe('read surface — decryption asymmetry (characterization)', () => {
  let db: Lattice;
  let dbPath: string;
  let tmpDir: string;
  const PLAINTEXT = 'sk-ant-secret-123';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-querycore-'));
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

  /** Read the on-disk (still-encrypted) value for a row, bypassing Lattice. */
  function rawStoredValue(id: string): string {
    const raw = new Database(dbPath);
    const rawRow = raw.prepare('SELECT value FROM secrets WHERE id = ?').get(id) as {
      value: string;
    };
    raw.close();
    return rawRow.value;
  }

  it('query() decrypts; getActive() and getByNaturalKey() return the raw stored value', async () => {
    const pk = await db.insert('secrets', { name: 'API_KEY', value: PLAINTEXT });

    // The stored value must actually be encrypted, otherwise the asymmetry is
    // untestable (raw == decrypted) and the test would pass vacuously.
    const stored = rawStoredValue(pk);
    expect(stored).toMatch(/^enc:/);
    expect(stored).not.toContain(PLAINTEXT);

    // query() DECRYPTS.
    const queried = await db.query('secrets', { where: { name: 'API_KEY' } });
    expect(queried).toHaveLength(1);
    expect(queried[0].value).toBe(PLAINTEXT);

    // get() DECRYPTS.
    const got = await db.get('secrets', pk);
    expect(got!.value).toBe(PLAINTEXT);

    // getActive() returns the RAW stored value (no decryption).
    const active = await db.getActive('secrets');
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe(stored);
    expect(active[0].value).not.toBe(PLAINTEXT);

    // getByNaturalKey() returns the RAW stored value (no decryption).
    const byKey = await db.getByNaturalKey('secrets', 'name', 'API_KEY');
    expect(byKey!.value).toBe(stored);
    expect(byKey!.value).not.toBe(PLAINTEXT);
  });

  it('count/countActive agree on the row count without touching the encrypted payload', async () => {
    await db.insert('secrets', { name: 'A', value: PLAINTEXT });
    await db.insert('secrets', { name: 'B', value: PLAINTEXT });

    expect(await db.count('secrets')).toBe(2);
    expect(await db.countActive('secrets')).toBe(2);
    expect(await db.count('secrets', { where: { name: 'A' } })).toBe(1);
  });
});
