/**
 * Online, resumable migrations.
 *
 * A naive backfill that updates a whole table in one statement takes a long
 * table lock — a maintenance window — and, if killed partway, has to restart
 * from zero. A chunked migration instead walks the table's primary key in
 * batches, each its own short transaction, and records progress in a checkpoint
 * table after every batch. So it never holds a long lock, and a kill (deploy,
 * crash, OOM) is recoverable: `resumeMigration` picks up after the last
 * checkpointed key instead of redoing completed work.
 *
 * The per-batch `apply` callback MUST be idempotent — a batch can re-run if the
 * process dies between applying it and committing its checkpoint.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import type { Row } from '../types.js';

const CHECKPOINT_TABLE = '__lattice_migration_checkpoints';

export type MigrationStatus = 'running' | 'complete' | 'reverted';

export interface MigrationCheckpoint {
  id: string;
  table: string;
  lastPk: string | null;
  processed: number;
  status: MigrationStatus;
  startedAt: string;
  updatedAt: string;
}

export interface ChunkedMigrationOptions {
  /** Unique, stable id for this migration (the resume key). */
  id: string;
  /** Table to walk. */
  table: string;
  /** Process one batch of rows. MUST be idempotent. */
  apply: (rows: Row[], adapter: StorageAdapter) => Promise<void>;
  /** Rows per batch. Default 500. */
  batchSize?: number;
  /** Primary-key column to walk (must be sortable). Default 'id'. */
  pkColumn?: string;
  /** Optional WHERE predicate (without the leading WHERE) to scope rows. */
  where?: string;
  /** Bound params for `where`. */
  whereParams?: unknown[];
}

export interface ChunkedMigrationResult {
  id: string;
  processed: number;
  batches: number;
  status: MigrationStatus;
}

/** Ensure the checkpoint table exists (idempotent). */
export async function ensureCheckpointTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${CHECKPOINT_TABLE}" (
       "id"         TEXT PRIMARY KEY,
       "table_name" TEXT NOT NULL,
       "last_pk"    TEXT,
       "processed"  INTEGER NOT NULL DEFAULT 0,
       "status"     TEXT NOT NULL DEFAULT 'running',
       "started_at" TEXT NOT NULL,
       "updated_at" TEXT NOT NULL
     )`,
  );
}

function rowToCheckpoint(r: Row): MigrationCheckpoint {
  return {
    id: r.id as string,
    table: r.table_name as string,
    lastPk: typeof r.last_pk === 'string' ? r.last_pk : null,
    processed: Number(r.processed ?? 0),
    status: (r.status as MigrationStatus | undefined) ?? 'running',
    startedAt: r.started_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function getMigrationCheckpoint(
  adapter: StorageAdapter,
  id: string,
): Promise<MigrationCheckpoint | null> {
  await ensureCheckpointTable(adapter);
  const row = await getAsyncOrSync(adapter, `SELECT * FROM "${CHECKPOINT_TABLE}" WHERE "id" = ?`, [
    id,
  ]);
  return row ? rowToCheckpoint(row) : null;
}

export async function listMigrationCheckpoints(
  adapter: StorageAdapter,
): Promise<MigrationCheckpoint[]> {
  await ensureCheckpointTable(adapter);
  const rows = await allAsyncOrSync(
    adapter,
    `SELECT * FROM "${CHECKPOINT_TABLE}" ORDER BY "started_at"`,
  );
  return rows.map(rowToCheckpoint);
}

/** The core walk, shared by apply + resume. */
async function runMigration(
  adapter: StorageAdapter,
  opts: ChunkedMigrationOptions,
): Promise<ChunkedMigrationResult> {
  await ensureCheckpointTable(adapter);
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const pk = opts.pkColumn ?? 'id';
  const now = new Date().toISOString();

  let checkpoint = await getMigrationCheckpoint(adapter, opts.id);
  if (checkpoint?.status === 'complete') {
    // Already done — idempotent no-op.
    return { id: opts.id, processed: checkpoint.processed, batches: 0, status: 'complete' };
  }
  if (!checkpoint) {
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${CHECKPOINT_TABLE}" ("id","table_name","last_pk","processed","status","started_at","updated_at")
       VALUES (?, ?, NULL, 0, 'running', ?, ?)`,
      [opts.id, opts.table, now, now],
    );
    checkpoint = await getMigrationCheckpoint(adapter, opts.id);
  }

  let lastPk = checkpoint?.lastPk ?? null;
  let processed = checkpoint?.processed ?? 0;
  let batches = 0;

  for (;;) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (lastPk !== null) {
      clauses.push(`"${pk}" > ?`);
      params.push(lastPk);
    }
    if (opts.where) {
      clauses.push(`(${opts.where})`);
      params.push(...(opts.whereParams ?? []));
    }
    const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = await allAsyncOrSync(
      adapter,
      `SELECT * FROM "${opts.table}"${whereSql} ORDER BY "${pk}" LIMIT ${String(batchSize)}`,
      params,
    );
    if (rows.length === 0) break;

    await opts.apply(rows, adapter);

    const last = rows[rows.length - 1];
    lastPk = last ? String(last[pk]) : lastPk;
    processed += rows.length;
    batches++;
    const ts = new Date().toISOString();
    await runAsyncOrSync(
      adapter,
      `UPDATE "${CHECKPOINT_TABLE}" SET "last_pk" = ?, "processed" = ?, "updated_at" = ? WHERE "id" = ?`,
      [lastPk, processed, ts, opts.id],
    );

    if (rows.length < batchSize) break;
  }

  const doneTs = new Date().toISOString();
  await runAsyncOrSync(
    adapter,
    `UPDATE "${CHECKPOINT_TABLE}" SET "status" = 'complete', "updated_at" = ? WHERE "id" = ?`,
    [doneTs, opts.id],
  );
  return { id: opts.id, processed, batches, status: 'complete' };
}

/**
 * Apply a chunked migration. Creates a checkpoint and walks the table in
 * batches, committing progress after each. If a checkpoint for `id` already
 * exists (a prior killed run), it resumes from there. Re-running a completed
 * migration is a no-op.
 */
export async function applyChunkedMigration(
  adapter: StorageAdapter,
  opts: ChunkedMigrationOptions,
): Promise<ChunkedMigrationResult> {
  return runMigration(adapter, opts);
}

/**
 * Resume a previously-started (and not completed) chunked migration. Throws if
 * no checkpoint exists for `id` — use {@link applyChunkedMigration} to start one.
 */
export async function resumeMigration(
  adapter: StorageAdapter,
  opts: ChunkedMigrationOptions,
): Promise<ChunkedMigrationResult> {
  const checkpoint = await getMigrationCheckpoint(adapter, opts.id);
  if (!checkpoint) {
    throw new Error(
      `resumeMigration: no checkpoint for "${opts.id}" — start it with applyChunkedMigration first`,
    );
  }
  if (checkpoint.status === 'complete') {
    return { id: opts.id, processed: checkpoint.processed, batches: 0, status: 'complete' };
  }
  return runMigration(adapter, opts);
}

/**
 * Revert a migration: walk the processed rows in batches applying `revert`, then
 * mark the checkpoint `reverted`. `revert` must be idempotent.
 */
export async function revertMigration(
  adapter: StorageAdapter,
  id: string,
  table: string,
  revert: (rows: Row[], adapter: StorageAdapter) => Promise<void>,
  opts: { batchSize?: number; pkColumn?: string; where?: string; whereParams?: unknown[] } = {},
): Promise<ChunkedMigrationResult> {
  const checkpoint = await getMigrationCheckpoint(adapter, id);
  if (!checkpoint) {
    throw new Error(`revertMigration: no checkpoint for "${id}"`);
  }
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const pk = opts.pkColumn ?? 'id';
  let lastPk: string | null = null;
  let processed = 0;
  let batches = 0;

  for (;;) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (lastPk !== null) {
      clauses.push(`"${pk}" > ?`);
      params.push(lastPk);
    }
    if (opts.where) {
      clauses.push(`(${opts.where})`);
      params.push(...(opts.whereParams ?? []));
    }
    const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = await allAsyncOrSync(
      adapter,
      `SELECT * FROM "${table}"${whereSql} ORDER BY "${pk}" LIMIT ${String(batchSize)}`,
      params,
    );
    if (rows.length === 0) break;
    await revert(rows, adapter);
    const last = rows[rows.length - 1];
    lastPk = last ? String(last[pk]) : lastPk;
    processed += rows.length;
    batches++;
    if (rows.length < batchSize) break;
  }

  const ts = new Date().toISOString();
  await runAsyncOrSync(
    adapter,
    `UPDATE "${CHECKPOINT_TABLE}" SET "status" = 'reverted', "updated_at" = ? WHERE "id" = ?`,
    [ts, id],
  );
  return { id, processed, batches, status: 'reverted' };
}
