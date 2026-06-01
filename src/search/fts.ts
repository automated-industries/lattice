import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, introspectColumnsAsyncOrSync } from '../db/adapter.js';

/**
 * Generic full-text search — **Phase 1: LIKE fallback**.
 *
 * Runs a case-insensitive OR-of-`LIKE` across each table's text columns. This
 * path is **read-only**: it creates no indexes and adds no write-path behavior,
 * so it is safe for every consumer (including a bare `new Lattice(dbPath)`
 * library user) — nothing is auto-created on construction or write.
 *
 * A Phase 2 indexed engine (SQLite FTS5 external-content / Postgres `tsvector`
 * + GIN, maintained by a per-table-opt-in write hook that mirrors
 * `_syncEmbedding`) is a planned follow-up. That phase is the only piece that
 * touches the write path, and it must stay per-table opt-in so unconfigured
 * tables — and library consumers — keep paying zero overhead.
 *
 * This module is intentionally decoupled from `Lattice`: it takes a
 * `StorageAdapter` + the candidate table list (the GUI route supplies the
 * team-visibility-filtered set), so it has no dependency on the facade.
 */

export interface FtsHit {
  id: string;
  snippet: string;
}

export interface FtsGroup {
  table: string;
  /** Hits returned (capped at `limitPerTable`). */
  count: number;
  /** True when more than `limitPerTable` rows matched. */
  more: boolean;
  hits: FtsHit[];
}

export interface FtsResult {
  query: string;
  groups: FtsGroup[];
}

export interface FtsOptions {
  /** The raw query text. */
  query: string;
  /** Max hits per table (default 10). */
  limitPerTable?: number;
  /** Per-table override of which columns to search (default: auto-detected). */
  textColumns?: Record<string, string[]>;
}

// Columns excluded from auto-detected text search: identifiers + bookkeeping.
const SKIP_COLUMN = /^(id|.*_id|deleted_at|created_at|updated_at|_reward_(total|count))$/;

/** Escape LIKE wildcards in user input (we wrap it in our own `%…%`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function idOf(row: Record<string, unknown>): string {
  const v = row.id;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function searchableColumns(cols: string[], override?: string[]): string[] {
  if (override && override.length > 0) return override.filter((c) => cols.includes(c));
  return cols.filter((c) => !SKIP_COLUMN.test(c));
}

function makeSnippet(row: Record<string, unknown>, cols: string[], q: string): string {
  const needle = q.toLowerCase();
  for (const c of cols) {
    const v = row[c];
    if (typeof v !== 'string') continue;
    const idx = v.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 40);
    const end = Math.min(v.length, idx + q.length + 60);
    return (start > 0 ? '…' : '') + v.slice(start, end).trim() + (end < v.length ? '…' : '');
  }
  // No string column matched directly (e.g. a numeric coercion) — first text col.
  for (const c of cols) {
    const v = row[c];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 100);
  }
  return '';
}

/**
 * Full-text search (Phase 1 LIKE fallback) across `tables`. Returns hits
 * grouped per table; tables with no searchable columns or no matches are
 * omitted. A per-table failure (table gone, type quirk) skips that table
 * rather than failing the whole search.
 */
export async function fullTextSearch(
  adapter: StorageAdapter,
  tables: string[],
  opts: FtsOptions,
): Promise<FtsResult> {
  const q = opts.query.trim();
  if (q.length === 0) return { query: q, groups: [] };
  const limit = Math.max(1, Math.min(opts.limitPerTable ?? 10, 50));
  const like = `%${escapeLike(q)}%`;
  const groups: FtsGroup[] = [];

  for (const table of tables) {
    let cols: string[];
    try {
      cols = await introspectColumnsAsyncOrSync(adapter, table);
    } catch {
      continue;
    }
    const searchCols = searchableColumns(cols, opts.textColumns?.[table]);
    if (searchCols.length === 0) continue;

    // CAST(... AS TEXT) keeps the LIKE valid across column types on both engines
    // (Postgres rejects `int LIKE text`). Identifiers here are introspected
    // schema names, never user input; the query value is parameterized.
    const where = searchCols.map((c) => `CAST("${c}" AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ');
    const params: unknown[] = searchCols.map(() => like);
    let sql = `SELECT * FROM "${table}" WHERE (${where})`;
    if (cols.includes('deleted_at')) sql += ` AND (deleted_at IS NULL OR deleted_at = '')`;
    sql += ` LIMIT ${String(limit + 1)}`;

    let rows: Record<string, unknown>[];
    try {
      rows = (await allAsyncOrSync(adapter, sql, params)) as Record<string, unknown>[];
    } catch {
      continue;
    }
    if (rows.length === 0) continue;

    const capped = rows.slice(0, limit);
    groups.push({
      table,
      count: capped.length,
      more: rows.length > limit,
      hits: capped.map((r) => ({ id: idOf(r), snippet: makeSnippet(r, searchCols, q) })),
    });
  }

  return { query: q, groups };
}
