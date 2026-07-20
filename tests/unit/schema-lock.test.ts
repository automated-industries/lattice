import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';

/**
 * The Lattice schema lock (withSchemaLock) serializes DDL (CREATE TABLE / ALTER …
 * ADD COLUMN) so a parallel folder ingest can't crash on the single synchronous
 * SQLite connection. The hazard is a check-then-act straddling an await: two
 * concurrent addColumn calls for the SAME column both read it absent, then both
 * ALTER — the loser throwing "duplicate column name". These tests exercise the
 * primitive directly (no ingest scaffolding) so the safety property is pinned at
 * the level the whole design rests on. Row inserts are deliberately NOT serialized
 * (atomic auto-commit, uuid keys) — a concurrent-insert test guards that they stay
 * fast and correct without a lock.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeDb(): Promise<Lattice> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-schemalock-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'db.sqlite'));
  db.define('orders', {
    columns: { id: 'TEXT PRIMARY KEY', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '.s/orders.md',
  });
  await db.init();
  return db;
}

describe('Lattice.withSchemaLock — DDL concurrency safety', () => {
  it('N concurrent addColumn of the SAME column resolve to a single add, no throw', async () => {
    const db = await makeDb();
    // Fire 8 concurrent adds of the same new column. Without the lock the
    // introspect→ALTER race throws "duplicate column name" on all but the first.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => db.addColumn('orders', 'amount', 'TEXT')),
    );
    for (const o of outcomes) {
      expect(o.status).toBe('fulfilled');
    }
    // The column exists exactly once and is registered.
    const cols = db.getRegisteredColumns('orders');
    expect(cols && 'amount' in cols).toBe(true);
    // A row can be written to it (schema is physically consistent).
    const id = await db.insert('orders', { amount: '10' });
    const row = (await db.get('orders', id)) as { amount?: string } | null;
    expect(row?.amount).toBe('10');
    db.close();
  });

  it('concurrent addColumn of DIFFERENT columns all land', async () => {
    const db = await makeDb();
    const names = ['amount', 'due_date', 'vendor', 'status', 'memo', 'tax'];
    const outcomes = await Promise.allSettled(names.map((n) => db.addColumn('orders', n, 'TEXT')));
    for (const o of outcomes) expect(o.status).toBe('fulfilled');
    const cols = db.getRegisteredColumns('orders') ?? {};
    for (const n of names) expect(n in cols).toBe(true);
    db.close();
  });

  it('reentrant: a locked section that adds a column does not deadlock', async () => {
    const db = await makeDb();
    // withSchemaLock is reentrant — a caller already holding the lock (outer) that
    // triggers more DDL (addColumn, which acquires the lock again) runs inline rather
    // than waiting on a queue it already owns. If it were non-reentrant this would
    // hang and the test would time out.
    await db.withSchemaLock(async () => {
      await db.addColumn('orders', 'nested_col', 'TEXT');
    });
    const cols = db.getRegisteredColumns('orders') ?? {};
    expect('nested_col' in cols).toBe(true);
    db.close();
  });

  it('locked sections run one-at-a-time (mutual exclusion)', async () => {
    const db = await makeDb();
    let active = 0;
    let maxActive = 0;
    const section = () =>
      db.withSchemaLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        // Yield across a macrotask so a non-exclusive lock would let a sibling in.
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([section(), section(), section(), section()]);
    expect(maxActive).toBe(1); // never two inside the lock at once
    db.close();
  });

  it('concurrent row inserts (no DDL) all land — inserts are not blocked by the lock', async () => {
    const db = await makeDb();
    await db.addColumn('orders', 'amount', 'TEXT');
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_v, i) => db.insert('orders', { amount: String(i) })),
    );
    expect(new Set(ids).size).toBe(20); // 20 distinct rows, no collision
    const rows = (await db.query('orders', {})) as unknown[];
    expect(rows.length).toBe(20);
    db.close();
  });
});
