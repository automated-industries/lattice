import type { StorageAdapter } from '../db/adapter.js';

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
