/**
 * The ONE answer to "which tables do this workspace's connected external sources
 * own, and can we still reconstruct them?"
 *
 * A connected external database and a connected MCP server register their tables
 * with `defineLate` at connect/sync time. That registration lives only in the
 * process that made it. What SURVIVES the process is two things: the connector
 * registry row in the database, and the schema descriptor in the machine-local
 * store. So every later open has to REPLAY the registration from those two, or
 * its schema is missing those tables entirely.
 *
 * Missing them is not merely "shows less". The rendered context tree is
 * reconciled against a manifest of what the LAST render wrote, so a process that
 * opens without these tables reads their rendered contexts as "these were
 * removed" and DELETES them from disk. The app writes the tree, a terminal
 * command removes it, the next sync writes it again — and nothing reports an
 * error at any point.
 *
 * Hence one module with two callers, so they can never disagree:
 *
 *  - the open path REPLAYS what it finds here, so every opener ends up with the
 *    same schema (see {@link replayConnectedSourceSchema});
 *  - the cleanup backstop ASKS the same question before deleting a rendered
 *    context it does not recognise, so a replay that could not run cannot turn
 *    into a silent deletion.
 *
 * Nothing here goes over the network: an external database's tables come from
 * the schema descriptor persisted locally at connect time, and a generic MCP
 * connector's model is built statically.
 */
import type { Lattice } from '../lattice.js';
import type { ConnectedModelDef } from './types.js';
import { listConnectorsIfPresent, type ConnectorRecord } from './registry.js';
import {
  deriveCanonicalContexts,
  ensureRuntimeEntityContexts,
} from '../framework/canonical-context.js';

/** What a workspace's connected external sources contribute to its schema. */
export interface ConnectedSourceSchema {
  /** Every model a currently-connected source owns, reconstructed locally. */
  models: ConnectedModelDef[];
  /**
   * Labels of connected sources whose table set could NOT be reconstructed here
   * — the local schema descriptor is missing (a different machine, a cleared
   * store, a connection that never finished introspecting).
   *
   * This is deliberately reported rather than swallowed. Their tables are
   * unknowable from this process, so a caller about to delete an unrecognised
   * rendered tree cannot rule out that the tree is theirs.
   */
  unresolved: string[];
}

/** A connected source's human label, for the messages a refusal prints. */
function sourceLabel(record: ConnectorRecord): string {
  return record.displayName ?? record.toolkit;
}

/**
 * Reconstruct the models every currently-connected external source owns.
 *
 * Read-only and DDL-free: a workspace that has never connected anything does one
 * cheap existence check and returns nothing, so the ordinary case pays almost
 * nothing. The connector implementations are imported lazily, and only for the
 * kinds this workspace actually has.
 */
export async function readConnectedSourceSchema(db: Lattice): Promise<ConnectedSourceSchema> {
  const records = (await listConnectorsIfPresent(db)).filter((c) => c.status !== 'disconnected');
  const out: ConnectedSourceSchema = { models: [], unresolved: [] };
  if (records.length === 0) return out;

  const dbSources = records.filter((c) => c.connector === 'db_source');
  const mcpSources = records.filter((c) => c.connector === 'mcp');

  // De-duplicated by TABLE, which is the thing being registered — not by
  // toolkit, which is the thing being asked. Two MCP servers connected without a
  // described schema of their own are two different toolkits that both resolve to
  // the SAME flat table, and letting that pair through hands the caller a list
  // with one table in it twice: the second registration of its rendered layout
  // then fails, the models after it in the list never get one at all, and their
  // rendered trees read as removed on the next reconciliation.
  const byTable = new Map<string, ConnectedModelDef>();
  const take = (record: ConnectorRecord, models: ConnectedModelDef[]): void => {
    if (models.length === 0) {
      out.unresolved.push(sourceLabel(record));
      return;
    }
    for (const m of models) if (!byTable.has(m.table)) byTable.set(m.table, m);
  };

  if (dbSources.length > 0) {
    const { DatabaseConnector } = await import('./db-source/connector.js');
    const connector = new DatabaseConnector();
    for (const record of dbSources) take(record, connector.models(record.toolkit));
  }

  if (mcpSources.length > 0) {
    const { genericConnector } = await import('./generic/connector.js');
    const connector = genericConnector();
    for (const record of mcpSources) take(record, connector.models(record.toolkit));
  }

  out.models.push(...byTable.values());
  return out;
}

/**
 * Register every reconstructable connected-source table on this Lattice, and
 * give each one the same canonical per-record context a config table gets — so
 * an opener that replays ends up with the schema AND the rendered layout the
 * process that made the connection had. Registering the table without its
 * context is the same asymmetry one step smaller: the table comes back, but its
 * rendered tree still reads as removed and gets deleted.
 *
 * Idempotent (both `defineLate` and the context derivation skip what is already
 * registered). Must be called after `init()`; never on a scoped cloud member,
 * which holds no privilege to create anything.
 *
 * PARTIAL SUCCESS IS REPORTED, NOT SWALLOWED. A model that ends this call with a
 * table and no rendered context is the worst outcome available here — worse than
 * not being loaded at all, because the schema then looks complete while the
 * reconciliation that follows reads that source's rendered tree as removed and
 * deletes it. So the layout each model was supposed to get is checked against
 * what is actually registered afterwards, and anything missing comes back in
 * `unresolved` — which is what makes the cleanup backstop refuse rather than
 * sweep. Checked structurally rather than by catching, so a failure that throws
 * nowhere is caught the same as one that throws.
 *
 * @returns what was found, including any source that could not be reconstructed.
 */
export async function replayConnectedSourceSchema(db: Lattice): Promise<ConnectedSourceSchema> {
  const found = await readConnectedSourceSchema(db);
  const trouble: string[] = [];
  for (const model of found.models) {
    try {
      await db.defineLate(model.table, model.definition);
    } catch (e) {
      trouble.push(`${model.table} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  try {
    ensureRuntimeEntityContexts(db, found.models);
  } catch (e) {
    trouble.push(`their rendered layout (${e instanceof Error ? e.message : String(e)})`);
  }
  const contexts = db.entityContexts();
  const named = found.models.map((m) => ({ name: m.table, definition: m.definition }));
  for (const { table } of deriveCanonicalContexts(named)) {
    if (!contexts.has(table)) trouble.push(table);
  }
  for (const t of trouble) if (!found.unresolved.includes(t)) found.unresolved.push(t);
  return found;
}

/**
 * Just the table NAMES a currently-connected source owns, plus the sources whose
 * names could not be worked out. What the cleanup backstop needs.
 */
export async function connectedSourceTables(
  db: Lattice,
): Promise<{ tables: Set<string>; unresolved: string[] }> {
  const found = await readConnectedSourceSchema(db);
  return { tables: new Set(found.models.map((m) => m.table)), unresolved: found.unresolved };
}
