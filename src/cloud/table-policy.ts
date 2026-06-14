import type { Lattice } from '../lattice.js';
import { getAsyncOrSync, allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';

/**
 * Per-table cloud policy (owner-controlled, Postgres-stored + enforced):
 *  - `defaultRowVisibility` — the visibility NEW rows in this table are stamped
 *    with (the per-table insert trigger reads `__lattice_table_policy`); default
 *    `private` ⇒ unchanged behavior.
 *  - `neverShare` — a hard exclusion (Secrets/Messages-class): the share/grant
 *    SECURITY DEFINER functions raise for the table and the trigger forces its rows
 *    private. Set at the data-model level, so a direct `psql` connection obeys it.
 *
 * These are thin wrappers over the owner-gated SQL functions in the RLS bootstrap
 * (`lattice_set_table_default_visibility` / `lattice_set_table_never_share`), which
 * raise unless the caller can create roles. No-op / safe defaults on SQLite.
 */

export type RowVisibilityDefault = 'private' | 'everyone';

export interface TablePolicy {
  defaultRowVisibility: RowVisibilityDefault;
  neverShare: boolean;
}

/** Read a table's policy. Returns the safe default (private, shareable) on SQLite
 *  or when no policy row exists. */
export async function getTablePolicy(db: Lattice, table: string): Promise<TablePolicy> {
  if (db.getDialect() !== 'postgres') return { defaultRowVisibility: 'private', neverShare: false };
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "default_row_visibility", "never_share" FROM "__lattice_table_policy" WHERE "table_name" = ?`,
    [table],
  )) as { default_row_visibility?: string; never_share?: boolean } | undefined;
  return {
    defaultRowVisibility: row?.default_row_visibility === 'everyone' ? 'everyone' : 'private',
    neverShare: row?.never_share === true,
  };
}

/** Read EVERY table's policy in one query (a map keyed by table name). For the
 *  entities listing, so a workspace with N tables costs one round-trip, not N
 *  (Rule: bounded reads — no per-table SELECT loop on a listing path). */
export async function getAllTablePolicies(db: Lattice): Promise<Record<string, TablePolicy>> {
  if (db.getDialect() !== 'postgres') return {};
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "table_name", "default_row_visibility", "never_share" FROM "__lattice_table_policy"`,
  )) as { table_name: string; default_row_visibility?: string; never_share?: boolean }[];
  const out: Record<string, TablePolicy> = {};
  for (const r of rows) {
    out[r.table_name] = {
      defaultRowVisibility: r.default_row_visibility === 'everyone' ? 'everyone' : 'private',
      neverShare: r.never_share === true,
    };
  }
  return out;
}

/** Owner-only: set the visibility NEW rows in `table` are created with. Raises (via
 *  the SQL function) for a non-owner or for `everyone` on a never-share table. */
export async function setTableDefaultVisibility(
  db: Lattice,
  table: string,
  visibility: RowVisibilityDefault,
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  await runAsyncOrSync(db.adapter, `SELECT lattice_set_table_default_visibility(?, ?)`, [
    table,
    visibility,
  ]);
}

/** Owner-only: mark (or unmark) a table never-shareable. When on, the share/grant
 *  functions refuse it and its new rows are forced private. */
export async function setTableNeverShare(db: Lattice, table: string, on: boolean): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  await runAsyncOrSync(db.adapter, `SELECT lattice_set_table_never_share(?, ?)`, [table, on]);
}
