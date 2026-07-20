/**
 * Postgres integration coverage for {@link Lattice.transaction}. The SQLite unit
 * test (`tests/unit/lattice-transaction.test.ts`) pins the semantics; this proves
 * the same commit/rollback behavior over the Postgres adapter's `withClient`
 * (pooled connection + real BEGIN/COMMIT/ROLLBACK) — the path a cloud entity
 * merge actually takes. Mirrors `feedback_test_against_target_dialect.md`.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice.transaction() (Postgres integration)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_tx_items`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        sku: 'TEXT NOT NULL UNIQUE',
        name: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    db?.close();
  });

  it('commits every write when fn resolves', async () => {
    await db.transaction(async () => {
      await db.insert(table, { id: 'c-a', sku: 'C-A', name: 'Alpha' });
      await db.insert(table, { id: 'c-b', sku: 'C-B', name: 'Beta' });
    });
    expect(await db.get(table, 'c-a')).toMatchObject({ name: 'Alpha' });
    expect(await db.get(table, 'c-b')).toMatchObject({ name: 'Beta' });
  });

  it('rolls back ALL writes when fn throws mid-way', async () => {
    await expect(
      db.transaction(async () => {
        await db.insert(table, { id: 'r-a', sku: 'R-A', name: 'Alpha' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.get(table, 'r-a')).toBeNull();
  });

  it('rolls back the FIRST write when a LATER write fails a constraint', async () => {
    await expect(
      db.transaction(async () => {
        await db.insert(table, { id: 'd-a', sku: 'DUP-PG', name: 'first' });
        await db.insert(table, { id: 'd-b', sku: 'DUP-PG', name: 'second' }); // UNIQUE → throws
      }),
    ).rejects.toThrow();
    expect(await db.get(table, 'd-a')).toBeNull();
    expect(await db.get(table, 'd-b')).toBeNull();
  });

  it('reads its own uncommitted writes inside the transaction', async () => {
    let seen: unknown;
    await db.transaction(async () => {
      await db.insert(table, { id: 'ryw', sku: 'RYW', name: 'Alpha' });
      seen = await db.get(table, 'ryw');
    });
    expect(seen).toMatchObject({ name: 'Alpha' });
  });
});
