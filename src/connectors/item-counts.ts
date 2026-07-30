/**
 * How many synced rows each connection owns — a capability, not a route.
 *
 * A typed connection writes to its own per-kind mirror tables, not to one shared
 * item table, so counting only the shared table reports zero for every typed
 * connection. The count therefore has to be summed across each connection's real
 * tables, and every caller that wants "how much has this connection actually
 * pulled down?" wants the same sum — a status command as much as a table view.
 *
 * Bounded by construction: one grouped COUNT per table, never a row load, and
 * each table is scanned at most once no matter how many connections resolve to
 * it.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { assertSafeIdentifier } from '../schema/identifier.js';

/**
 * Sum synced-row counts per connection id across `tables` (duplicates ignored).
 *
 * A table that does not exist yet contributes nothing: a connection that has
 * never synced has no mirror table, which is an ordinary state, not a fault.
 * Rows with no connector stamp are skipped. Postgres returns COUNT as a string
 * and SQLite as a number, so both are coerced.
 */
export async function countItemsBySourceConnector(
  adapter: StorageAdapter,
  tables: Iterable<string>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const table of tables) {
    if (seen.has(table)) continue;
    seen.add(table);
    assertSafeIdentifier(table, 'table');
    let rows: { cid?: unknown; n?: unknown }[];
    try {
      rows = (await allAsyncOrSync(
        adapter,
        `SELECT "_source_connector_id" AS cid, COUNT(*) AS n FROM "${table}" ` +
          `WHERE "deleted_at" IS NULL GROUP BY "_source_connector_id"`,
        [],
      )) as { cid?: unknown; n?: unknown }[];
    } catch {
      // No mirror table yet (nothing has synced into it) — contributes zero.
      continue;
    }
    for (const r of rows) {
      const cid = typeof r.cid === 'string' ? r.cid : '';
      if (!cid) continue;
      counts.set(cid, (counts.get(cid) ?? 0) + Number(r.n));
    }
  }
  return counts;
}
