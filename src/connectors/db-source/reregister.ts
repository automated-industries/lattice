import type { Lattice } from '../../lattice.js';
import { listConnectors } from '../registry.js';
import { DatabaseConnector } from './connector.js';

/**
 * Replay the schema registration for every connected external-database
 * ("db-source") connection on the live Lattice.
 *
 * The connect flow `defineLate()`s each per-connection table (`db_<prefix>_<name>`)
 * so it becomes queryable and shows up in the schema. But `defineLate` only
 * registers the table on the in-memory schema manager of the current process — it
 * is NOT replayed when the workspace is re-opened. So after an app restart the
 * imported tables + rows are still physically present on disk (and the
 * `__lattice_connectors` row still says `status='connected'`), yet the live schema
 * knows nothing about them: they disappear from `/api/entities`, the graph, the
 * Tables explorer, and the Objects page. Built-in connectors (Gmail, Jira, …) are
 * unaffected because their table schemas are defined at boot; only the
 * dynamically-named db-source tables need replaying.
 *
 * `connector.models()` reconstructs the table definitions from the schema
 * descriptor persisted in the machine-local encrypted store, so this needs no
 * network round-trip. A connection whose descriptor is missing (e.g. it was
 * disconnected) yields no models and is skipped.
 *
 * Called from the workspace-open path; fault-isolated by the caller.
 */
export async function reregisterDbSourceTables(db: Lattice): Promise<void> {
  const connectors = (await listConnectors(db)).filter((c) => c.connector === 'db_source');
  if (connectors.length === 0) return;
  const connector = new DatabaseConnector();
  for (const c of connectors) {
    for (const m of connector.models(c.toolkit)) {
      await db.defineLate(m.table, m.definition);
    }
  }
}
