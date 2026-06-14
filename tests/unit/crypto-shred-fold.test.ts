/**
 * Crypto-shred composed with the per-viewer fold (Stage 3). A derived value from
 * a source flagged sensitive is sealed under that source's key inside the
 * observation; the fold opens it with the key store. Destroying the key
 * (shredSource) makes the value unrecoverable, and the fold then reverts the
 * attribute to ground truth with no residue — the durable, backup-proof "forget".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { InMemorySourceKeyStore, shredSource } from '../../src/cloud/shred.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function openDb(): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-shred-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'db.sqlite'));
  db.define('contact', {
    columns: { id: 'TEXT PRIMARY KEY', phone: 'TEXT' },
    render: () => '',
    outputFile: 'c.md',
  });
  await db.init();
  return db;
}

describe('crypto-shred + fold', () => {
  it('seals a sensitive derived value, opens it with the key, and reverts after shred', async () => {
    const db = await openDb();
    const store = new InMemorySourceKeyStore();
    await db.upsert('contact', { id: 'c1', phone: 'gt-phone' });

    // A derived value from a SENSITIVE source F — sealed under F's key.
    await db.observe(
      'contact',
      'c1',
      { phone: '555-secret' },
      { sourceRef: ['F'], changeKind: 'derived', sourceSensitive: true },
      { keyStore: store },
    );

    // The change-log holds only ciphertext — the plaintext is not in the row.
    const raw = await db.history('contact', 'c1');
    expect(JSON.stringify(raw)).not.toContain('555-secret');

    // With the key store, the fold opens the sealed value.
    expect((await db.foldForViewer('contact', 'c1', { keyStore: store }))?.phone).toBe(
      '555-secret',
    );
    // Without the key store, the sealed observation can't be read → ground truth.
    expect((await db.foldForViewer('contact', 'c1'))?.phone).toBe('gt-phone');

    // Shred F → the value is unrecoverable; the fold reverts to ground truth.
    shredSource('F', store);
    expect((await db.foldForViewer('contact', 'c1', { keyStore: store }))?.phone).toBe('gt-phone');
    db.close();
  });
});
