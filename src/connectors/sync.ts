/**
 * Connector sync engine.
 *
 * Pulls each connected model's records from the source (paginated, bounded),
 * upserts them idempotently on the natural key (stamping connector lineage),
 * soft-deletes rows that vanished from the source, and derives graph edges so
 * the data is retrievable as relationship-aware context. Driven entirely by the
 * connector's {@link ConnectedModelDef}s — no per-product code here.
 *
 * Failure policy: a sync touches an external system, so any error is recorded on
 * the connector and re-thrown (surfaced loudly, never swallowed).
 *
 * Freshness: `syncIfStale` / `syncStaleConnectors` implement "sync on connect,
 * on load if older than an hour, and on manual refresh" without a scheduler.
 */

import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { runAsyncOrSync } from '../db/adapter.js';
import { addEdges } from '../search/graph.js';
import type { GraphEdge } from '../search/graph.js';
import type { Connector, ConnectedModelDef, ListChangesContext } from './types.js';
import { getConnector, listConnectors, recordSync } from './registry.js';

/** Default staleness window — re-sync on load when older than this. */
export const DEFAULT_STALE_MS = 3_600_000; // 1 hour

/** Page size for the bounded key scans used by prune + per-parent iteration. */
const KEY_PAGE_SIZE = 500;

export interface SyncConnectorResult {
  connectorId: string;
  /** Upserted row count per table. */
  upserted: Record<string, number>;
  /** Soft-deleted (vanished) row count per table. */
  softDeleted: Record<string, number>;
  /** Total graph edges derived. */
  edges: number;
  /** ISO timestamp stamped on this sync. */
  syncedAt: string;
}

export interface SyncConnectorOptions {
  /** Soft-delete rows absent from the source this sync. Default true. */
  pruneVanished?: boolean;
}

/** Run a full sync for one connector instance. */
export async function syncConnector(
  db: Lattice,
  connector: Connector,
  connectorId: string,
  opts: SyncConnectorOptions = {},
): Promise<SyncConnectorResult> {
  const record = await getConnector(db, connectorId);
  if (!record) throw new Error(`Connector "${connectorId}" not found in the registry.`);
  if (!record.composioConnectionId) {
    throw new Error(`Connector "${connectorId}" has no connection — authorize it first.`);
  }
  const { toolkit } = record;
  const ctxBase: Omit<ListChangesContext, 'parentKey'> = {
    connectionId: record.composioConnectionId,
    userId: record.connectedBy ?? connectorId,
  };
  const pruneVanished = opts.pruneVanished !== false;
  const now = new Date().toISOString();

  const models = connector.models(toolkit);
  // Ensure all connected tables exist (idempotent; parents before children).
  for (const m of models) await db.defineLate(m.table, m.definition);

  const result: SyncConnectorResult = {
    connectorId,
    upserted: {},
    softDeleted: {},
    edges: 0,
    syncedAt: now,
  };

  try {
    for (const m of models) {
      const { seen, edges } = await syncModel(db, connector, toolkit, m, ctxBase, connectorId, now);
      result.upserted[m.table] = seen.size;
      // Edges are derived inline from the rows just synced (bounded to what
      // changed) and batched — never a full-table re-scan of the connected table.
      if (edges.length > 0) {
        await addEdges(db.adapter, edges);
        result.edges += edges.length;
      }
      if (pruneVanished) {
        result.softDeleted[m.table] = await pruneVanished_(db, m, connectorId, seen, now);
      }
    }
    await recordSync(db, connectorId, { ok: true, at: now });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSync(db, connectorId, { ok: false, error: message });
    throw err; // fail loudly — do not swallow an external-sync failure
  }
  return result;
}

/** Sync one model, returning the natural keys seen this pass + the edges to add. */
async function syncModel(
  db: Lattice,
  connector: Connector,
  toolkit: string,
  m: ConnectedModelDef,
  ctxBase: Omit<ListChangesContext, 'parentKey'>,
  connectorId: string,
  now: string,
): Promise<{ seen: Set<string>; edges: GraphEdge[] }> {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  // Clear deleted_at so a previously soft-deleted natural key is RESURRECTED on
  // conflict when it reappears in the source (otherwise it would stay hidden).
  const stamp = (row: Row): Row => ({
    ...row,
    deleted_at: null,
    _source_connector_id: connectorId,
    _source_model: m.model,
    _source_synced_at: now,
  });

  const ingest = async (rec: { id: string; row: Row }, extra?: Row): Promise<void> => {
    const row = extra ? { ...rec.row, ...extra } : rec.row;
    await db.upsert(m.table, stamp(row));
    seen.add(rec.id);
    // Derive graph edges from this row's FK columns (bounded to synced rows).
    for (const e of m.graphEdges ?? []) {
      const dst = row[e.fkColumn];
      if (dst != null) {
        edges.push({
          srcTable: m.table,
          srcId: rec.id,
          dstTable: e.dstTable,
          dstId: String(dst as string | number),
          type: e.type,
        });
      }
    }
  };

  if (m.parent) {
    const parent = m.parent;
    const parentKeys = await collectConnectorKeys(db, parent.table, parent.keyColumn, connectorId);
    for (const parentKey of parentKeys) {
      for await (const rec of connector.listChanges(toolkit, m.model, { ...ctxBase, parentKey })) {
        await ingest(rec, { [parent.childColumn]: parentKey });
      }
    }
  } else {
    for await (const rec of connector.listChanges(toolkit, m.model, ctxBase)) {
      await ingest(rec);
    }
  }
  return { seen, edges };
}

const EDGES_TABLE = '__lattice_edges';

/**
 * Soft-delete this connector's LIVE rows whose natural key wasn't seen this sync,
 * and drop their graph edges. Soft-delete goes through `db.update(deleted_at)` so
 * it records a changelog entry + fires the render hooks (a raw DELETE would not).
 *
 * SAFETY: if NOTHING was seen this pass, skip the prune entirely. An empty fetch
 * is far more likely a transient/auth/shape failure than the genuine
 * disappearance of every row — soft-deleting the whole table on an empty result
 * would be silent mass data loss. Lingering stale rows are the safe tradeoff.
 */
async function pruneVanished_(
  db: Lattice,
  m: ConnectedModelDef,
  connectorId: string,
  seen: Set<string>,
  now: string,
): Promise<number> {
  if (seen.size === 0) return 0; // never prune-to-zero on an empty/failed fetch
  const existing = await collectConnectorKeys(db, m.table, m.naturalKey, connectorId);
  let count = 0;
  for (const key of existing) {
    if (!seen.has(key)) {
      await db.update(m.table, key, { deleted_at: now });
      // Drop edges originating from the now-hidden row (bounded to pruned keys).
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "${EDGES_TABLE}" WHERE src_table = ? AND src_id = ?`,
        [m.table, key],
      );
      count++;
    }
  }
  return count;
}

/**
 * Collect all natural keys for a connector's rows in a table, paged + projected
 * to the single key column (bounded reads — never a full-row table scan). Shared
 * by the sync prune pass and the disconnect teardown.
 */
export async function collectConnectorKeys(
  db: Lattice,
  table: string,
  keyColumn: string,
  connectorId: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.queryPage(table, {
      // LIVE rows only: a soft-deleted key must not count as "existing" for the
      // prune diff, nor as a parent to re-fetch children for.
      filters: [
        { col: '_source_connector_id', op: 'eq', val: connectorId },
        { col: 'deleted_at', op: 'isNull' },
      ],
      projection: [keyColumn],
      orderBy: keyColumn,
      limit: KEY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const r of page.rows) {
      const v = r[keyColumn];
      if (v != null) keys.push(String(v as string | number));
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return keys;
}

/** Sync only if the connector hasn't synced within `maxAgeMs`. Returns null if fresh. */
export async function syncIfStale(
  db: Lattice,
  connector: Connector,
  connectorId: string,
  maxAgeMs: number = DEFAULT_STALE_MS,
): Promise<SyncConnectorResult | null> {
  const record = await getConnector(db, connectorId);
  if (!record || record.status === 'disconnected') return null;
  if (record.lastSyncAt) {
    const age = Date.now() - Date.parse(record.lastSyncAt);
    if (age >= 0 && age < maxAgeMs) return null; // still fresh
  }
  return syncConnector(db, connector, connectorId);
}

/** Outcome of a batch stale-sync: the connectors that synced + the ones that failed. */
export interface SyncStaleResult {
  synced: SyncConnectorResult[];
  failed: { connectorId: string; error: string }[];
}

/**
 * Sync every stale connector served by this connector implementation. The GUI
 * calls this on load so connected data refreshes hourly without a scheduler.
 *
 * Per-connector failures are ISOLATED: one connector with a broken/expired
 * connection records its error (via syncConnector's recordSync) and is reported
 * in `failed`, but never blocks the refresh of the member's other connectors.
 */
export async function syncStaleConnectors(
  db: Lattice,
  connector: Connector,
  maxAgeMs: number = DEFAULT_STALE_MS,
): Promise<SyncStaleResult> {
  const all = await listConnectors(db);
  const synced: SyncConnectorResult[] = [];
  const failed: { connectorId: string; error: string }[] = [];
  for (const rec of all) {
    if (rec.connector !== connector.connector || rec.status === 'disconnected') continue;
    try {
      const r = await syncIfStale(db, connector, rec.id, maxAgeMs);
      if (r) synced.push(r);
    } catch (err) {
      failed.push({ connectorId: rec.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { synced, failed };
}
