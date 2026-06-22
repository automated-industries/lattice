import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import type { StorageAdapter } from '../../src/db/adapter.js';
import type { Row } from '../../src/types.js';
import {
  applyChunkedMigration,
  resumeMigration,
  revertMigration,
  listMigrationCheckpoints,
  getMigrationCheckpoint,
} from '../../src/schema/chunked-migration.js';

/** apply: backfill flag = upper(name) for each row. */
const backfill = async (rows: Row[], adapter: StorageAdapter): Promise<void> => {
  for (const r of rows) {
    await runAsyncOrSync(adapter, `UPDATE items SET flag = ? WHERE id = ?`, [
      String(r.name).toUpperCase(),
      r.id,
    ]);
  }
};

describe('chunked migrations (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(n: number): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', flag: 'TEXT' },
      render: () => '',
      outputFile: 'i.md',
    });
    await db.init();
    for (let i = 0; i < n; i++) {
      await db.insert('items', { id: `i${String(i).padStart(3, '0')}`, name: `n${String(i)}` });
    }
    return db;
  }

  it('backfills every row in batches and records a complete checkpoint', async () => {
    const d = await setup(10);
    const res = await applyChunkedMigration(d.adapter, {
      id: 'backfill-flag',
      table: 'items',
      apply: backfill,
      batchSize: 3,
    });
    expect(res.processed).toBe(10);
    expect(res.batches).toBe(4); // 3+3+3+1
    expect(res.status).toBe('complete');

    const unflagged = await allAsyncOrSync(d.adapter, `SELECT id FROM items WHERE flag IS NULL`);
    expect(unflagged).toHaveLength(0);

    const cp = await getMigrationCheckpoint(d.adapter, 'backfill-flag');
    expect(cp?.status).toBe('complete');
    expect(cp?.processed).toBe(10);
  });

  it('resumes after a kill, finishing exactly the remaining rows', async () => {
    const d = await setup(10);
    let applied = 0;
    // Throw partway: after 2 batches (6 rows) succeed, the next batch fails.
    const flaky = async (rows: Row[], adapter: StorageAdapter): Promise<void> => {
      if (applied >= 6) throw new Error('simulated kill');
      await backfill(rows, adapter);
      applied += rows.length;
    };

    await expect(
      applyChunkedMigration(d.adapter, {
        id: 'resumable',
        table: 'items',
        apply: flaky,
        batchSize: 3,
      }),
    ).rejects.toThrow('simulated kill');

    const mid = await getMigrationCheckpoint(d.adapter, 'resumable');
    expect(mid?.status).toBe('running');
    expect(mid?.processed).toBe(6); // 2 committed batches

    // Resume with a working apply — it continues from the checkpoint.
    const res = await resumeMigration(d.adapter, {
      id: 'resumable',
      table: 'items',
      apply: backfill,
      batchSize: 3,
    });
    expect(res.status).toBe('complete');

    const unflagged = await allAsyncOrSync(d.adapter, `SELECT id FROM items WHERE flag IS NULL`);
    expect(unflagged).toHaveLength(0);
    const cp = await getMigrationCheckpoint(d.adapter, 'resumable');
    expect(cp?.processed).toBe(10);
  });

  it('re-running a completed migration is a no-op', async () => {
    const d = await setup(5);
    await applyChunkedMigration(d.adapter, {
      id: 'm',
      table: 'items',
      apply: backfill,
      batchSize: 2,
    });
    const again = await applyChunkedMigration(d.adapter, {
      id: 'm',
      table: 'items',
      apply: backfill,
      batchSize: 2,
    });
    expect(again.batches).toBe(0);
    expect(again.status).toBe('complete');
  });

  it('resumeMigration throws when there is no checkpoint', async () => {
    const d = await setup(3);
    await expect(
      resumeMigration(d.adapter, { id: 'missing', table: 'items', apply: backfill }),
    ).rejects.toThrow(/no checkpoint/);
  });

  it('revertMigration walks rows and marks the checkpoint reverted', async () => {
    const d = await setup(6);
    await applyChunkedMigration(d.adapter, {
      id: 'r',
      table: 'items',
      apply: backfill,
      batchSize: 2,
    });
    const clear = async (rows: Row[], adapter: StorageAdapter): Promise<void> => {
      for (const row of rows)
        await runAsyncOrSync(adapter, `UPDATE items SET flag = NULL WHERE id = ?`, [row.id]);
    };
    const res = await revertMigration(d.adapter, 'r', 'items', clear, { batchSize: 2 });
    expect(res.status).toBe('reverted');
    expect(res.processed).toBe(6);
    const flagged = await allAsyncOrSync(d.adapter, `SELECT id FROM items WHERE flag IS NOT NULL`);
    expect(flagged).toHaveLength(0);
    const cp = await getMigrationCheckpoint(d.adapter, 'r');
    expect(cp?.status).toBe('reverted');
  });

  it('lists all checkpoints', async () => {
    const d = await setup(2);
    await applyChunkedMigration(d.adapter, { id: 'a', table: 'items', apply: backfill });
    await applyChunkedMigration(d.adapter, { id: 'b', table: 'items', apply: backfill });
    const all = await listMigrationCheckpoints(d.adapter);
    expect(all.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});
