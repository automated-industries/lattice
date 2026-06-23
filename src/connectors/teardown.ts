/**
 * Connector teardown — disconnecting a connector makes its data "no longer
 * available."
 *
 * Soft-deletes every row the connector ingested (children before parents), prunes
 * the rendered context files for them, marks the connector disconnected (or
 * removes it in hard mode), and revokes the backend connection. Soft-deleted rows
 * drop out of queries, search, and graph traversal automatically (everything
 * filters `deleted_at IS NULL`), so their derived enrichment and edges become
 * dead-ends without extra bookkeeping. On cloud, the per-viewer render prune
 * removes each member's context files.
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

  // 1. Soft-delete every ingested row, children before parents.
  for (const m of [...models].reverse()) {
    const keys = await collectConnectorKeys(db, m.table, m.naturalKey, connectorId);
    let n = 0;
    for (const key of keys) {
      await db.delete(m.table, key);
      n++;
    }
    softDeleted[m.table] = n;
  }

  // 2. Prune rendered context files for the now-deleted rows.
  if (opts.outputDir) await db.reconcile(opts.outputDir);

  // 3. Update local registry state BEFORE the remote revoke, so local state is
  //    consistent even if the revoke fails.
  if (mode === 'hard') await deleteConnectorRecord(db, connectorId);
  else await setConnectorStatus(db, connectorId, 'disconnected');

  // 4. Revoke the backend connection (external op — surfaced loudly on failure).
  if (record.composioConnectionId) {
    await connector.disconnect(record.composioConnectionId);
  }

  return { connectorId, mode, softDeleted };
}
