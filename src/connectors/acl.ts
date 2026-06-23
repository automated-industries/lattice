/**
 * Connector ACL wiring (cloud Postgres).
 *
 * On a cloud workspace, connected data is scoped per connecting member by the
 * same Row-Level Security that protects every other table: the registry and each
 * connected table get RLS enabled, the insert trigger stamps the connecting
 * member as owner, and `lattice_row_visible` keeps a member's rows private to
 * them — unless a connected type is marked shared (`everyone`), in which case its
 * rows default to visible to the whole team.
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
import type { Connector } from './types.js';
import { CONNECTORS_TABLE } from './registry.js';

/**
 * Enable per-member RLS on the connector registry and a toolkit's connected
 * tables, and apply each connected type's default visibility. Owner-only; a
 * no-op on SQLite, a non-cloud Postgres, or for a non-owner role. The connected
 * tables must already exist (define them first).
 */
export async function enableConnectorRls(
  db: Lattice,
  connector: Connector,
  toolkit: string,
): Promise<void> {
  if (db.getDialect() !== 'postgres') return; // RLS is a cloud-Postgres concept
  if (!(await cloudRlsInstalled(db))) return; // not a cloud workspace
  if (!(await canManageRoles(db))) return; // only the owner can ALTER / enable RLS

  await enableRlsForTable(db, CONNECTORS_TABLE, ['id']);
  for (const m of connector.models(toolkit)) {
    await enableRlsForTable(db, m.table, [m.naturalKey]);
    await setTableDefaultVisibility(
      db,
      m.table,
      m.definition.source?.defaultVisibility ?? 'private',
    );
  }
}
