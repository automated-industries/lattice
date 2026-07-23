import { createHash } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { assertSafeIdentifier } from '../schema/identifier.js';
import type { Row } from '../types.js';

/**
 * Rows are loaded in transactions of this many at a time. Each chunk commits
 * atomically; the event loop is yielded BETWEEN chunks (never inside an open
 * transaction, so a concurrent writer is never captured on the shared SQLite
 * connection). Sized to keep one commit small enough to stay off the WAL /
 * undo-log memory cliff while amortizing the per-commit cost over thousands of
 * rows.
 */
export const LOAD_CHUNK_ROWS = 2000;

/** Yield to the macrotask queue so pending I/O (the request socket) is serviced. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Index name for a seed natural-key column. Postgres truncates identifiers to
 * 63 bytes, so a long `idx_<table>_<col>` could silently collapse two distinct
 * indexes onto the same name; bound it with a short hash suffix when it would
 * overflow (mirrors the cloud trigger-name bounding in cloud/rls.ts).
 */
export function seedIndexName(table: string, col: string): string {
  const raw = `idx_${table}_${col}`;
  return Buffer.byteLength(raw, 'utf8') <= 63
    ? raw
    : raw.slice(0, 56) + '_' + createHash('sha1').update(raw).digest('hex').slice(0, 6);
}

/**
 * Ensure an index exists on the natural-key column a bulk seed dedups against.
 *
 * Without it, every per-row `upsertByNaturalKey` existence check
 * (`SELECT id ... WHERE <naturalKey> = ?`) does a full table scan of the
 * growing table — O(N²) over the load, which pegs the CPU and makes a
 * 10^5-row sheet effectively un-importable (the "Created table … / Load failed"
 * mid-load abort). With the index the check is O(log N). Idempotent
 * (`IF NOT EXISTS`) and dialect-neutral (SQLite + Postgres).
 */
export async function ensureNaturalKeyIndex(
  db: Lattice,
  table: string,
  col: string,
): Promise<void> {
  assertSafeIdentifier(table, 'table');
  assertSafeIdentifier(col, 'column');
  const idx = seedIndexName(table, col);
  await runAsyncOrSync(db.adapter, `CREATE INDEX IF NOT EXISTS "${idx}" ON "${table}" ("${col}")`);
}

export interface ChunkedSeedOptions {
  table: string;
  naturalKey: string;
  rows: Row[];
  /**
   * Called between chunks with (loaded, total) so a streaming caller can report
   * progress. Awaited — on the NDJSON route this both emits and flushes the
   * socket. The load also yields on its own between chunks, so progress is
   * optional (the silent/auto path passes none and still stays responsive).
   */
  onProgress?: (loaded: number, total: number) => void | Promise<void>;
  /**
   * Caller intent that a mid-load failure should hard-clear the table (so a
   * failed import never leaves a silently truncated table). This is only an
   * INTENT: the clear also requires the table to be provably empty at the start
   * of the load (see {@link isPhysicallyEmpty}). Registry membership alone does
   * NOT prove emptiness — a table can exist with committed rows yet be absent
   * from this session's schema registry (a re-import after a soft-delete/
   * unregister, or config↔DB drift) — and clearing that would destroy
   * pre-existing data. The empty-check makes cleanup safe regardless of what the
   * caller passes.
   */
  cleanupOnFailure?: boolean;
}

/**
 * True when the physical table holds no rows at all (ignoring `deleted_at`, so
 * soft-deleted-but-still-present rows count as non-empty). Used to prove a table
 * is safe to hard-clear on a failed load: we only ever clear a table this load
 * found empty, so a mid-load failure can never destroy pre-existing committed
 * rows.
 */
async function isPhysicallyEmpty(db: Lattice, table: string): Promise<boolean> {
  assertSafeIdentifier(table, 'table');
  const rows = await allAsyncOrSync(db.adapter, `SELECT 1 FROM "${table}" LIMIT 1`);
  return rows.length === 0;
}

/**
 * Load rows into a freshly-created import table in bounded, atomic chunks.
 *
 * Each chunk is one `db.transaction(...)`: its rows commit together (a torn
 * chunk rolls back), and batching the commit is what turns a 145K-row load from
 * "145K autocommits" into ~73 commits. Between chunks — with NO transaction open,
 * so a concurrent writer on the shared connection is never captured — we yield to
 * the event loop and report progress, keeping the app and the request socket
 * responsive during a large import.
 *
 * On any error the whole table is cleared (when `cleanupOnFailure`) and an
 * actionable error — table + how far the load got + the underlying cause — is
 * thrown, instead of the bare, undiagnosable failure the raw path surfaced.
 *
 * Rows still go through `db.seed` → `upsertByNaturalKey`, so intra-file dedup by
 * natural key and all row conventions (org/ownership stamping, `deleted_at`,
 * encryption) are preserved — including the cloud RLS ownership trigger, which
 * fires inside each chunk's transaction exactly as on the single-row path.
 */
export async function seedInChunks(db: Lattice, opts: ChunkedSeedOptions): Promise<void> {
  const { table, naturalKey, rows, onProgress, cleanupOnFailure } = opts;
  const total = rows.length;
  // Decide up front — while the table is still in its pre-load state — whether a
  // failed load may hard-clear it. We only ever clear a table that was PROVABLY
  // empty when the load began, so a mid-load failure can never destroy
  // pre-existing committed rows (a re-import, or a populated-but-unregistered
  // table). The caller's `cleanupOnFailure` is intent; the empty-check is the
  // safety gate.
  const mayClearOnFailure = cleanupOnFailure === true && (await isPhysicallyEmpty(db, table));
  let loaded = 0;
  try {
    for (let i = 0; i < total; i += LOAD_CHUNK_ROWS) {
      const slice = rows.slice(i, i + LOAD_CHUNK_ROWS);
      await db.transaction(async () => {
        await db.seed({ data: slice, table, naturalKey });
      });
      loaded += slice.length;
      if (onProgress) await onProgress(loaded, total);
      await yieldToEventLoop();
    }
  } catch (err) {
    if (mayClearOnFailure) {
      try {
        await runAsyncOrSync(db.adapter, `DELETE FROM "${table}"`);
      } catch {
        // Best-effort cleanup — surface the ORIGINAL load error below, not this.
      }
    }
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed loading rows into "${table}" after ${String(loaded)}/${String(total)}: ${cause}`,
    );
  }
}
