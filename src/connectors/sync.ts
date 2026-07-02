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
import { addEdges, ensureEdgesTable } from '../search/graph.js';
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
  if (!record.connectionRef) {
    throw new Error(`Connector "${connectorId}" has no connection — authorize it first.`);
  }
  const { toolkit } = record;
  const ctxBase: Omit<ListChangesContext, 'parentKey'> = {
    connectionId: record.connectionRef,
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

  // The connector's last successful sync, used to bound incremental per-parent
  // fetches (e.g. only comments of issues changed since then).
  const prevSyncAt = record.lastSyncAt;

  // Open ONE shared connection resource (e.g. a single MCP transport) for the whole
  // sync, so listChanges reuses it across every model + parent key instead of
  // reconnecting per parent (the old N+1). No-op for connectors without the hook.
  await connector.beginSyncSession?.(ctxBase.connectionId);
  try {
    for (const m of models) {
      const { seen, edges, partial } = await syncModel(
        db,
        connector,
        toolkit,
        m,
        ctxBase,
        connectorId,
        now,
        prevSyncAt,
      );
      result.upserted[m.table] = seen.size;
      // Edges are derived inline from the rows just synced (bounded to what
      // changed) and batched — never a full-table re-scan of the connected table.
      if (edges.length > 0) {
        await addEdges(db.adapter, edges);
        result.edges += edges.length;
      }
      // Don't prune after an INCREMENTAL pass: `seen` then covers only the
      // re-fetched subset (e.g. changed issues' comments), so a prune would wrong-
      // ly soft-delete every child of an unchanged parent.
      if (pruneVanished && !partial) {
        result.softDeleted[m.table] = await pruneVanished_(db, m, connectorId, seen, now);
      }
    }
    await recordSync(db, connectorId, { ok: true, at: now });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSync(db, connectorId, { ok: false, error: message });
    throw err; // fail loudly — do not swallow an external-sync failure
  } finally {
    // Always close the shared transport — including after a failed sync.
    await connector.endSyncSession?.(ctxBase.connectionId);
  }
  return result;
}

/**
 * Sync one model. Returns the natural keys seen this pass, the edges to add, and
 * whether the pass was `partial` (an incremental per-parent fetch — only some
 * parents re-fetched), which suppresses pruning for that model.
 */
async function syncModel(
  db: Lattice,
  connector: Connector,
  toolkit: string,
  m: ConnectedModelDef,
  ctxBase: Omit<ListChangesContext, 'parentKey'>,
  connectorId: string,
  now: string,
  prevSyncAt: string | null,
): Promise<{ seen: Set<string>; edges: GraphEdge[]; partial: boolean }> {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  let partial = false;
  // Clear deleted_at so a previously soft-deleted natural key is RESURRECTED on
  // conflict when it reappears in the source (otherwise it would stay hidden).
  const stamp = (row: Row): Row => ({
    ...row,
    deleted_at: null,
    _source_connector_id: connectorId,
    _source_model: m.model,
    _source_synced_at: now,
  });

  // Namespace every connector key by the per-member connectorId, so two members
  // connecting the SAME external instance don't collide on the shared physical
  // PRIMARY KEY (which, under cloud FORCE-RLS, made the second syncer's upsert hit
  // the other member's RLS-hidden row and fail — a cross-member sync DoS). The PK
  // and every FK reference BETWEEN this connector's tables are prefixed uniformly.
  // connectorId is a UUID (no ':'), so the `<id>:` prefix is unambiguous.
  const nsKey = (k: string): string => `${connectorId}:${k}`;
  const stripNs = (k: string): string =>
    k.startsWith(`${connectorId}:`) ? k.slice(connectorId.length + 1) : k;
  // FK columns pointing at another of this connector's rows: the parent childColumn
  // + every graph-edge FK. Deduped so a column that is both (e.g. gmail_messages
  // thread_id) isn't prefixed twice.
  const fkCols = new Set<string>();
  if (m.parent) fkCols.add(m.parent.childColumn);
  for (const e of m.graphEdges ?? []) fkCols.add(e.fkColumn);

  const ingest = async (rec: { id: string; row: Row }, extra?: Row): Promise<void> => {
    const nsId = nsKey(rec.id);
    const row: Row = extra ? { ...rec.row, ...extra } : { ...rec.row };
    row[m.naturalKey] = nsId; // PK namespaced (also sets it when a map omitted it)
    // Every FK here is RAW (the map emits raw provider ids; the parent childColumn
    // is passed raw below), so namespace each once to point at the namespaced PK.
    for (const col of fkCols) {
      const v = row[col];
      if (v != null) row[col] = nsKey(String(v as string | number));
    }
    await db.upsert(m.table, stamp(row));
    seen.add(nsId);
    // Derive graph edges from this row's (now-namespaced) FK columns.
    for (const e of m.graphEdges ?? []) {
      const dst = row[e.fkColumn];
      if (dst != null) {
        edges.push({
          srcTable: m.table,
          srcId: nsId,
          dstTable: e.dstTable,
          dstId: String(dst as string | number),
          type: e.type,
        });
      }
    }
  };

  if (m.parent) {
    const parent = m.parent;
    // Incremental when the parent declares a timestamp column AND we've synced
    // before: only re-fetch children of parents changed since the last sync.
    const incremental = !!parent.incrementalColumn && !!prevSyncAt;
    partial = incremental;
    const parentKeys = incremental
      ? await collectChangedParentKeys(db, parent, connectorId, prevSyncAt)
      : await collectConnectorKeys(db, parent.table, parent.keyColumn, connectorId);
    for (const parentKey of parentKeys) {
      // collectConnectorKeys returns NAMESPACED parent PKs; the connector needs the
      // RAW provider key to query the source, so strip the prefix. ingest then
      // re-namespaces it into the child's childColumn FK.
      const rawParentKey = stripNs(parentKey);
      for await (const rec of connector.listChanges(toolkit, m.model, {
        ...ctxBase,
        parentKey: rawParentKey,
      })) {
        await ingest(rec, { [parent.childColumn]: rawParentKey });
      }
    }
  } else {
    for await (const rec of connector.listChanges(toolkit, m.model, ctxBase)) {
      await ingest(rec);
    }
  }
  return { seen, edges, partial };
}

/**
 * Live parent keys whose `incrementalColumn` timestamp advanced since
 * `prevSyncAt`. Compared via `Date.parse` (not SQL string compare) so mixed
 * ISO/offset timestamp formats are handled; a parent with a missing/unparseable
 * timestamp is included (fail-open — better a redundant fetch than a missed one).
 */
async function collectChangedParentKeys(
  db: Lattice,
  parent: NonNullable<ConnectedModelDef['parent']>,
  connectorId: string,
  prevSyncAt: string,
): Promise<string[]> {
  const incCol = parent.incrementalColumn;
  if (!incCol) return collectConnectorKeys(db, parent.table, parent.keyColumn, connectorId);
  const since = Date.parse(prevSyncAt);
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.queryPage(parent.table, {
      filters: [
        { col: '_source_connector_id', op: 'eq', val: connectorId },
        { col: 'deleted_at', op: 'isNull' },
      ],
      projection: [parent.keyColumn, incCol],
      orderBy: parent.keyColumn,
      limit: KEY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const r of page.rows) {
      const k = r[parent.keyColumn];
      if (k == null) continue;
      const ts = r[incCol];
      const tsMs = ts == null ? NaN : Date.parse(String(ts as string | number));
      if (Number.isNaN(since) || Number.isNaN(tsMs) || tsMs > since) {
        keys.push(String(k as string | number));
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return keys;
}

const EDGES_TABLE = '__lattice_edges';

/** Chunk size for the batched edge-delete IN(...) during prune (bounded params). */
const EDGE_DELETE_CHUNK = 500;

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
  const vanished = existing.filter((key) => !seen.has(key));
  if (vanished.length === 0) return 0;
  // Drop the pruned rows' derived graph edges FIRST, in chunked IN(...) batches.
  // Edges are derived + idempotent (no changelog), so a batched raw DELETE is safe
  // and turns per-row round-trips into ~one per 500 keys. Two invariants here:
  //  • ensureEdgesTable first — a workspace whose connectors emit no graphEdges
  //    (e.g. an external-DB source) has never created the table, so the raw DELETE
  //    would throw "no such table: __lattice_edges" and fail the whole sync.
  //  • Edge cleanup BEFORE the soft-delete transaction — the edge delete is safe
  //    to redo, the committed soft-delete is not; failing the redoable step first
  //    never strands rows already hidden by a commit when the sync errors out.
  await ensureEdgesTable(db.adapter);
  for (let i = 0; i < vanished.length; i += EDGE_DELETE_CHUNK) {
    const chunk = vanished.slice(i, i + EDGE_DELETE_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    await runAsyncOrSync(
      db.adapter,
      `DELETE FROM "${EDGES_TABLE}" WHERE src_table = ? AND src_id IN (${placeholders})`,
      [m.table, ...chunk],
    );
  }
  // Soft-delete via db.update (preserves the changelog entry + render hooks a raw
  // DELETE would skip), but batch every delete into ONE transaction so the whole
  // prune commits once instead of per row. On Postgres this collapses N commits to
  // one; on SQLite (no withClient) db.transaction runs inline — no regression.
  await db.transaction(async () => {
    for (const key of vanished) {
      await db.update(m.table, key, { deleted_at: now });
    }
  });
  return vanished.length;
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
 * Scope to the connecting member with `connectedBy` — each member syncs only
 * their OWN connectors (their session stamps row ownership; an owner must not
 * sync members' connectors as themselves). Per-connector failures are ISOLATED:
 * one broken connection records its error and is reported in `failed`, but never
 * blocks the refresh of the member's other connectors.
 */
export async function syncStaleConnectors(
  db: Lattice,
  connector: Connector,
  maxAgeMs: number = DEFAULT_STALE_MS,
  connectedBy?: string,
): Promise<SyncStaleResult> {
  const all = await listConnectors(db, connectedBy);
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
