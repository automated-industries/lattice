/**
 * Connector teardown — disconnecting a connector makes its data "no longer
 * available."
 *
 * Soft-deletes every row the connector ingested (children before parents), prunes
 * the rendered context files for them, marks the connector disconnected (or
 * removes it in hard mode), and revokes the backend connection. Soft-deleted rows
 * drop out of the rendered context, full-text search, and the GUI's listings (all
 * of which filter `deleted_at IS NULL`), and their graph edges are removed — so
 * the data is no longer available to the agent, while staying physically present
 * and restorable. On cloud, the per-viewer render prune removes each member's
 * context files.
 */

import type { Lattice } from '../lattice.js';
import type { Connector } from './types.js';
import { getConnector, setConnectorStatus, deleteConnectorRecord } from './registry.js';
import { collectConnectorKeys } from './sync.js';

export interface DisconnectOptions {
  /**
   * `'soft'` (default) keeps the registry row as `disconnected` (reconnectable);
   * `'hard'` also removes the registry row. Ingested rows are soft-deleted in
   * both modes (Lattice never hard-deletes rows).
   */
  mode?: 'soft' | 'hard';
  /** When set, re-render to prune context files for the removed rows. */
  outputDir?: string;
}

export interface DisconnectResult {
  connectorId: string;
  mode: 'soft' | 'hard';
  /** Soft-deleted row count per table. */
  softDeleted: Record<string, number>;
}

/** Disconnect a connector and tear down everything it ingested. */
export async function disconnectConnector(
  db: Lattice,
  connector: Connector,
  connectorId: string,
  opts: DisconnectOptions = {},
): Promise<DisconnectResult> {
  const record = await getConnector(db, connectorId);
  if (!record) throw new Error(`Connector "${connectorId}" not found in the registry.`);
  const mode = opts.mode ?? 'soft';
  const models = connector.models(record.toolkit);
  const softDeleted: Record<string, number> = {};
  const now = new Date().toISOString();

  // 0. Ensure every connected table is registered in the LIVE schema so PK
  //    resolution below uses the table's REAL primary key. A db-source table
  //    with a composite/keyless natural key has `_pk`, not `id`; if the table
  //    isn't registered at disconnect time, getPrimaryKey() returns nothing and
  //    the query/update layer falls back to a default `id` column — which that
  //    table doesn't have, failing with "no such column: id". Idempotent.
  for (const m of models) await db.defineLate(m.table, m.definition);

  // 1. Soft-delete every ingested row, children before parents. Goes through
  //    db.update(deleted_at) (not db.delete, which is a HARD delete) so the rows
  //    remain recoverable and the soft-delete is recorded in the changelog.
  for (const m of [...models].reverse()) {
    const keys = await collectConnectorKeys(db, m.table, m.naturalKey, connectorId);
    for (const key of keys) {
      await db.update(m.table, key, { deleted_at: now });
    }
    softDeleted[m.table] = keys.length;
  }

  // 2. Prune rendered context files for the now-hidden rows.
  if (opts.outputDir) await db.reconcile(opts.outputDir);

  // 3. Revoke the backend connection FIRST, while the connection id is still in
  //    the registry — so a failed revoke leaves a retryable handle rather than a
  //    live SaaS grant we can no longer reach (especially in hard mode, which
  //    deletes the row). External op → surfaced loudly on failure.
  if (record.connectionRef) {
    await connector.disconnect(record.connectionRef);
  }

  // 4. Only after a successful revoke, finalize local registry state. Hard mode
  //    also purges any non-secret reconnect state the connector retained (e.g.
  //    a stored server URL) — nothing should outlive the registry row.
  if (mode === 'hard') {
    await deleteConnectorRecord(db, connectorId);
    if (record.connectionRef) await connector.purgeConnection?.(record.connectionRef);
  } else {
    await setConnectorStatus(db, connectorId, 'disconnected');
  }

  return { connectorId, mode, softDeleted };
}
