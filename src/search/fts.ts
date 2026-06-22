import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, runAsyncOrSync, introspectColumnsAsyncOrSync } from '../db/adapter.js';

/**
 * Generic full-text search with two tiers:
 *
 * - **Phase 2 — indexed.** Tables that opt in via `TableDefinition.fts` get an
 *   inverted index in a separate `__lattice_fts_<table>` table (SQLite **FTS5**
 *   / Postgres **`tsvector` + GIN**), kept current by DB triggers / a generated
 *   column. `fullTextSearch` uses it automatically when present.
 * - **Phase 1 — LIKE fallback.** Tables WITHOUT an index are searched with a
 *   case-insensitive `OR`-of-`LIKE` over their auto-detected text columns.
 *
 * Both tiers are **read-only at search time**. The index is created only for
 * opt-in tables (in `Lattice.init`), so a bare `new Lattice(dbPath)` library
 * user with no `fts` config has no index, no triggers, and zero write-path
 * overhead — a guardrail the test suite locks in.
 *
 * This module is decoupled from `Lattice`: it takes a `StorageAdapter` (the GUI
 * route / chat tool supplies the team-visibility-filtered table list).
 */

export interface FtsHit {
  id: string;
  snippet: string;
  /**
   * Relevance score, higher = better. Populated by the indexed tier
   * (`ts_rank` on Postgres, `-bm25` on SQLite FTS5). Absent / 0 for the LIKE
   * fallback tier, which has no ranking model. Used to order hits and as the
   * FTS signal in hybrid fusion.
   */
  score?: number;
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
  /** Per-table override of which columns to search (LIKE tier only). */
  textColumns?: Record<string, string[]>;
}

// Columns excluded from auto-detected text search: identifiers + bookkeeping.
const SKIP_COLUMN = /^(id|.*_id|deleted_at|created_at|updated_at|_reward_(total|count))$/;

const FTS_PREFIX = '__lattice_fts_';

/** The internal index table name for a base table. */
export function ftsTableName(table: string): string {
  return `${FTS_PREFIX}${table}`;
}

/** Columns Lattice will index for `table` when `fts.fields` is omitted. */
export function autoFtsColumns(cols: string[]): string[] {
  return cols.filter((c) => !SKIP_COLUMN.test(c));
}

/** `coalesce(<prefix>"c1",'') || ' ' || …` — the searchable text blob. */
function concatExpr(cols: string[], alias: string): string {
  const p = alias ? `${alias}.` : '';
  return cols.map((c) => `coalesce(${p}"${c}", '')`).join(" || ' ' || ");
}

/**
 * Create (idempotently) the inverted index for `table` over `cols` + the
 * triggers / generated column that keep it current, and backfill existing rows.
 * No-op if `cols` is empty. Called from `Lattice.init` for opt-in tables only.
 *
 * Identifiers come from the registered schema (not user input), so they are
 * safe to interpolate.
 */
export async function ensureFtsIndex(
  adapter: StorageAdapter,
  table: string,
  cols: string[],
): Promise<void> {
  if (cols.length === 0) return;
  const fts = ftsTableName(table);

  if (adapter.dialect === 'postgres') {
    await runAsyncOrSync(
      adapter,
      `CREATE TABLE IF NOT EXISTS "${fts}" (
         row_id TEXT PRIMARY KEY,
         body TEXT,
         tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED
       )`,
    );
    await runAsyncOrSync(
      adapter,
      `CREATE INDEX IF NOT EXISTS "${fts}_gin" ON "${fts}" USING GIN(tsv)`,
    );
    await runAsyncOrSync(
      adapter,
      `CREATE OR REPLACE FUNCTION "${fts}_sync"() RETURNS trigger AS $fn$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           DELETE FROM "${fts}" WHERE row_id = OLD."id"; RETURN OLD;
         END IF;
         INSERT INTO "${fts}"(row_id, body) VALUES (NEW."id", ${concatExpr(cols, 'NEW')})
           ON CONFLICT (row_id) DO UPDATE SET body = EXCLUDED.body;
         RETURN NEW;
       END; $fn$ LANGUAGE plpgsql`,
    );
    await runAsyncOrSync(adapter, `DROP TRIGGER IF EXISTS "${fts}_trg" ON "${table}"`);
    await runAsyncOrSync(
      adapter,
      `CREATE TRIGGER "${fts}_trg" AFTER INSERT OR UPDATE OR DELETE ON "${table}"
       FOR EACH ROW EXECUTE FUNCTION "${fts}_sync"()`,
    );
    // Backfill existing rows (idempotent via ON CONFLICT).
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${fts}"(row_id, body) SELECT "id", ${concatExpr(cols, '')} FROM "${table}"
       ON CONFLICT (row_id) DO NOTHING`,
    );
    return;
  }

  // SQLite (FTS5 standalone, keyed by row_id; triggers keep it current).
  await runAsyncOrSync(
    adapter,
    `CREATE VIRTUAL TABLE IF NOT EXISTS "${fts}" USING fts5(row_id UNINDEXED, body)`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE TRIGGER IF NOT EXISTS "${fts}_ai" AFTER INSERT ON "${table}" BEGIN
       INSERT INTO "${fts}"(row_id, body) VALUES (new."id", ${concatExpr(cols, 'new')});
     END`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE TRIGGER IF NOT EXISTS "${fts}_ad" AFTER DELETE ON "${table}" BEGIN
       DELETE FROM "${fts}" WHERE row_id = old."id";
     END`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE TRIGGER IF NOT EXISTS "${fts}_au" AFTER UPDATE ON "${table}" BEGIN
       DELETE FROM "${fts}" WHERE row_id = old."id";
       INSERT INTO "${fts}"(row_id, body) VALUES (new."id", ${concatExpr(cols, 'new')});
     END`,
  );
  // Backfill existing rows only if the index is empty (idempotent on re-init).
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${fts}"(row_id, body)
       SELECT "id", ${concatExpr(cols, '')} FROM "${table}"
       WHERE NOT EXISTS (SELECT 1 FROM "${fts}" LIMIT 1)`,
  );
}

/** Whether an FTS index table exists for `table`. */
export async function hasFtsIndex(adapter: StorageAdapter, table: string): Promise<boolean> {
  try {
    const cols = await introspectColumnsAsyncOrSync(adapter, ftsTableName(table));
    return cols.length > 0;
  } catch {
    return false;
  }
}

/** Sanitize free text into a safe FTS5 MATCH expression (quoted AND-ed terms). */
function toFts5Query(q: string): string {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

function snippetFrom(row: Record<string, unknown>, cols: string[], q: string): string {
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
  for (const c of cols) {
    const v = row[c];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 100);
  }
  return '';
}

function idOf(row: Record<string, unknown>): string {
  const v = row.id;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function snippetText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Indexed search for one table (FTS5 / tsvector). Returns null on no match. */
async function indexedSearchTable(
  adapter: StorageAdapter,
  table: string,
  q: string,
  limit: number,
  hasDeletedAt: boolean,
): Promise<FtsGroup | null> {
  const fts = ftsTableName(table);
  const deleted = hasDeletedAt ? `AND b.deleted_at IS NULL` : '';
  let rows: Record<string, unknown>[];
  if (adapter.dialect === 'postgres') {
    // ts_rank scores relevance; ORDER BY it so the best matches come first
    // (previously results came back in physical order).
    rows = (await allAsyncOrSync(
      adapter,
      `SELECT f.row_id AS id,
              ts_headline('simple', f.body, plainto_tsquery('simple', ?),
                          'StartSel=,StopSel=,MaxWords=18,MinWords=4') AS snippet,
              ts_rank(f.tsv, plainto_tsquery('simple', ?)) AS score
       FROM "${fts}" f JOIN "${table}" b ON b."id" = f.row_id
       WHERE f.tsv @@ plainto_tsquery('simple', ?) ${deleted}
       ORDER BY score DESC
       LIMIT ?`,
      [q, q, q, limit + 1],
    )) as Record<string, unknown>[];
  } else {
    const match = toFts5Query(q);
    if (match.length === 0) return null;
    // FTS5 `bm25()` is more-negative = more relevant; negate so higher = better
    // and ORDER BY it for relevance ranking (FTS5 otherwise returns rowid order).
    // FTS5 MATCH requires the FTS table's real name (an alias is rejected), so
    // the index table is referenced unaliased; only the base table is aliased.
    rows = (await allAsyncOrSync(
      adapter,
      `SELECT "${fts}".row_id AS id, snippet("${fts}", 1, '', '', '…', 12) AS snippet,
              -bm25("${fts}") AS score
       FROM "${fts}" JOIN "${table}" b ON b."id" = "${fts}".row_id
       WHERE "${fts}" MATCH ? ${deleted}
       ORDER BY score DESC
       LIMIT ?`,
      [match, limit + 1],
    )) as Record<string, unknown>[];
  }
  if (rows.length === 0) return null;
  const capped = rows.slice(0, limit);
  return {
    table,
    count: capped.length,
    more: rows.length > limit,
    hits: capped.map((r) => ({
      id: idOf(r),
      snippet: snippetText(r.snippet),
      score: r.score == null ? 0 : Number(r.score),
    })),
  };
}

/** LIKE-fallback search for one table. Returns null on no match. */
async function likeSearchTable(
  adapter: StorageAdapter,
  table: string,
  searchCols: string[],
  q: string,
  limit: number,
  hasDeletedAt: boolean,
): Promise<FtsGroup | null> {
  // CAST(... AS TEXT) keeps the LIKE valid across column types on both engines.
  const where = searchCols.map((c) => `CAST("${c}" AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ');
  const like = `%${escapeLike(q)}%`;
  const params: unknown[] = searchCols.map(() => like);
  let sql = `SELECT * FROM "${table}" WHERE (${where})`;
  if (hasDeletedAt) sql += ` AND deleted_at IS NULL`;
  sql += ` LIMIT ${String(limit + 1)}`;
  let rows: Record<string, unknown>[];
  try {
    rows = (await allAsyncOrSync(adapter, sql, params)) as Record<string, unknown>[];
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const capped = rows.slice(0, limit);
  return {
    table,
    count: capped.length,
    more: rows.length > limit,
    hits: capped.map((r) => ({ id: idOf(r), snippet: snippetFrom(r, searchCols, q) })),
  };
}

/** Escape LIKE wildcards in user input (we wrap it in our own `%…%`). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function searchableColumns(cols: string[], override?: string[]): string[] {
  if (override && override.length > 0) return override.filter((c) => cols.includes(c));
  return autoFtsColumns(cols);
}

/**
 * Full-text search across `tables`. Each table uses its FTS index when one
 * exists, else the LIKE fallback. Hits are grouped per table; tables with no
 * searchable columns or no matches are omitted. A per-table failure skips that
 * table rather than failing the whole search.
 */
export async function fullTextSearch(
  adapter: StorageAdapter,
  tables: string[],
  opts: FtsOptions,
): Promise<FtsResult> {
  const q = opts.query.trim();
  if (q.length === 0) return { query: q, groups: [] };
  const limit = Math.max(1, Math.min(opts.limitPerTable ?? 10, 50));
  const groups: FtsGroup[] = [];

  for (const table of tables) {
    let cols: string[];
    try {
      cols = await introspectColumnsAsyncOrSync(adapter, table);
    } catch {
      continue;
    }
    const hasDeletedAt = cols.includes('deleted_at');
    let group: FtsGroup | null = null;
    try {
      if (await hasFtsIndex(adapter, table)) {
        group = await indexedSearchTable(adapter, table, q, limit, hasDeletedAt);
      } else {
        const searchCols = searchableColumns(cols, opts.textColumns?.[table]);
        if (searchCols.length > 0) {
          group = await likeSearchTable(adapter, table, searchCols, q, limit, hasDeletedAt);
        }
      }
    } catch {
      // The indexed search failed. Most importantly, a scoped cloud member has no
      // access to the internal FTS index table — so fall back to a LIKE search on
      // the base table, which is filtered by Postgres RLS (the member only ever
      // matches rows it can see). This keeps search working for members without
      // granting them the FTS index (whose text would otherwise leak via psql),
      // and never returns another member's rows.
      try {
        const searchCols = searchableColumns(cols, opts.textColumns?.[table]);
        group =
          searchCols.length > 0
            ? await likeSearchTable(adapter, table, searchCols, q, limit, hasDeletedAt)
            : null;
      } catch {
        group = null;
      }
    }
    if (group) groups.push(group);
  }

  return { query: q, groups };
}
