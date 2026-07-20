import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { secretColumnsFor } from '../../src/gui/ai/handlers/read.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

/**
 * `getEncryptedColumns(table)` is the accessor the generic table route uses to MASK
 * framework-encrypted columns (decrypted-on-read) before shipping rows over HTTP (S4 defense in
 * depth for a user-DEFINED encrypted column, on top of the outright `secrets` refusal).
 */
describe('Lattice.getEncryptedColumns', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns the encrypted column set for a table, and empty for a plain table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-enc-acc-'));
    dirs.push(dir);
    const db = new Lattice(join(dir, 'test.db'), { encryptionKey: 'k-42' });
    db.define('vault', {
      columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', token: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/vault.md',
    });
    db.defineEntityContext('vault', {
      slug: (r) => r.id as string,
      encrypted: { columns: ['token'] },
      directoryRoot: 'vault',
      files: {},
    });
    db.define('plain', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/plain.md',
    });
    await db.init();

    expect([...db.getEncryptedColumns('vault')]).toEqual(['token']);
    expect(db.getEncryptedColumns('plain').size).toBe(0);
    // An unknown table is safely empty (never throws).
    expect(db.getEncryptedColumns('does_not_exist').size).toBe(0);
    db.close();
  });

  it('secretColumnsFor includes framework-encrypted columns, not just gui-flagged ones (S4 round-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-secret-cols-'));
    dirs.push(dir);
    const db = new Lattice(join(dir, 'test.db'), { encryptionKey: 'k-42' });
    db.define('vault', {
      columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', token: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/vault.md',
    });
    db.defineEntityContext('vault', {
      slug: (r) => r.id as string,
      encrypted: { columns: ['token'] },
      directoryRoot: 'vault',
      files: {},
    });
    await db.init();

    // Even with NO gui `set_column_secret` flag, the framework-encrypted `token` must be in the
    // mask set — the assistant read tools redact from this set, so a config-encrypted-only column
    // must not stream decrypted into the model context.
    const cols = await secretColumnsFor(db, 'vault');
    expect(cols.has('token')).toBe(true);
    db.close();
  });
});
