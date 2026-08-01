/**
 * Connector ACL wiring (cloud Postgres).
 *
 * On a cloud workspace, connected data is scoped per connecting member by the
 * same Row-Level Security that protects every other table: each connected table
 * gets RLS enabled, the insert trigger stamps the connecting member as owner, and
 * `lattice_row_visible` keeps a member's rows private to them — unless a connected
 * type is marked shared (`everyone`), in which case its rows default to visible to
 * the whole team.
 *
 * Because enabling RLS / DDL requires owner privilege, this is an OWNER setup
 * step (it no-ops for a non-owner, a non-cloud workspace, or SQLite). The owner
 * defines the connected tables and calls this once; members then sync their own
 * rows into the shared tables, born private to each member.
 *
 * Derived enrichment over connected rows inherits the connector data's
 * visibility automatically: write it through `db.observe(..., { changeKind:
 * 'derived', sourceRef: [connectedRowId] })`, and the existing source-gated fold
 * (`foldEntity` / `observationVisible`) hides it from a viewer who can't see the
 * source. No connector-specific code is needed for that — use the substrate.
 */

import type { Lattice } from '../lattice.js';
import { enableRlsForTable } from '../cloud/rls.js';
import { setTableDefaultVisibility } from '../cloud/table-policy.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { getAsyncOrSync } from '../db/adapter.js';
import type { Connector } from './types.js';

/**
 * Enable per-member RLS on a toolkit's connected tables and apply each connected
 * type's default visibility. Owner-only; a no-op on SQLite, a non-cloud Postgres,
 * or for a non-owner role. The connected tables must already exist (define them
 * first).
 *
 * The connector REGISTRY is deliberately not secured this way. It is owner-only
 * bookkeeping — members hold no grant on it and reach their own connectors through
 * an app-layer filter — so per-row policies on it protect nothing, while making it
 * unreadable to any owner that does not bypass row security. See the repair in the
 * cloud bootstrap, which reopens the registry on clouds an earlier build secured.
 */
export async function enableConnectorRls(
  db: Lattice,
  connector: Connector,
  toolkit: string,
): Promise<void> {
  if (db.getDialect() !== 'postgres') return; // RLS is a cloud-Postgres concept
  if (!(await cloudRlsInstalled(db))) return; // not a cloud workspace
  if (!(await canManageRoles(db))) return; // only the owner can ALTER / enable RLS

  for (const m of connector.models(toolkit)) {
    // Default visibility FIRST: securing the table stamps the rows already in it,
    // and it stamps them at this default. Setting it afterwards would leave every
    // pre-existing row at 'private' on a connected type the owner declared shared.
    await setTableDefaultVisibility(
      db,
      m.table,
      m.definition.source?.defaultVisibility ?? 'private',
    );
    await enableRlsForTable(db, m.table, [m.naturalKey]);
  }
}

/**
 * True when the CURRENT session should claim ownerless connector rows after a sync:
 * a cloud Postgres with RLS installed, opened by a scoped MEMBER. The owner installs
 * RLS at connect time, so an owner's synced rows are stamped by the trigger and never
 * ownerless — only a member hits the pre-RLS window. No-op signal otherwise.
 */
export async function shouldClaimOwnerlessRows(db: Lattice): Promise<boolean> {
  if (db.getDialect() !== 'postgres') return false;
  if (!(await cloudRlsInstalled(db))) return false;
  return !(await canManageRoles(db)); // members only (the owner never leaves rows ownerless)
}

/**
 * PREVENT: stamp the syncing member (session_user) as owner of any still-ownerless
 * rows of one connector in `table`, via the member-safe SECURITY DEFINER
 * `lattice_member_claim_ownerless`. Called right after a member's sync writes so the
 * rows carry ownership the instant they exist — before the owner ever FORCE-enables
 * RLS. Idempotent (only rows with no owner are claimed). Returns the number claimed.
 */
export async function claimOwnerlessConnectorRows(
  db: Lattice,
  table: string,
  connectorId: string,
): Promise<number> {
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT lattice_member_claim_ownerless(?, ?) AS claimed`,
    [table, connectorId],
  )) as { claimed: number | string | null } | undefined;
  return row?.claimed != null ? Number(row.claimed) : 0;
}

/**
 * Define + secure EVERY toolkit's connected tables (and the registry) for a
 * connector. Run by the owner on workspace open so connected tables created in a
 * member's session are RLS-protected even though the owner never connected — the
 * durable fix for "a member's lazily-registered connected table is born without
 * RLS." Owner-only; a no-op on SQLite / non-cloud / non-owner.
 */
export async function secureConnectorTables(db: Lattice, connector: Connector): Promise<void> {
  for (const toolkit of connector.toolkits()) {
    // Ensure the tables physically exist + are registered (idempotent), so RLS
    // can be enabled on them regardless of who first synced.
    for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
    await enableConnectorRls(db, connector, toolkit);
  }
}
