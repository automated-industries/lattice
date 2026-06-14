import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';

/**
 * Physical-schema discovery for cloud members. A member connects to a shared
 * cloud as a scoped role whose local config may declare NO entities — yet the
 * GUI must show every table the member is allowed to use. Postgres only exposes
 * a table in `pg_tables` / `information_schema` to a role that holds a privilege
 * on it, so listing the role's visible user tables is exactly the set RLS lets
 * it touch: the member's granted tables, never another's bookkeeping.
 */

export interface DiscoveredTable {
  name: string;
  columns: string[];
  /** Primary-key column(s), in key order. May be empty for a keyless table. */
  pk: string[];
}

/**
 * List the user tables a member's role is actually privileged to use, excluding
 * Lattice/GUI bookkeeping (anything starting `_`). `information_schema.tables`
 * is privilege-filtered — it shows a role only the tables it holds a grant on or
 * owns — so this returns exactly the member's reachable set, never another
 * member's bookkeeping (which is granted to no one). Scoped to `current_schema()`
 * so it follows the connection's search_path (the cloud's `public` in production).
 * Returns each table's columns + primary key so the caller can register it.
 * Postgres-only — returns `[]` on SQLite (a private, single-user store).
 */
export async function discoverCloudTables(db: Lattice): Promise<DiscoveredTable[]> {
  if (db.getDialect() !== 'postgres') return [];
  const adapter = db.adapter;
  const tableRows = (await allAsyncOrSync(
    adapter,
    `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_type = 'BASE TABLE'
         AND table_name NOT LIKE '\\_%' ESCAPE '\\'
       ORDER BY table_name`,
  )) as { name: string }[];

  const out: DiscoveredTable[] = [];
  for (const { name } of tableRows) {
    const columns = await db.introspectColumns(name);
    const pkRows = (await allAsyncOrSync(
      adapter,
      `SELECT kcu.column_name AS col
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = ?
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
      [name],
    )) as { col: string }[];
    out.push({ name, columns, pk: pkRows.map((r) => r.col) });
  }
  return out;
}
