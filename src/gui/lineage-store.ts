import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';

/**
 * Internal table recording cross-tier DATA LINEAGE — the durable "object row X
 * was extracted-from / materialized-from / observed-by source Y" edges that are
 * not derivable from existing substrates. (Connector lineage already lives on
 * the synced rows themselves via `_source_connector_id`; file-extraction and
 * import-materialization have no other home.)
 *
 * Managed via RAW DDL + raw SQL (NOT `db.define`), exactly like
 * `__lattice_connectors` / `_lattice_embeddings`: an unregistered `__lattice_`
 * bookkeeping table so the renderer never scans it (a registered table would be
 * walked by `db.render()` and fail with "permission denied" on a cloud-member
 * render) and the Objects list / brain graph / cloud-member grants ignore it by
 * prefix. `created_at` carries NO SQL DEFAULT (the SQLite-only `strftime(...)`
 * default is non-parseable on Postgres) — every writer supplies an explicit ISO
 * string, keeping the CREATE byte-identical across dialects.
 */
export const LINEAGE_TABLE = '__lattice_lineage';

/** Create the lineage table + its two bounded-read indexes. Idempotent. */
export async function ensureLineageTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${LINEAGE_TABLE}" (
       "id"           TEXT PRIMARY KEY,
       "object_table" TEXT NOT NULL,
       "object_id"    TEXT NOT NULL,
       "source_kind"  TEXT NOT NULL,
       "source_table" TEXT,
       "source_id"    TEXT,
       "tier"         TEXT NOT NULL,
       "relation"     TEXT,
       "detail_json"  TEXT,
       "created_at"   TEXT NOT NULL
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE INDEX IF NOT EXISTS "${LINEAGE_TABLE}_object_idx" ON "${LINEAGE_TABLE}" ("object_table", "object_id")`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE INDEX IF NOT EXISTS "${LINEAGE_TABLE}_table_kind_idx" ON "${LINEAGE_TABLE}" ("object_table", "source_kind")`,
  );
  // One-time relabel of historical import edges: imported tables used to be
  // recorded under tier 'computed'; that tier is now reserved for computed
  // tables (live read-only SQL projections) and imports carry tier 'derived'.
  // Rewriting the old rows here matters because `recordLineage`'s dedup tuple
  // includes `tier` — without the relabel, re-importing the same table would
  // insert a duplicate edge under the new label instead of matching the old
  // one. Idempotent: once relabeled, the WHERE clause matches nothing.
  await runAsyncOrSync(
    adapter,
    `UPDATE "${LINEAGE_TABLE}" SET "tier" = 'derived' WHERE "source_kind" = 'import' AND "tier" = 'computed'`,
  );
}

export interface LineageEdge {
  /** Downstream object table. */
  objectTable: string;
  /** Object row id, or `'*'` for table-level lineage (e.g. a bulk import). */
  objectId: string;
  /** file | connector | import | artifact | observation | table | sql_source | calculation */
  sourceKind: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  /** raw | derived | computed | observation */
  tier: string;
  relation: string;
  detailJson?: string | null;
}

/**
 * Record lineage edges. Best-effort + self-ensuring: creates the table if absent
 * so it works on any Lattice (GUI lifecycle, import, ingest) regardless of prior
 * setup. `id`/`created_at` are stamped here.
 */
export async function recordLineage(adapter: StorageAdapter, edges: LineageEdge[]): Promise<void> {
  if (!edges.length) return;
  await ensureLineageTable(adapter);
  const now = new Date().toISOString();
  for (const e of edges) {
    // Dedup: an edge is identified by its (object, source, tier, relation) tuple —
    // NOT by the random id/timestamp. Re-recording the same edge (e.g. re-importing
    // a table re-writes its table-level `*` edge) must NOT accumulate duplicate rows,
    // which previously inflated the provenance "Import" count by 1 per re-import.
    // COALESCE normalizes the nullable source_table/source_id for the comparison.
    const dup = await getAsyncOrSync(
      adapter,
      `SELECT 1 AS x FROM "${LINEAGE_TABLE}"
         WHERE "object_table" = ? AND "object_id" = ? AND "source_kind" = ? AND "tier" = ?
           AND COALESCE("relation",'') = COALESCE(?,'')
           AND COALESCE("source_table",'') = COALESCE(?,'')
           AND COALESCE("source_id",'') = COALESCE(?,'')
         LIMIT 1`,
      [
        e.objectTable,
        e.objectId,
        e.sourceKind,
        e.tier,
        e.relation,
        e.sourceTable ?? null,
        e.sourceId ?? null,
      ],
    );
    if (dup) continue;
    await runAsyncOrSync(
      adapter,
      `INSERT INTO "${LINEAGE_TABLE}"
         ("id","object_table","object_id","source_kind","source_table","source_id","tier","relation","detail_json","created_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        e.objectTable,
        e.objectId,
        e.sourceKind,
        e.sourceTable ?? null,
        e.sourceId ?? null,
        e.tier,
        e.relation,
        e.detailJson ?? null,
        now,
      ],
    );
  }
}
