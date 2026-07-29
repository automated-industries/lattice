import type { Lattice } from '../lattice.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { secureNewCloudTable } from './setup.js';

/**
 * Is this table ALREADY protected? Postgres attaches row security to the table
 * itself, not to its name, so a table that is renamed arrives here still
 * protected — and a rename is the one case where "register this table" does not
 * mean "this table is new". Treating it as new re-stamps ownership of rows that
 * already have owners: it hands them to whoever performed the rename, and it
 * collides head-on with the rename's own carrying of the existing ownership
 * records, which fails the rename outright.
 */
async function alreadySecured(db: Lattice, table: string): Promise<boolean> {
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT c.relrowsecurity AS secured
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ?`,
    [table],
  )) as { secured?: unknown } | undefined;
  return row?.secured === true || row?.secured === 't';
}

/**
 * Secure a table that came into existence AFTER a cloud was secured, the same
 * way the cutover secured the tables that already existed: per-row ownership,
 * forced row security, and the companion read relation members read through.
 *
 * This lives beside the cloud primitives rather than inside any one client
 * because "who created the table" must not decide whether it is protected. It is
 * called from the single registration point every creator funnels through
 * ({@link import('../lattice.js').Lattice.defineLate}), so a table made by a
 * script, by a command, or by the browser all arrive here identically. It used
 * to be called from the browser's schema editor alone, which meant a table made
 * any other way was born with row security OFF — wide open — and was repaired
 * only if and when a workspace owner next opened the browser UI.
 *
 * Four things make it a no-op, and each is a correctness requirement rather than
 * an optimization:
 *
 *  - **Not a cloud.** A local database has no rows-belong-to-people model at
 *    all, so there is nothing to enforce and nothing to grant.
 *  - **Not the workspace owner.** Enabling row security and building the read
 *    relation are owner-level operations; a member connection cannot perform
 *    them and must not try. A member's newly-synced table is instead secured by
 *    the owner's own reconciliation the next time they open the workspace.
 *  - **A live mirror of a connected external system.** Those tables hold rows
 *    written by whichever person ran the sync, and stamping ownership here would
 *    hand every one of those rows to whoever happens to be registering the table
 *    — taking them away from the person who actually synced them. Connected
 *    tables are attributed and secured by their own pass, which knows who synced
 *    what; claiming them here would silently outrun it.
 *  - **Already protected** — see {@link alreadySecured}. This is what keeps a
 *    rename a rename.
 *
 * Failures are NOT swallowed: a table that could not be secured is a table whose
 * rows are readable by people who should not see them, so the error reaches the
 * caller.
 */
export async function secureRuntimeTable(
  db: Lattice,
  table: string,
  pk: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  if (db.getConnectedSource(table)) return;
  if (!((await cloudRlsInstalled(db)) && (await canManageRoles(db)))) return;
  if (await alreadySecured(db, table)) return;
  await secureNewCloudTable(db, table, pk);
}
