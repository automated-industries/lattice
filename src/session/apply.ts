import type Database from 'better-sqlite3';
import type { SessionWriteEntry } from './parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApplyWriteResult =
  | { ok: true; table: string; recordId: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const TABLE_NAME_RE = /^[a-zA-Z0-9_]+$/;
const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a SESSION.md write entry to a better-sqlite3 database.
 *
 * Validates:
 * - Table and field names match `[a-zA-Z0-9_]` (SQL injection prevention)
 * - Table exists in `sqlite_master`
 * - All field names are present in the table schema (`PRAGMA table_info`)
 * - `target` is provided for `update` and `delete` ops
 *
 * For `delete`: uses a soft-delete (`deleted_at = datetime('now')`) if the
 * column exists, otherwise performs a hard `DELETE`.
 *
 * Returns `{ ok: true, table, recordId }` on success, or
 * `{ ok: false, reason }` if validation or the DB operation fails.
 * The caller is responsible for logging and audit events.
 */
export function applyWriteEntry(
  db: Database.Database,
  entry: SessionWriteEntry,
): ApplyWriteResult {
  const { op, table, target, fields } = entry;

  // Validate table name format
  if (!TABLE_NAME_RE.test(table)) {
    return { ok: false, reason: `Invalid table name: "${table}". Only [a-zA-Z0-9_] allowed` };
  }

  // Validate table exists
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  if (!tableExists) {
    return { ok: false, reason: `Unknown table: "${table}"` };
  }

  // Load schema columns
  const columnRows = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as Array<{ name: string }>;
  const knownColumns = new Set(columnRows.map(r => r.name));

  // Validate all field names against schema
  for (const fieldName of Object.keys(fields)) {
    if (!FIELD_NAME_RE.test(fieldName)) {
      return { ok: false, reason: `Invalid field name: "${fieldName}". Only [a-zA-Z0-9_] allowed` };
    }
    if (!knownColumns.has(fieldName)) {
      return { ok: false, reason: `Unknown field "${fieldName}" in table "${table}"` };
    }
  }

  try {
    let recordId: string;

    if (op === 'create') {
      const id = (fields['id'] as string | undefined) ?? crypto.randomUUID();
      const allFields = { ...fields, id };
      const cols = Object.keys(allFields).map(c => `"${c}"`).join(', ');
      const placeholders = Object.keys(allFields).map(() => '?').join(', ');
      db
        .prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`)
        .run(...Object.values(allFields));
      recordId = id;
    } else if (op === 'update') {
      if (!target) {
        return { ok: false, reason: 'Field "target" is required for op "update"' };
      }
      const pkCol = columnRows.find(r => r.name === 'id') ? 'id' : (columnRows[0]?.name ?? 'id');
      const setCols = Object.keys(fields)
        .map(c => `"${c}" = ?`)
        .join(', ');
      db
        .prepare(`UPDATE "${table}" SET ${setCols} WHERE "${pkCol}" = ?`)
        .run(...Object.values(fields), target);
      recordId = target;
    } else {
      // delete
      if (!target) {
        return { ok: false, reason: 'Field "target" is required for op "delete"' };
      }
      const pkCol = columnRows.find(r => r.name === 'id') ? 'id' : (columnRows[0]?.name ?? 'id');
      if (knownColumns.has('deleted_at')) {
        db
          .prepare(`UPDATE "${table}" SET deleted_at = datetime('now') WHERE "${pkCol}" = ?`)
          .run(target);
      } else {
        db.prepare(`DELETE FROM "${table}" WHERE "${pkCol}" = ?`).run(target);
      }
      recordId = target;
    }

    return { ok: true, table, recordId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `DB error: ${message}` };
  }
}
