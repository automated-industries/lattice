import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { FeedBus, type FeedOp, type FeedSource } from './ai/feed.js';

/**
 * Shared GUI mutation primitives. Both the HTTP row-CRUD routes and the AI
 * tool dispatcher write through these functions, so every mutation — whoever
 * triggered it — appends the same audit-log entry AND publishes the same feed
 * event. This is the single chokepoint that guarantees the sidebar activity
 * feed (and undo/redo) sees every change.
 */

export type AuditOp = 'insert' | 'update' | 'delete' | 'link' | 'unlink';

function feedSummary(op: AuditOp, table: string): string {
  switch (op) {
    case 'insert':
      return `Added a row to ${table}`;
    case 'update':
      return `Updated a row in ${table}`;
    case 'delete':
      return `Removed a row from ${table}`;
    case 'link':
      return `Linked rows in ${table}`;
    case 'unlink':
      return `Unlinked rows in ${table}`;
  }
}

/**
 * Append an audit-log entry for a mutation and publish it to the activity
 * feed. `source` tags who triggered it (defaults to the GUI). AuditOp is a
 * subset of FeedOp, so the cast is safe.
 */
export async function appendAudit(
  db: Lattice,
  feed: FeedBus,
  table: string,
  rowId: string | null,
  op: AuditOp,
  before: unknown,
  after: unknown,
  source: FeedSource = 'gui',
): Promise<void> {
  const undone = (await db.query('_lattice_gui_audit', {
    filters: [{ col: 'undone', op: 'eq', val: 1 }],
  })) as { id: string }[];
  for (const r of undone) await db.delete('_lattice_gui_audit', r.id);
  await db.insert('_lattice_gui_audit', {
    id: crypto.randomUUID(),
    table_name: table,
    row_id: rowId,
    operation: op,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    undone: 0,
  });
  feed.publish({ table, op: op as FeedOp, rowId, source, summary: feedSummary(op, table) });
}

/** Context shared by every mutation primitive. */
export interface MutationCtx {
  db: Lattice;
  feed: FeedBus;
  /** Tables that carry a `deleted_at` column (soft-delete eligible). */
  softDeletable: Set<string>;
  /** Who triggered the mutation — drives the feed source pill. */
  source: FeedSource;
}

export async function createRow(
  ctx: MutationCtx,
  table: string,
  values: Row,
): Promise<{ id: string; row: Row | null }> {
  const id = await ctx.db.insert(table, values);
  const row = await ctx.db.get(table, id);
  await appendAudit(ctx.db, ctx.feed, table, id, 'insert', null, row, ctx.source);
  return { id, row };
}

export async function updateRow(
  ctx: MutationCtx,
  table: string,
  id: string,
  values: Partial<Row>,
): Promise<{ row: Row | null }> {
  const before = await ctx.db.get(table, id);
  await ctx.db.update(table, id, values);
  const after = await ctx.db.get(table, id);
  await appendAudit(ctx.db, ctx.feed, table, id, 'update', before, after, ctx.source);
  return { row: after };
}

export async function deleteRow(
  ctx: MutationCtx,
  table: string,
  id: string,
  hard: boolean,
): Promise<void> {
  const before = await ctx.db.get(table, id);
  if (!hard && ctx.softDeletable.has(table)) {
    await ctx.db.update(table, id, { deleted_at: new Date().toISOString() });
    const after = await ctx.db.get(table, id);
    await appendAudit(ctx.db, ctx.feed, table, id, 'update', before, after, ctx.source);
  } else {
    await ctx.db.delete(table, id);
    await appendAudit(ctx.db, ctx.feed, table, id, 'delete', before, null, ctx.source);
  }
}

export async function linkRows(ctx: MutationCtx, table: string, body: Row): Promise<void> {
  await ctx.db.link(table, body);
  await appendAudit(ctx.db, ctx.feed, table, null, 'link', null, body, ctx.source);
}

export async function unlinkRows(ctx: MutationCtx, table: string, body: Row): Promise<void> {
  await ctx.db.unlink(table, body);
  await appendAudit(ctx.db, ctx.feed, table, null, 'unlink', body, null, ctx.source);
}

// ── Undo / redo / revert ────────────────────────────────────────────────────
// These replay the inverse (or forward) of a recorded audit entry and flip its
// `undone` flag. They are NOT new mutations — they don't append a new audit
// entry — but they do publish a feed event so the sidebar reflects the change.

export interface AuditEntry {
  id: string;
  ts: string;
  table_name: string;
  row_id: string | null;
  operation: AuditOp;
  before_json: string | null;
  after_json: string | null;
  undone: number;
}

export function parseAudit(row: Record<string, unknown>): AuditEntry {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id: String(row.id),
    ts: String(row.ts),
    table_name: String(row.table_name),
    row_id: str(row.row_id),
    operation: row.operation as AuditOp,
    before_json: str(row.before_json),
    after_json: str(row.after_json),
    undone: Number(row.undone),
  };
}

async function applyInverse(db: Lattice, entry: AuditEntry): Promise<void> {
  const before = entry.before_json ? (JSON.parse(entry.before_json) as Row) : null;
  const after = entry.after_json ? (JSON.parse(entry.after_json) as Row) : null;
  switch (entry.operation) {
    case 'insert':
      if (entry.row_id) await db.delete(entry.table_name, entry.row_id);
      break;
    case 'update':
      if (entry.row_id && before) await db.update(entry.table_name, entry.row_id, before);
      break;
    case 'delete':
      if (before) await db.insert(entry.table_name, before);
      break;
    case 'link':
      if (after) await db.unlink(entry.table_name, after);
      break;
    case 'unlink':
      if (after) await db.link(entry.table_name, after);
      break;
  }
}

async function applyForward(db: Lattice, entry: AuditEntry): Promise<void> {
  const before = entry.before_json ? (JSON.parse(entry.before_json) as Row) : null;
  const after = entry.after_json ? (JSON.parse(entry.after_json) as Row) : null;
  switch (entry.operation) {
    case 'insert':
      if (after) await db.insert(entry.table_name, after);
      break;
    case 'update':
      if (entry.row_id && after) await db.update(entry.table_name, entry.row_id, after);
      break;
    case 'delete':
      if (entry.row_id) await db.delete(entry.table_name, entry.row_id);
      break;
    case 'link':
      if (after) await db.link(entry.table_name, after);
      break;
    case 'unlink':
      if (before) await db.unlink(entry.table_name, before);
      break;
  }
}

async function liveAudit(db: Lattice, undone: 0 | 1): Promise<AuditEntry[]> {
  return (
    (await db.query('_lattice_gui_audit', {
      filters: [{ col: 'undone', op: 'eq', val: undone }],
    })) as Record<string, unknown>[]
  ).map(parseAudit);
}

/** Undo the most recent live mutation. Returns the reverted entry, or null. */
export async function undoLast(ctx: MutationCtx): Promise<AuditEntry | null> {
  const target = (await liveAudit(ctx.db, 0)).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!target) return null;
  await applyInverse(ctx.db, target);
  await ctx.db.update('_lattice_gui_audit', target.id, { undone: 1 });
  ctx.feed.publish({
    table: target.table_name,
    op: 'undo',
    rowId: target.row_id,
    source: ctx.source,
    summary: `Undid ${target.operation} on ${target.table_name}`,
  });
  return target;
}

/** Redo the oldest undone mutation. Returns the re-applied entry, or null. */
export async function redoLast(ctx: MutationCtx): Promise<AuditEntry | null> {
  const target = (await liveAudit(ctx.db, 1)).sort((a, b) => a.ts.localeCompare(b.ts))[0];
  if (!target) return null;
  await applyForward(ctx.db, target);
  await ctx.db.update('_lattice_gui_audit', target.id, { undone: 0 });
  ctx.feed.publish({
    table: target.table_name,
    op: 'redo',
    rowId: target.row_id,
    source: ctx.source,
    summary: `Redid ${target.operation} on ${target.table_name}`,
  });
  return target;
}

export type RevertResult =
  | { ok: true; entry: AuditEntry }
  | { ok: false; reason: 'not_found' | 'already_undone' };

/** Revert one specific audit entry by id. */
export async function revertEntry(ctx: MutationCtx, id: string): Promise<RevertResult> {
  const row = (await ctx.db.get('_lattice_gui_audit', id)) as Record<string, unknown> | null;
  if (!row) return { ok: false, reason: 'not_found' };
  const entry = parseAudit(row);
  if (entry.undone === 1) return { ok: false, reason: 'already_undone' };
  await applyInverse(ctx.db, entry);
  await ctx.db.update('_lattice_gui_audit', id, { undone: 1 });
  ctx.feed.publish({
    table: entry.table_name,
    op: 'undo',
    rowId: entry.row_id,
    source: ctx.source,
    summary: `Reverted ${entry.operation} on ${entry.table_name}`,
  });
  return { ok: true, entry };
}
