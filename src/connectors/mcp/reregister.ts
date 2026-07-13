import type { Lattice } from '../../lattice.js';
import { listConnectors } from '../registry.js';
import { genericConnector } from '../generic/connector.js';

/**
 * Replay the schema registration for every connected MCP connector on the live
 * Lattice, on workspace open.
 *
 * The connect + sync flow `defineLate()`s the connector's `mcp_items` table so it
 * becomes queryable and shows up in the schema / sidebar / assistant table
 * catalog. But `defineLate` only registers the table on the current process's
 * in-memory schema manager — it is NOT replayed when the workspace is re-opened.
 * So after an app restart the synced rows are still physically present on disk
 * (and `__lattice_connectors` still says `status='connected'`), yet the live
 * schema knows nothing about `mcp_items`: it vanishes from `/api/entities`, the
 * Tables sidebar, and the assistant's list of tables it can see and query. The
 * boot `sync-if-stale` pass does NOT cover this — it no-ops when the connector
 * synced within the staleness window (the common case), never re-registering.
 *
 * The generic connector's model is statically built (`mcpModel`), so this needs
 * no network round-trip — mirroring `reregisterDbSourceTables`. All pure-MCP
 * servers share toolkit `mcp` / table `mcp_items`, so one `defineLate` per
 * distinct toolkit covers any number of connected servers.
 *
 * Called from the workspace-open path; fault-isolated by the caller.
 */
export async function reregisterMcpConnectorTables(db: Lattice): Promise<void> {
  const rows = (await listConnectors(db)).filter(
    (c) => c.connector === 'mcp' && c.status !== 'disconnected',
  );
  if (rows.length === 0) return;
  const connector = genericConnector();
  const seen = new Set<string>();
  for (const c of rows) {
    if (seen.has(c.toolkit)) continue;
    seen.add(c.toolkit);
    for (const m of connector.models(c.toolkit)) {
      await db.defineLate(m.table, m.definition);
    }
  }
}
