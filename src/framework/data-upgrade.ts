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
import { allAsyncOrSync, addColumnAsyncOrSync } from '../db/adapter.js';

const DELETED_AT_SENTINEL = 'internal:upgrade:deleted-at-empty-to-null:v1';
const FILES_PATH_SENTINEL = 'internal:upgrade:files-path-to-local-ref:v1';

/**
 * Run every silent open-time data upgrade. Idempotent + no-op on a 4.0-native DB.
 *
 * FAIL-SAFE BY CLASS: each step is best-effort — a failure is logged and skipped,
 * NEVER fatal to the workspace open. A 3.x-origin cloud schema can drift from what
 * 4.x declares (a `deleted_at` that is `timestamptz` not `text`; a `files` table
 * missing the 4.x reference columns; etc.), and an open-time migration that doesn't
 * hold against that drift must converge or retry on a later open — it must not brick
 * the open. Each step's `db.migrate` sentinel is only stamped on success, so a skipped
 * step re-runs next open (and the once-it-holds case self-heals).
 */
export async function upgradeLegacyData(db: Lattice): Promise<void> {
  await runUpgradeStep('ensure deleted_at column', () => ensureDeletedAtColumn(db));
  await runUpgradeStep('deleted_at normalization', () => normalizeEmptyDeletedAt(db));
  await runUpgradeStep('files path backfill', () => backfillFilesPath(db));
}

/** Best-effort runner for one open-time data-upgrade step (see {@link upgradeLegacyData}). */
async function runUpgradeStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[lattice] open-time data upgrade step "${name}" skipped (will retry on next open): ${msg}`,
    );
  }
}

/**
 * Every user table (excludes the `__lattice_*` bookkeeping tables and SQLite's
 * internal `sqlite_*` tables). Dialect-aware introspection.
 */
async function allUserTables(db: Lattice): Promise<string[]> {
  const rows =
    db.getDialect() === 'postgres'
      ? ((await allAsyncOrSync(
          db.adapter,
          `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
        )) as { name: string }[])
      : ((await allAsyncOrSync(
          db.adapter,
          `SELECT name FROM sqlite_master WHERE type = 'table'`,
        )) as { name: string }[]);
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith('__lattice') && !n.startsWith('sqlite_'));
}

/**
 * Every queryable user table MUST carry a `deleted_at` column — it's what gives a
 * table reversible (soft) delete, merge, and undo. A table created by an older or
 * non-standard path (an import, a hand-written migration) without the soft-delete
 * envelope made merge/delete refuse ("no deleted_at column to reversibly remove").
 * Backfill the standard nullable `TEXT deleted_at` on any user table missing it so
 * the envelope is universal: NULL = live, a timestamp = deleted, so every existing
 * (live) row keeps reading correctly with zero data change.
 *
 * Self-idempotent WITHOUT a sentinel: we introspect the CURRENT schema each open
 * and only ALTER tables that presently lack the column, so a re-open finds nothing
 * to do (SQLite's ADD COLUMN is not idempotent, so the pre-check is load-bearing).
 * Per-table fault isolation: one table that can't be altered (a lock, an exotic
 * constraint) is warned and skipped, never fatal to the open — the next open
 * retries it. This mirrors the files-path backfill's add-missing-columns pattern.
 */
async function ensureDeletedAtColumn(db: Lattice): Promise<void> {
  const have = new Set(await tablesWithDeletedAt(db));
  const missing = (await allUserTables(db)).filter((t) => !have.has(t));
  for (const table of missing) {
    try {
      await addColumnAsyncOrSync(db.adapter, table, 'deleted_at', 'TEXT');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[lattice] could not add deleted_at to "${table}" (will retry next open): ${msg}`,
      );
    }
  }
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
        // TYPE-AWARE: only a text-like deleted_at column can hold the legacy ''
        // sentinel. A column that is a real `timestamptz` (some clouds' deleted_at
        // is) MUST be skipped: the predicate `deleted_at = ''` forces Postgres to
        // parse `''::timestamptz` at PLAN time — invalid input that throws regardless
        // of data (a timestamptz column can't even hold ''), which aborted the entire
        // workspace open. We BLACKLIST the non-text types (timestamp/date/time,
        // numeric, boolean, json, uuid, bytea, xml) rather than allow-list text — so
        // text-like columns we don't enumerate (citext, a DOMAIN over text, a custom
        // text type) are still normalized instead of silently leaving '' rows that
        // 4.x's `deleted_at IS NULL` predicate would read as DELETED. PER-TABLE FAULT
        // ISOLATION is the backstop: each table's UPDATE runs in its own
        // subtransaction, so an exotic type that still errors on `= ''` (enum, inet,
        // interval, array) — or a blocking trigger/lock — is warned + skipped, never
        // fatal to the open.
        sql: `DO $LATTICE_DAU$
  DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name = 'deleted_at'
       AND data_type NOT IN (
         'timestamp with time zone', 'timestamp without time zone',
         'date', 'time with time zone', 'time without time zone',
         'integer', 'bigint', 'smallint', 'numeric', 'decimal',
         'real', 'double precision', 'boolean', 'json', 'jsonb',
         'bytea', 'uuid', 'xml'
       )
  LOOP
    BEGIN
      EXECUTE format('UPDATE %I SET deleted_at = NULL WHERE deleted_at = ''''', r.table_name);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'lattice: skipped deleted_at normalization for %: %', r.table_name, SQLERRM;
    END;
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

/** The column names physically present on the `files` table (empty set if none). */
async function filesColumns(db: Lattice): Promise<Set<string>> {
  const sql =
    db.getDialect() === 'postgres'
      ? `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'files'`
      : `SELECT name FROM pragma_table_info('files')`;
  const rows = (await allAsyncOrSync(db.adapter, sql)) as { name: string }[];
  return new Set(rows.map((r) => r.name));
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
  const cols = await filesColumns(db);
  if (!cols.has('path')) return; // 4.0-native files table — no legacy `path`, nothing to do
  // SELF-SUFFICIENT: ensure the 4.x reference columns exist before the backfill. On a
  // cloud open the schema reconcile that adds them is BACKGROUNDED, so this synchronous
  // backfill would otherwise hit `column "ref_kind" does not exist` and (pre-4.3.8)
  // abort the whole open. Add only the columns actually MISSING — SQLite's ADD COLUMN
  // is not idempotent (it throws "duplicate column" on a re-open, since the legacy
  // `path` keeps the gate above true). All four are TEXT per native-entities.ts,
  // matching the reconcile so there is no type drift.
  for (const col of ['ref_kind', 'ref_uri', 'ref_provider', 'blob_path']) {
    if (!cols.has(col)) await addColumnAsyncOrSync(db.adapter, 'files', col, 'TEXT');
  }
  await db.migrate([
    {
      version: FILES_PATH_SENTINEL,
      sql: `UPDATE files
               SET ref_kind = 'local_ref', ref_uri = path, ref_provider = 'fs'
             WHERE path IS NOT NULL AND path <> '' AND ref_kind IS NULL AND blob_path IS NULL;`,
    },
  ]);
}
