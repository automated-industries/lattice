import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { importDataFaithfully } from '../../src/gui/import-auto.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { seedIndexName, seedInChunks, LOAD_CHUNK_ROWS } from '../../src/import/bulk-load.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

async function freshWorkspace(): Promise<{ db: Lattice; configPath: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-large-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Large' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  dbs.push(db);
  return { db, configPath: resolveWorkspacePaths(root, ws).configPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression for the "Created table … / Load failed" mid-load abort on a large
// worksheet. Root cause: the per-row upsert existence check ran against an
// UNINDEXED natural-key column, so every insert full-scanned the growing table
// (O(N²)), pegging the CPU until the browser fetch died mid-load and left a
// partially-populated table. The fix indexes the natural key and loads in
// bounded, atomic chunks that yield the event loop.
// ─────────────────────────────────────────────────────────────────────────────
describe('large single-sheet import', () => {
  it('loads every row of a multi-chunk sheet and indexes the natural key', async () => {
    const { db, configPath } = await freshWorkspace();
    // > 2 × LOAD_CHUNK_ROWS so the chunked loader runs at least three commits
    // (the last one partial) and the between-chunk yield fires.
    const N = LOAD_CHUNK_ROWS * 2 + 500;
    const rows = Array.from({ length: N }, (_, i) => ({
      ref: `R-${String(i).padStart(7, '0')}`,
      label: `Row ${String(i)}`,
      amount: i % 500,
    }));

    const result = await importDataFaithfully(db, configPath, { ledger: rows });
    expect(result).not.toBeNull();
    const table = result!.tables[0];

    // Every row landed — no silent mid-load truncation.
    expect(await db.count(table)).toBe(N);
    expect(result!.rows).toBe(N);

    // The natural-key index exists — this is the O(N²)-killer, and asserting it
    // fails loudly if a future change drops the index creation.
    const idx = (await allAsyncOrSync(
      db.adapter,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      [table],
    )) as { name: string }[];
    expect(idx.some((r) => r.name.startsWith(`idx_${table}_`))).toBe(true);
  });

  it('re-importing the same large sheet is idempotent (dedup by natural key holds at scale)', async () => {
    const { db, configPath } = await freshWorkspace();
    const N = LOAD_CHUNK_ROWS + 100; // spans a chunk boundary
    const rows = Array.from({ length: N }, (_, i) => ({
      ref: `R-${String(i).padStart(7, '0')}`,
      label: `Row ${String(i)}`,
    }));

    const first = await importDataFaithfully(db, configPath, { ledger: rows });
    const table = first!.tables[0];
    expect(await db.count(table)).toBe(N);

    // Same data again → upsert-by-natural-key across chunks must not duplicate.
    await importDataFaithfully(db, configPath, { ledger: rows });
    expect(await db.count(table)).toBe(N);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for the loader primitives, against a fake Lattice so a failing
// chunk is deterministic (a real constraint failure at scale is hard to force).
// ─────────────────────────────────────────────────────────────────────────────
describe('seedIndexName', () => {
  it('uses a plain name under the 63-byte identifier limit', () => {
    expect(seedIndexName('ledger', 'content_key')).toBe('idx_ledger_content_key');
  });

  it('hash-bounds a name over 63 bytes so Postgres cannot collide two indexes', () => {
    const longTable = 'a'.repeat(60);
    const name = seedIndexName(longTable, 'content_key');
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
    // idx_ + 52 a's (slice to 56) + _ + 6 hex = 63 bytes
    expect(name).toMatch(/^idx_a{52}_[0-9a-f]{6}$/);
  });
});

describe('seedInChunks', () => {
  function fakeDb(
    seedImpl: (arg: { data: unknown[] }) => Promise<unknown>,
    physicallyEmpty = true,
  ) {
    const deletes: string[] = [];
    const db = {
      transaction: <T>(fn: () => Promise<T>) => fn(),
      seed: seedImpl,
      adapter: {
        runAsync: async (sql: string) => {
          deletes.push(sql);
        },
        // Backs isPhysicallyEmpty's `SELECT 1 FROM "t" LIMIT 1`.
        allAsync: async () => (physicallyEmpty ? [] : [{ one: 1 }]),
      },
    } as unknown as Lattice;
    return { db, deletes };
  }

  it('loads every chunk and reports progress on success', async () => {
    const seeded: number[] = [];
    const { db } = fakeDb(async ({ data }) => {
      seeded.push(data.length);
      return {};
    });
    const N = LOAD_CHUNK_ROWS * 2 + 500;
    const rows = Array.from({ length: N }, (_, i) => ({ k: String(i) }));
    const progress: [number, number][] = [];

    await seedInChunks(db, {
      table: 't',
      naturalKey: 'k',
      rows,
      onProgress: (loaded, total) => {
        progress.push([loaded, total]);
      },
    });

    expect(seeded).toEqual([LOAD_CHUNK_ROWS, LOAD_CHUNK_ROWS, 500]);
    expect(progress).toEqual([
      [LOAD_CHUNK_ROWS, N],
      [LOAD_CHUNK_ROWS * 2, N],
      [N, N],
    ]);
  });

  it('throws an actionable error and clears the table on a mid-load failure', async () => {
    let calls = 0;
    const { db, deletes } = fakeDb(async () => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return {};
    });
    const rows = Array.from({ length: LOAD_CHUNK_ROWS + 1000 }, (_, i) => ({ k: String(i) }));

    await expect(
      seedInChunks(db, { table: 'ledger', naturalKey: 'k', rows, cleanupOnFailure: true }),
    ).rejects.toThrow(
      new RegExp(
        `Failed loading rows into "ledger" after ${LOAD_CHUNK_ROWS}/${rows.length}: disk full`,
      ),
    );
    // Never leave a silently-truncated table — the created table is cleared.
    expect(deletes).toContain('DELETE FROM "ledger"');
  });

  it('does NOT clear a pre-existing table when cleanupOnFailure is false', async () => {
    const { db, deletes } = fakeDb(async () => {
      throw new Error('boom');
    });
    await expect(
      seedInChunks(db, {
        table: 'ledger',
        naturalKey: 'k',
        rows: [{ k: '1' }],
        cleanupOnFailure: false,
      }),
    ).rejects.toThrow(/Failed loading rows into "ledger" after 0\/1: boom/);
    expect(deletes).toEqual([]);
  });

  it('does NOT clear on failure when the table already holds rows, even if cleanupOnFailure is true', async () => {
    // Guards the data-loss path an adversarial review surfaced: a table can be
    // absent from this session's registry yet physically hold committed rows (a
    // re-import after a soft-delete/unregister, or config↔DB drift). The
    // physical-emptiness gate means a mid-load failure never wipes that table.
    const { db, deletes } = fakeDb(async () => {
      throw new Error('boom');
    }, /* physicallyEmpty */ false);
    await expect(
      seedInChunks(db, {
        table: 'ledger',
        naturalKey: 'k',
        rows: [{ k: '1' }],
        cleanupOnFailure: true,
      }),
    ).rejects.toThrow(/Failed loading rows into "ledger" after 0\/1: boom/);
    expect(deletes).toEqual([]); // pre-existing rows preserved — no DELETE FROM
  });
});
