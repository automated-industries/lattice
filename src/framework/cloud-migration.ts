import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { Lattice } from '../lattice.js';
import { parseConfigFile } from '../config/parser.js';
import { registerNativeEntities } from './native-entities.js';
import { emitAnalytics } from './analytics.js';

/**
 * Cloud migration — copy a Lattice's data from one backing store to
 * another. Used by the GUI's "Migrate to cloud" flow, but exported as
 * a public API so library consumers can drive the same upgrade
 * (local SQLite → BYO Postgres) from their own code without the GUI.
 *
 * The caller owns both Lattice instances. `migrateLatticeData` reads
 * from `source`, writes to `target`, and returns counts. Filesystem
 * concerns (renaming the source SQLite file, rewriting the YAML
 * `db:` line) are the caller's responsibility — see
 * {@link archiveLocalSqlite} for the rename helper.
 */

export interface MigrationProgress {
  table: string;
  rowsCopied: number;
  rowsTotal: number;
}

export interface MigrationResult {
  tablesCopied: string[];
  rowsCopied: number;
}

export interface MigrationOptions {
  /** Rows copied per upsert batch. Default 500. */
  batchSize?: number;
  onProgress?: (progress: MigrationProgress) => void;
}

/**
 * Tables that are never copied. Per-DB GUI state and system tables
 * are recreated fresh on the target — copying them would carry over
 * audit logs, icon overrides, and team identity from a wrong context.
 *
 * `__lattice_user_identity` is auto-mirrored from
 * `~/.lattice/identity.json` on every Lattice open, so it doesn't
 * need to migrate.
 */
function isMigratable(tableName: string): boolean {
  if (tableName.startsWith('_lattice_gui_')) return false;
  if (tableName.startsWith('__lattice_')) return false;
  return true;
}

/**
 * Copy every migratable table (user-defined entities + native
 * `secrets` / `files`) from `source` into `target`. Both Lattices
 * must be initialized and must have the same schema registered for
 * the tables being copied (the GUI server's `openConfig` flow + a
 * matching target Lattice satisfies this).
 *
 * Throws if the target has existing data in any of the migratable
 * tables — migration is into a fresh DB only. This is checked once
 * up front so a partial migration doesn't silently extend a populated
 * target.
 *
 * Encrypted columns (`secrets.value`, etc.) round-trip through
 * decrypt-on-read + encrypt-on-write. Both Lattices must therefore
 * share an `encryptionKey` — typically both come from the same
 * `~/.lattice/master.key` on the operator's machine. If the keys
 * differ, encrypted values land on the target as plaintext-of-the-
 * source-ciphertext (i.e. unreadable). Callers are expected to thread
 * the same key through to both sides.
 */
export async function migrateLatticeData(
  source: Lattice,
  target: Lattice,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  emitAnalytics('migrateLatticeData');
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const onProgress = options.onProgress;

  const sourceTables = source.getRegisteredTableNames().filter(isMigratable);

  // Up-front: refuse if any of the migratable tables on the target
  // already has rows. Migration is one-shot and into-empty.
  for (const table of sourceTables) {
    const existing = await target.query(table, { limit: 1 });
    if (existing.length > 0) {
      throw new Error(
        `Target Lattice is not empty: table "${table}" already has rows. Migration aborts to avoid mixing data.`,
      );
    }
  }

  const result: MigrationResult = { tablesCopied: [], rowsCopied: 0 };

  for (const table of sourceTables) {
    const rows = await source.query(table, {});
    if (rows.length === 0) {
      result.tablesCopied.push(table);
      if (onProgress) onProgress({ table, rowsCopied: 0, rowsTotal: 0 });
      continue;
    }

    let copied = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      for (const row of batch) {
        await target.upsert(table, row);
      }
      copied += batch.length;
      if (onProgress) onProgress({ table, rowsCopied: copied, rowsTotal: rows.length });
    }

    result.tablesCopied.push(table);
    result.rowsCopied += rows.length;
  }

  return result;
}

/**
 * Open a fresh target Lattice against `targetUrl` with the same user
 * schema + native entities as the GUI server would set up for the
 * project at `configPath`. Used by `migrateLatticeData` callers who
 * need a target Lattice to point at; library consumers can call this
 * to construct the destination before invoking the migration.
 *
 * The returned Lattice has:
 *   - all user entities + entity contexts from the YAML config
 *   - native `secrets` + `files` (registered via registerNativeEntities)
 *   - has been `await db.init()`'d and is ready to upsert against
 *
 * `_lattice_gui_*` meta tables + `__lattice_user_identity` are NOT
 * registered here — they're GUI-server concerns and will be set up
 * the next time the GUI opens the target as the active project.
 *
 * Caller owns the lifecycle: must `await db.close()` when done.
 */
export async function openTargetLatticeForMigration(
  configPath: string,
  targetUrl: string,
  encryptionKey: string,
): Promise<Lattice> {
  emitAnalytics('openTargetLatticeForMigration');
  const parsed = parseConfigFile(configPath);
  const target = new Lattice(targetUrl, { encryptionKey });
  for (const { name, definition } of parsed.tables) {
    target.define(name, definition);
  }
  for (const { table, definition } of parsed.entityContexts) {
    target.defineEntityContext(table, definition);
  }
  registerNativeEntities(target);
  await target.init();
  return target;
}

/**
 * Rename a SQLite database file (and its `-shm` / `-wal` siblings)
 * to `<path>.local-bak`. Idempotent: if a stale `.local-bak` already
 * exists, it's removed first so a failed retry leaves no orphans.
 *
 * Returns the backup path. Throws only if the source file is missing
 * or the rename itself fails (filesystem permission errors). Blob
 * directories under `data/blobs/<sha256>/` are NOT touched — they
 * stay in place and remain reachable via the active Lattice's
 * `files.blob_path` references.
 */
export function archiveLocalSqlite(dbPath: string): string {
  emitAnalytics('archiveLocalSqlite');
  if (!existsSync(dbPath)) {
    throw new Error(`archiveLocalSqlite: source file does not exist: ${dbPath}`);
  }
  const backupPath = `${dbPath}.local-bak`;
  const siblings = ['', '-shm', '-wal'] as const;

  // Clear any stale backups first.
  for (const suffix of siblings) {
    const stale = `${dbPath}.local-bak${suffix}`;
    if (existsSync(stale)) {
      try {
        unlinkSync(stale);
      } catch {
        // best-effort
      }
    }
  }

  for (const suffix of siblings) {
    const src = `${dbPath}${suffix}`;
    if (!existsSync(src)) continue;
    const dest = `${dbPath}.local-bak${suffix}`;
    renameSync(src, dest);
  }

  return backupPath;
}
