import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeDb(opts: { maxRowBytes?: number } = {}): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-maxrow-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'), opts);
  db.define('notes', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      body: 'TEXT',
    },
    render: () => '',
    outputFile: 'notes.md',
  });
  await db.init();
  return db;
}

describe('LatticeOptions.maxRowBytes', () => {
  it('accepts rows under the cap', async () => {
    const db = await makeDb({ maxRowBytes: 1024 });
    const id = await db.insert('notes', { body: 'small body' });
    expect(id).toBeTruthy();
    db.close();
  });

  it('rejects insert with a body over the cap', async () => {
    const db = await makeDb({ maxRowBytes: 100 });
    const big = 'X'.repeat(1024);
    await expect(db.insert('notes', { body: big })).rejects.toThrow(/exceeds maxRowBytes/);
    db.close();
  });

  it('rejects upsert with a body over the cap', async () => {
    const db = await makeDb({ maxRowBytes: 100 });
    const big = 'Y'.repeat(1024);
    await expect(db.upsert('notes', { id: 'x', body: big })).rejects.toThrow(/exceeds maxRowBytes/);
    db.close();
  });

  it('rejects update with a body over the cap', async () => {
    const db = await makeDb({ maxRowBytes: 100 });
    const id = await db.insert('notes', { body: 'small' });
    const big = 'Z'.repeat(1024);
    await expect(db.update('notes', id, { body: big })).rejects.toThrow(/exceeds maxRowBytes/);
    db.close();
  });

  it('default behavior (no option set) accepts large bodies', async () => {
    const db = await makeDb(); // no maxRowBytes
    const big = 'M'.repeat(2_000_000); // 2 MB
    const id = await db.insert('notes', { body: big });
    expect(id).toBeTruthy();
    db.close();
  });

  it('the error message names the table and the limit', async () => {
    const db = await makeDb({ maxRowBytes: 50 });
    try {
      await db.insert('notes', { body: 'X'.repeat(200) });
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as Error).message).toContain('notes');
      expect((e as Error).message).toContain('50');
    }
    db.close();
  });

  it('counts UTF-8 byte length, not character count', async () => {
    // 100 emoji = ~400 bytes (4 bytes/emoji), well over a 200-byte cap
    const db = await makeDb({ maxRowBytes: 200 });
    const emoji = '🔒'.repeat(100);
    await expect(db.insert('notes', { body: emoji })).rejects.toThrow(/exceeds maxRowBytes/);
    db.close();
  });
});
