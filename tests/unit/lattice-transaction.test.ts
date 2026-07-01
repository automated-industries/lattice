import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * Atomicity of {@link Lattice.transaction}. The GUI entity merge wraps its whole
 * row-move loop in `db.transaction(...)` so a mid-loop failure can't leave rows
 * split between source and target — these tests pin the commit/rollback semantics
 * that guarantee it (on the real SQLite adapter; the Postgres adapter's
 * `withClient` is exercised by the pg integration suite).
 */
describe('Lattice.transaction() — atomic commit / rollback', () => {
  let db: Lattice;

  afterEach(() => {
    db?.close();
  });

  async function boot(): Promise<Lattice> {
    const d = new Lattice(':memory:');
    d.define('items', {
      // inline UNIQUE lets a later insert fail a constraint mid-transaction
      columns: { id: 'TEXT PRIMARY KEY', sku: 'TEXT NOT NULL UNIQUE', name: 'TEXT' },
      render: () => '',
      outputFile: 'items.md',
    });
    await d.init();
    return d;
  }

  it('commits every write when fn resolves', async () => {
    db = await boot();
    await db.transaction(async () => {
      await db.insert('items', { id: 'a', sku: 'A', name: 'Alpha' });
      await db.insert('items', { id: 'b', sku: 'B', name: 'Beta' });
    });
    expect(await db.get('items', 'a')).toMatchObject({ name: 'Alpha' });
    expect(await db.get('items', 'b')).toMatchObject({ name: 'Beta' });
  });

  it('rolls back ALL writes when fn throws mid-way (nothing persists)', async () => {
    db = await boot();
    await db.insert('items', { id: 'seed', sku: 'SEED', name: 'seed' }); // committed before the tx
    await expect(
      db.transaction(async () => {
        await db.insert('items', { id: 'a', sku: 'A', name: 'Alpha' }); // succeeds inside the tx
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The in-transaction insert was rolled back; the pre-existing row is untouched.
    expect(await db.get('items', 'a')).toBeNull();
    expect(await db.get('items', 'seed')).toMatchObject({ name: 'seed' });
  });

  it('rolls back the FIRST write when a LATER write fails a constraint mid-tx', async () => {
    db = await boot();
    await expect(
      db.transaction(async () => {
        await db.insert('items', { id: 'a', sku: 'DUP', name: 'first' });
        await db.insert('items', { id: 'b', sku: 'DUP', name: 'second' }); // UNIQUE violation → throws
      }),
    ).rejects.toThrow();
    // Neither row survives — the successful first insert rolls back with the failed second.
    expect(await db.get('items', 'a')).toBeNull();
    expect(await db.get('items', 'b')).toBeNull();
  });

  it('reads its own uncommitted writes inside the transaction', async () => {
    db = await boot();
    let seen: unknown;
    await db.transaction(async () => {
      await db.insert('items', { id: 'a', sku: 'A', name: 'Alpha' });
      seen = await db.get('items', 'a'); // read-your-writes within the same tx connection
    });
    expect(seen).toMatchObject({ name: 'Alpha' });
  });

  it('a nested transaction reuses the outer one (no second BEGIN)', async () => {
    db = await boot();
    await db.transaction(async () => {
      await db.insert('items', { id: 'a', sku: 'A', name: 'Alpha' });
      await db.transaction(async () => {
        await db.insert('items', { id: 'b', sku: 'B', name: 'Beta' });
      });
    });
    expect(await db.get('items', 'a')).toMatchObject({ name: 'Alpha' });
    expect(await db.get('items', 'b')).toMatchObject({ name: 'Beta' });
  });

  it('a throw after a nested transaction rolls back BOTH levels', async () => {
    db = await boot();
    await expect(
      db.transaction(async () => {
        await db.insert('items', { id: 'a', sku: 'A' });
        await db.transaction(async () => {
          await db.insert('items', { id: 'b', sku: 'B' });
        });
        throw new Error('outer-boom');
      }),
    ).rejects.toThrow('outer-boom');
    expect(await db.get('items', 'a')).toBeNull();
    expect(await db.get('items', 'b')).toBeNull(); // nested write shared the outer tx → rolled back too
  });

  it('returns fn’s value on commit', async () => {
    db = await boot();
    const out = await db.transaction(async () => {
      await db.insert('items', { id: 'a', sku: 'A' });
      return 42;
    });
    expect(out).toBe(42);
  });
});
