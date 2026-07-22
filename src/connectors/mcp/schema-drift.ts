/**
 * Schema-drift reconciliation — the "adapt when the server changes its config" layer.
 *
 * On each sync/refresh the connector re-discovers the live server into a fresh descriptor; this
 * module diffs it against the persisted one and applies the delta ADDITIVELY and NON-DESTRUCTIVELY:
 *  - a NEW kind → create its table (+ RLS).
 *  - a NEW column on an existing kind → add it (dialect-safe), existing rows get NULL.
 *  - a VANISHED kind → mark it `retired` and KEEP its table + rows (writes stop); never dropped.
 *  - an existing column's type is FROZEN (never re-typed); the natural key (PK) is frozen at create.
 *  - a provisional kind whose schema is later declared → PROMOTED to contractual in place.
 *
 * The diff/merge are pure; only {@link applyDescriptorDiff}/{@link reconcileMcpSchema} touch the DB.
 */

import type { Lattice } from '../../lattice.js';
import type { TableDefinition } from '../../types.js';
import type { Connector } from '../types.js';
import { enableConnectorRls } from '../acl.js';
import {
  setMcpSchemaDescriptor,
  buildMcpModelDefs,
  type McpColumnDesc,
  type McpKindDesc,
  type McpSchemaDescriptor,
} from './schema-cache.js';

export interface SchemaDiff {
  /** Kind slugs present in the live server but not the persisted descriptor. */
  addedKinds: string[];
  /** Existing kinds that gained columns and/or were promoted provisional→contractual. */
  changedKinds: { kind: string; addedColumns: McpColumnDesc[]; promoted: boolean }[];
  /** Kind slugs in the persisted descriptor that vanished from the live server (frozen, not dropped). */
  retiredKinds: string[];
}

/** Diff a freshly-discovered descriptor against the persisted one. Pure. */
export function diffDescriptor(prev: McpSchemaDescriptor, next: McpSchemaDescriptor): SchemaDiff {
  const prevByKind = new Map(prev.kinds.map((k) => [k.kind, k]));
  const nextByKind = new Map(next.kinds.map((k) => [k.kind, k]));
  const addedKinds = next.kinds.filter((k) => !prevByKind.has(k.kind)).map((k) => k.kind);
  const retiredKinds = prev.kinds
    .filter((k) => !nextByKind.has(k.kind) && !k.retired)
    .map((k) => k.kind);
  const changedKinds: SchemaDiff['changedKinds'] = [];
  for (const nk of next.kinds) {
    const pk = prevByKind.get(nk.kind);
    if (!pk) continue;
    const have = new Set(pk.columns.map((c) => c.name));
    const addedColumns = nk.columns.filter((c) => !have.has(c.name));
    const promoted = pk.provenance !== 'contractual' && nk.provenance === 'contractual';
    if (addedColumns.length > 0 || promoted) {
      changedKinds.push({ kind: nk.kind, addedColumns, promoted });
    }
  }
  return { addedKinds, changedKinds, retiredKinds };
}

/**
 * Merge `next` into `prev` non-destructively, producing the descriptor to persist. Preserves prev's
 * kind order; freezes each existing kind's natural key + existing column types; adds new columns;
 * adopts a contractual promotion; marks a vanished kind `retired` (keeping it); appends new kinds.
 */
export function mergeDescriptor(
  prev: McpSchemaDescriptor,
  next: McpSchemaDescriptor,
  diff: SchemaDiff,
): McpSchemaDescriptor {
  const nextByKind = new Map(next.kinds.map((k) => [k.kind, k]));
  const retired = new Set(diff.retiredKinds);
  const changed = new Map(diff.changedKinds.map((c) => [c.kind, c]));
  const kinds: McpKindDesc[] = [];
  for (const pk of prev.kinds) {
    if (retired.has(pk.kind)) {
      kinds.push({ ...pk, retired: true });
      continue;
    }
    const ch = changed.get(pk.kind);
    const nk = nextByKind.get(pk.kind);
    if (ch && nk) {
      const have = new Set(pk.columns.map((c) => c.name));
      const mergedCols = [...pk.columns, ...ch.addedColumns.filter((c) => !have.has(c.name))];
      kinds.push({
        ...nk,
        naturalKey: pk.naturalKey, // PK frozen at first create
        columns: mergedCols, // existing column specs preserved (never re-typed)
        provenance: ch.promoted ? 'contractual' : (nk.provenance ?? pk.provenance ?? 'provisional'),
      });
    } else {
      kinds.push(pk); // unchanged
    }
  }
  const prevKinds = new Set(prev.kinds.map((k) => k.kind));
  for (const nk of next.kinds) if (!prevKinds.has(nk.kind)) kinds.push(nk); // append new (order kept)
  return {
    version: 2,
    prefix: prev.prefix,
    kinds,
    ...(next.unresolved ? { unresolved: next.unresolved } : {}),
    ...(next.introspectedAt ? { introspectedAt: next.introspectedAt } : {}),
  };
}

/**
 * Add missing columns to a live table on either dialect. `defineLate` early-returns for a
 * registered table (never adds columns to a live one), so unregister first: the re-`defineLate`
 * then runs the schema apply → `_addMissingColumns`, the ONLY dialect-idempotent ADD COLUMN path
 * (SQLite diff-then-ADD; Postgres ADD COLUMN IF NOT EXISTS). Rows are preserved. Do NOT "simplify"
 * this to a bare `defineLate` — its early-return would silently no-op the column add.
 */
async function reconcileLate(db: Lattice, table: string, def: TableDefinition): Promise<void> {
  db.unregisterTable(table);
  await db.defineLate(table, def);
}

/** Apply a diff to the DB: create added tables (+RLS), add columns to changed ones. Retired kinds
 *  keep their table + rows (no DDL, no delete). Must run AFTER the merged descriptor is persisted. */
export async function applyDescriptorDiff(
  db: Lattice,
  connector: Connector,
  connectionId: string,
  toolkit: string,
  merged: McpSchemaDescriptor,
  diff: SchemaDiff,
): Promise<void> {
  const models = buildMcpModelDefs(connectionId, merged);
  const byModel = new Map(models.map((m) => [m.model, m]));
  for (const kindName of diff.addedKinds) {
    const m = byModel.get(kindName);
    if (m) await db.defineLate(m.table, m.definition);
  }
  for (const ch of diff.changedKinds) {
    if (ch.addedColumns.length === 0) continue; // a promotion-only change needs no DDL
    const m = byModel.get(ch.kind);
    if (m) await reconcileLate(db, m.table, m.definition);
  }
  // A new table needs RLS + default visibility + ownership backfill or a cloud member's rows go
  // dark / un-resyncable. Idempotent across all models; only run when a table was actually added.
  if (diff.addedKinds.length > 0) await enableConnectorRls(db, connector, toolkit);
}

/**
 * Reconcile a connection's persisted schema against a freshly-discovered one: diff, and if anything
 * changed, persist the merged descriptor FIRST (so `models()`/`enableConnectorRls` see the new set)
 * then apply the DB migrations. Returns the diff, or null when nothing structural changed.
 */
export async function reconcileMcpSchema(
  db: Lattice,
  connector: Connector,
  connectionId: string,
  toolkit: string,
  prev: McpSchemaDescriptor,
  next: McpSchemaDescriptor,
): Promise<SchemaDiff | null> {
  const diff = diffDescriptor(prev, next);
  const nothing =
    diff.addedKinds.length === 0 &&
    diff.changedKinds.length === 0 &&
    diff.retiredKinds.length === 0;
  if (nothing) {
    // No structural change — still advance the introspection timestamp so the gate moves forward.
    if (next.introspectedAt) {
      setMcpSchemaDescriptor(connectionId, { ...prev, introspectedAt: next.introspectedAt });
    }
    return null;
  }
  const merged = mergeDescriptor(prev, next, diff);
  setMcpSchemaDescriptor(connectionId, merged);
  await applyDescriptorDiff(db, connector, connectionId, toolkit, merged, diff);
  return diff;
}
