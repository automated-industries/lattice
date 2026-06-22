/**
 * Postgres dialect-parity for p4b chunked migrations: batched backfill +
 * resume-after-kill on a real Postgres cluster.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import type { StorageAdapter } from '../../src/db/adapter.js';
import type { Row } from '../../src/types.js';
import {
  applyChunkedMigration,
  resumeMigration,
  getMigrationCheckpoint,
} from '../../src/schema/chunked-migration.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('chunked migrations (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_items`;

  const backfill = async (rows: Row[], adapter: StorageAdapter): Promise<void> => {
    for (const r of rows) {
      await runAsyncOrSync(adapter, `UPDATE "${table}" SET flag = ? WHERE id = ?`, [
        String(r.name).toUpperCase(),
        r.id,
      ]);
    }
  };

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    await db.init();
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, name TEXT, flag TEXT)`,
    );
    for (let i = 0; i < 10; i++) {
      await runAsyncOrSync(db.adapter, `INSERT INTO "${table}" (id, name) VALUES (?, ?)`, [
        `i${String(i).padStart(3, '0')}`,
        `n${String(i)}`,
      ]);
    }
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "__lattice_migration_checkpoints" WHERE table_name = '${table}'`,
      );
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('backfills + resumes after a kill on Postgres', async () => {
    let applied = 0;
    const flaky = async (rows: Row[], adapter: StorageAdapter): Promise<void> => {
      if (applied >= 6) throw new Error('simulated kill');
      await backfill(rows, adapter);
      applied += rows.length;
    };
    await expect(
      applyChunkedMigration(db.adapter, {
        id: `pg-resumable-${runId}`,
        table,
        apply: flaky,
        batchSize: 3,
      }),
    ).rejects.toThrow('simulated kill');

    const mid = await getMigrationCheckpoint(db.adapter, `pg-resumable-${runId}`);
    expect(mid?.processed).toBe(6);

    const res = await resumeMigration(db.adapter, {
      id: `pg-resumable-${runId}`,
      table,
      apply: backfill,
      batchSize: 3,
    });
    expect(res.status).toBe('complete');

    const unflagged = await allAsyncOrSync(
      db.adapter,
      `SELECT id FROM "${table}" WHERE flag IS NULL`,
    );
    expect(unflagged).toHaveLength(0);
  });
});
