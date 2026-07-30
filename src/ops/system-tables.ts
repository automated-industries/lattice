import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { isInternalNativeEntity } from '../framework/native-entities.js';

/**
 * Browsing Lattice's OWN bookkeeping tables — a capability, not a route.
 *
 * These are the underscore-prefixed internals (`__lattice_*` migration ledger,
 * changelog, …; `_lattice_gui_*` icon overrides, audit log, column meta) plus
 * the native conversation tables, which are hidden from the object list but
 * readable here. Anyone debugging a workspace wants to see them, and "anyone"
 * includes a command-line caller and a script, not only the sidebar — so the
 * listing and the bounded read live here rather than inside the HTTP layer.
 *
 * Both dialects are handled: the table listing dispatches on the adapter's
 * dialect (`pg_tables` on Postgres, `sqlite_master` on SQLite) and column
 * enumeration delegates to `Lattice.introspectColumns`, which is already
 * dialect-portable. An earlier SQLite-only implementation made this whole
 * surface silently empty on a Postgres-backed workspace.
 */

/** One system table, as reported to a browser of the internals. */
export interface SystemTableSummary {
  name: string;
  /** Column names, or empty when this caller may not read the table's shape. */
  columns: string[];
  /** Row count, or null when the count is unknowable for this caller. */
  rowCount: number | null;
}

/**
 * Is `name` a table the system browser is allowed to open? Underscore-prefixed
 * internals, or one of the native conversation tables surfaced alongside them.
 * Both forms are fixed, validated names, which is what makes them safe to use
 * as an identifier in {@link readSystemTableRows}.
 */
export function isSystemTableName(name: string): boolean {
  return /^_+[a-zA-Z0-9_]+$/.test(name) || isInternalNativeEntity(name);
}

/**
 * Names of the underscore-prefixed internal tables physically present on this
 * database, sorted. Underscore is a LIKE wildcard in BOTH engines, so both
 * queries escape it and produce identical results.
 */
export async function listSystemTableNames(db: Lattice): Promise<string[]> {
  const adapter = db.adapter;
  const sql =
    adapter.dialect === 'postgres'
      ? // pg_tables is the public-schema-only counterpart to sqlite_master.
        `SELECT tablename AS name FROM pg_tables ` +
        `WHERE schemaname = 'public' AND tablename LIKE '\\_%' ESCAPE '\\' ` +
        `ORDER BY tablename`
      : `SELECT name FROM sqlite_master ` +
        `WHERE type='table' AND name LIKE '\\_%' ESCAPE '\\' ` +
        `ORDER BY name`;
  const rows = (await allAsyncOrSync(adapter, sql)) as { name?: unknown }[];
  return rows.map((r) => String(r.name));
}

/**
 * Describe the given system tables: columns + row count for each.
 *
 * Two absences are expected and must not fail the whole listing, because both
 * are ordinary states rather than faults: a scoped cloud member has no read
 * grant on the owner-only bookkeeping tables (they are reached through
 * owner-side functions by design), and a native conversation table listed
 * optimistically may not physically exist on a given database. Those come back
 * named, with no columns and an unknown (null) count. Any other error — a
 * syntax fault, a dropped connection — is rethrown.
 */
export async function describeSystemTables(
  db: Lattice,
  names: string[],
): Promise<SystemTableSummary[]> {
  const out: SystemTableSummary[] = [];
  for (const name of names) {
    try {
      const columns = await db.introspectColumns(name);
      const rowCount = await db.count(name);
      out.push({ name, columns, rowCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/permission denied|does not exist/i.test(msg)) throw err;
      out.push({ name, columns: [], rowCount: null });
    }
  }
  return out;
}

/**
 * The full system-table listing: every physically present internal table, plus
 * any of `alsoInclude` that isn't already in that set (the caller passes the
 * native conversation tables registered on this database), each described.
 */
export async function listSystemTables(
  db: Lattice,
  alsoInclude: string[] = [],
): Promise<SystemTableSummary[]> {
  const names = await listSystemTableNames(db);
  for (const n of alsoInclude) if (!names.includes(n)) names.push(n);
  return describeSystemTables(db, names);
}

/**
 * A BOUNDED page of raw rows from one system table. `limit` is the caller's
 * already-validated page size — there is no unbounded form of this read, because
 * one of these tables (the changelog, the audit log) can be large and reading it
 * whole is exactly the mistake this signature refuses to make possible.
 *
 * Throws on a name that is not a system table rather than returning nothing: an
 * unknown table is a caller bug, and an empty result would hide it.
 */
export async function readSystemTableRows(
  db: Lattice,
  table: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (!isSystemTableName(table)) {
    throw new Error(`Not a system table: ${table}`);
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `readSystemTableRows: limit must be a non-negative integer, got ${String(limit)}`,
    );
  }
  const rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "${table}" LIMIT ${String(limit)}`);
  return rows as Record<string, unknown>[];
}
