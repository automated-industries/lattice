// ---------------------------------------------------------------------------
// Silent on-open DATA migrations.
//
// Companion to config/config-upgrade.ts (which migrates config SHAPE): these bring
// a 3.x DB's existing ROWS to the 4.0 shape so they keep behaving correctly. Each
// is gated once-per-DB through db.migrate's `__lattice_migrations` ledger (an
// `internal:upgrade:*` sentinel) — the UPDATE + the sentinel commit in one
// transaction, so there is no half-applied / silently-corrupt state. A DB made by 4.0
// has nothing to migrate and these are no-ops.
//
// Owner / local opens only — a cloud MEMBER lacks the grants to ALTER/UPDATE the
// shared schema; the caller skips these on a member open.
// ---------------------------------------------------------------------------
import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';

const DELETED_AT_SENTINEL = 'internal:upgrade:deleted-at-empty-to-null:v1';
const FILES_PATH_SENTINEL = 'internal:upgrade:files-path-to-local-ref:v1';

/** Run every silent data upgrade in order. Idempotent + no-op on a 4.0-native DB. */
export async function upgradeLegacyData(db: Lattice): Promise<void> {
  await normalizeEmptyDeletedAt(db);
  await backfillFilesPath(db);
}

/** Tables carrying a `deleted_at` column (dialect-aware introspection). */
async function tablesWithDeletedAt(db: Lattice): Promise<string[]> {
  if (db.getDialect() === 'postgres') {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'deleted_at'`,
    )) as { name: string }[];
    return rows.map((r) => r.name);
  }
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT m.name AS name FROM sqlite_master m
       JOIN pragma_table_info(m.name) c ON c.name = 'deleted_at'
      WHERE m.type = 'table'`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * 3.x treated `deleted_at = ''` as "live"; 4.0's live predicate is `deleted_at IS
 * NULL` only — so a legacy `''` row would read as DELETED (and a natural-key upsert
 * against the now-hidden row could insert a duplicate). Normalize every `''` to
 * NULL across every table that has the column, ONCE. Stamps the sentinel even when
 * there is nothing to do, so a clean DB doesn't re-introspect on every open.
 */
async function normalizeEmptyDeletedAt(db: Lattice): Promise<void> {
  if (db.getDialect() === 'postgres') {
    // CRITICAL on a remote (pooled) cloud: do the WHOLE normalization in a single
    // server-side DO block so it costs ONE migration transaction, not one per table.
    // A per-table loop here means N pooler round-trips/transactions (a cloud with
    // ~100+ tables stalled the workspace switch). The DO block loops the deleted_at
    // tables and updates each in-database; one sentinel gates it once-per-DB.
    await db.migrate([
      {
        version: `${DELETED_AT_SENTINEL}:all`,
        sql: `DO $LATTICE_DAU$
  DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'deleted_at'
  LOOP
    EXECUTE format('UPDATE %I SET deleted_at = NULL WHERE deleted_at = ''''', r.table_name);
  END LOOP;
END $LATTICE_DAU$;`,
      },
    ]);
    return;
  }
  // SQLite is local (no network/pooler cost) and its adapter rejects multi-statement
  // migration SQL, so emit one single-statement migration per table and apply them
  // in ONE pass (a single applyMigrations transaction). The UPDATE is idempotent.
  const migrations = (await tablesWithDeletedAt(db)).map((t) => {
    const q = t.replace(/"/g, '""');
    return {
      version: `${DELETED_AT_SENTINEL}:${t}`,
      sql: `UPDATE "${q}" SET deleted_at = NULL WHERE deleted_at = '';`,
    };
  });
  if (migrations.length > 0) await db.migrate(migrations);
}

/** Does the `files` table physically carry the legacy `path` column (3.x shape)? */
async function filesTableHasPath(db: Lattice): Promise<boolean> {
  if (db.getDialect() === 'postgres') {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT 1 AS x FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'files' AND column_name = 'path'`,
    )) as unknown[];
    return rows.length > 0;
  }
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT 1 AS x FROM pragma_table_info('files') WHERE name = 'path'`,
  )) as unknown[];
  return rows.length > 0;
}

/**
 * 4.0 dropped the native `files.path` / `files.kind` columns; file resolution now
 * flows through the reference model (`ref_kind` / `ref_uri`). A legacy row whose
 * ONLY on-disk pointer was `path` (no `ref_kind`, no `blob_path`) no longer
 * resolves. Backfill those into the reference model as a `local_ref` so their bytes
 * stay resolvable — exactly the migration documented in MIGRATING-4.0.md. The
 * legacy columns are left in place (dropping them is destructive + optional).
 *
 * Only runs when the `files` table still HAS a `path` column — on a 4.0-native DB
 * there is no such column and there is nothing to do.
 */
async function backfillFilesPath(db: Lattice): Promise<void> {
  if (!(await filesTableHasPath(db))) return;
  await db.migrate([
    {
      version: FILES_PATH_SENTINEL,
      sql: `UPDATE files
               SET ref_kind = 'local_ref', ref_uri = path, ref_provider = 'fs'
             WHERE path IS NOT NULL AND path <> '' AND ref_kind IS NULL AND blob_path IS NULL;`,
    },
  ]);
}
