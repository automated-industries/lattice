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
  const row = (await ctx.db.get(table, id)) as Row | null;
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
  const after = (await ctx.db.get(table, id)) as Row | null;
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
