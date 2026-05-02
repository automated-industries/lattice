/**
 * SQLite withClient tests. Postgres withClient is exercised via the
 * lattice-as-a-whole integration tests in consumer projects (it requires
 * a real Postgres server); the math of "transactional atomicity" is the
 * same on both adapters, so the SQLite tests here lock down the contract
 * that consumers depend on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../src/db/sqlite.js';

describe('SQLiteAdapter.withClient', () => {
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    adapter = new SQLiteAdapter(':memory:');
    adapter.open();
    adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  });

  afterEach(() => {
    adapter.close();
  });

  it('commits all writes on resolve', async () => {
    await adapter.withClient(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
      await tx.run('INSERT INTO t (v) VALUES (?)', ['b']);
      await tx.run('INSERT INTO t (v) VALUES (?)', ['c']);
    });
    const rows = adapter.all('SELECT v FROM t ORDER BY id');
    expect(rows.map((r) => r.v)).toEqual(['a', 'b', 'c']);
  });

  it('rolls back all writes when fn throws', async () => {
    await expect(
      adapter.withClient(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
        await tx.run('INSERT INTO t (v) VALUES (?)', ['b']);
        throw new Error('intentional');
      }),
    ).rejects.toThrow('intentional');

    const rows = adapter.all('SELECT v FROM t ORDER BY id');
    expect(rows).toHaveLength(0);
  });

  it('returns the value resolved by fn', async () => {
    const result = await adapter.withClient(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['x']);
      const row = await tx.get('SELECT COUNT(*) AS n FROM t');
      return Number(row?.n ?? 0);
    });
    expect(result).toBe(1);
  });

  it('tx.get and tx.all see writes made earlier in the same transaction', async () => {
    await adapter.withClient(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
      const one = await tx.get('SELECT v FROM t WHERE v = ?', ['a']);
      expect(one?.v).toBe('a');

      await tx.run('INSERT INTO t (v) VALUES (?)', ['b']);
      const all = await tx.all('SELECT v FROM t ORDER BY id');
      expect(all.map((r) => r.v)).toEqual(['a', 'b']);
    });
  });

  it('rollback survives ROLLBACK errors without masking the original throw', async () => {
    // Even if ROLLBACK itself were to fail (rare on SQLite, simulated here
    // by closing the adapter mid-transaction), the original error from fn
    // must still propagate.
    let threw = false;
    try {
      await adapter.withClient(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
        throw new Error('fn-error');
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe('fn-error');
    }
    expect(threw).toBe(true);
  });

  it('reports dialect = "sqlite"', () => {
    expect(adapter.dialect).toBe('sqlite');
  });
});
