import type { StorageAdapter } from '../db/adapter.js';
import type { Row } from '../types.js';
import { assertSafeIdentifier } from '../schema/identifier.js';

/**
 * Approximate row counts for many tables in a single Postgres round-trip,
 * read from `pg_class.reltuples` (the planner statistic maintained by
 * autovacuum's ANALYZE).
 *
 * The naive alternative — `await Promise.all(tables.map(t => db.count(t)))`
 * — fans out one COUNT(*) per table over the connection pool. On a session
 * pooler with N slots and >N tables, that exhausts the pool the moment a
 * second concurrent request arrives. This helper collapses the fan-out
 * to one query against the system catalogs.
 *
 * Returns a Map keyed by table name. Tables that aren't in the current
 * schema, or that have never been ANALYZE'd (`reltuples < 0`), are absent
 * from the map — the caller decides whether to surface that as `null` or
 * fall back to an exact count.
 *
 * The count is approximate. For a table-list "browse" view this is the
 * right tradeoff (fast, scales linearly with schema size, no pool risk).
 * Callers that need exact counts should issue per-table COUNT(*) for the
 * specific tables that need them — not for the whole catalog.
 */
export async function countManyPostgres(
  adapter: StorageAdapter,
  tableNames: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tableNames.length === 0) return out;
  if (!adapter.allAsync) return out;

  const rows = (await adapter.allAsync(
    `SELECT c.relname AS name, c.reltuples::bigint AS row_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relkind IN ('r','v','m','p')
       AND c.relname = ANY($1)`,
    [tableNames],
  )) as { name: string; row_count: number | bigint | string }[];

  for (const r of rows) {
    const n = typeof r.row_count === 'bigint' ? Number(r.row_count) : Number(r.row_count);
    if (Number.isFinite(n) && n >= 0) out.set(r.name, n);
  }
  return out;
}

/** Max tables the exact-count fallback will scan in one pass (pool + scan safety). */
export const EXACT_COUNT_CAP = 50;

/**
 * Exact row counts for a BOUNDED set of tables in a single Postgres round-trip.
 *
 * The fast path ({@link countManyPostgres}) reads approximate
 * `pg_class.reltuples`, which is stale at 0 for tables that haven't crossed
 * autovacuum's ANALYZE threshold (~50 changes) since their last bulk load — so
 * a table with real rows can read 0. This helper corrects that *suspicious*
 * subset (approximate count null or 0) with an exact COUNT, while keeping the
 * pool-safe one-round-trip shape: a single
 * `SELECT (SELECT count(*) FROM a) AS c0, …` rather than a per-table fan-out
 * that would exhaust a session pooler.
 *
 * Capped at {@link EXACT_COUNT_CAP} tables so a never-analyzed fresh DB can't
 * turn this into a large scan; overflow is logged and skipped (no silent
 * truncation), and those tables keep their approximate value. Tables in
 * `softDeleteTables` get the same `deleted_at IS NULL` filter the SQLite exact
 * path uses, so the two dialects report identical counts.
 */
export async function exactCountMany(
  adapter: StorageAdapter,
  tableNames: string[],
  softDeleteTables: Set<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tableNames.length === 0) return out;
  if (!adapter.getAsync) return out;

  let names = tableNames;
  if (names.length > EXACT_COUNT_CAP) {
    const dropped = names.length - EXACT_COUNT_CAP;
    console.warn(
      `[count-many] exact-count subset capped at ${String(EXACT_COUNT_CAP)} tables; ` +
        `${String(dropped)} suspicious table(s) keep their approximate count this pass`,
    );
    names = names.slice(0, EXACT_COUNT_CAP);
  }

  const selects = names.map((name, i) => {
    assertSafeIdentifier(name, 'table');
    const where = softDeleteTables.has(name) ? ` WHERE "deleted_at" IS NULL` : '';
    return `(SELECT count(*) FROM "${name}"${where}) AS c${String(i)}`;
  });
  let row: Row | undefined;
  try {
    row = await adapter.getAsync(`SELECT ${selects.join(', ')}`);
  } catch (err) {
    // A "suspicious" table that isn't physically present (schema drift between
    // the registered set and the DB) would make the single aggregate throw and
    // 500 the whole dashboard. Degrade to the approximate counts (the caller
    // renders absent tables as "—") rather than failing the page — and log the
    // drift so it stays visible.
    console.warn(
      `[count-many] exact-count fallback skipped (${(err as Error).message}); ` +
        'using approximate counts',
    );
    return out;
  }
  if (!row) return out;
  names.forEach((name, i) => {
    const v = row[`c${String(i)}`];
    const n = typeof v === 'bigint' ? Number(v) : Number(v);
    if (Number.isFinite(n) && n >= 0) out.set(name, n);
  });
  return out;
}
