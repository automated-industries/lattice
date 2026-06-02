import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { FeedBus, type FeedOp, type FeedSource } from './feed.js';
import { appendChangeEnvelope } from '../teams/team-core.js';

/**
 * Shared GUI mutation primitives. The HTTP row-CRUD routes write through these
 * functions, so every mutation — whoever triggered it — appends the same
 * audit-log entry AND publishes the same feed event. This is the single
 * chokepoint that guarantees the sidebar activity feed (and undo/redo) sees
 * every change.
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
 * Filters selecting THIS session's audit entries. Undo/redo (and the
 * redo-stack purge on a new mutation) are session-scoped so you only step
 * through your OWN recent actions, not another cloud user's edits. A missing
 * sessionId (non-GUI callers) falls back to the whole log.
 */
function sessionUndoneFilters(undone: 0 | 1, sessionId?: string) {
  const filters: { col: string; op: 'eq'; val: string | number }[] = [
    { col: 'undone', op: 'eq', val: undone },
  ];
  if (sessionId) filters.push({ col: 'session_id', op: 'eq', val: sessionId });
  return filters;
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
  sessionId?: string,
): Promise<void> {
  // Purge THIS session's redo stack (a new edit invalidates pending redos).
  const undone = (await db.query('_lattice_gui_audit', {
    filters: sessionUndoneFilters(1, sessionId),
  })) as { id: string }[];
  for (const r of undone) await db.delete('_lattice_gui_audit', r.id);
  await db.insert('_lattice_gui_audit', {
    id: crypto.randomUUID(),
    // Set ts explicitly (don't rely on the column DEFAULT — it uses the
    // SQLite-only `strftime(...)`, which doesn't yield a parseable ISO string
    // on Postgres, so cloud history rendered "Invalid Date"). Mirrors the
    // explicit `client_ts` below; adapter-agnostic.
    ts: new Date().toISOString(),
    table_name: table,
    row_id: rowId,
    operation: op,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    undone: 0,
    session_id: sessionId ?? null,
  });
  feed.publish({ table, op: op as FeedOp, rowId, source, summary: feedSummary(op, table) });
}

/** All schema-op operation strings carry this prefix (see recordSchemaAudit). */
export const SCHEMA_OP_PREFIX = 'schema.';

/** True if an audit-entry operation is a schema/data-model op (vs a row op). */
export function isSchemaOp(operation: string): boolean {
  return operation.startsWith(SCHEMA_OP_PREFIX);
}

/**
 * Append a SCHEMA/data-model change to the same `_lattice_gui_audit` history as
 * row edits, and publish it to the activity feed. `operation` is a `schema.*`
 * string (e.g. `schema.delete_entity`); `before`/`after` carry only small
 * config metadata (never row data — deletes are soft, so data is never
 * removed). The actual inverse/forward of a schema op is performed by the
 * server's MutationCtx.applySchemaInverse/Forward callbacks (which have config
 * + openConfig access). `row_id` is null for schema ops.
 */
export async function recordSchemaAudit(
  db: Lattice,
  feed: FeedBus,
  table: string,
  operation: string,
  before: unknown,
  after: unknown,
  summary: string,
  source: FeedSource = 'gui',
  sessionId?: string,
): Promise<void> {
  const undone = (await db.query('_lattice_gui_audit', {
    filters: sessionUndoneFilters(1, sessionId),
  })) as { id: string }[];
  for (const r of undone) await db.delete('_lattice_gui_audit', r.id);
  await db.insert('_lattice_gui_audit', {
    id: crypto.randomUUID(),
    // Explicit ISO ts — see appendAudit (the SQLite-only strftime DEFAULT
    // rendered "Invalid Date" on the Postgres/cloud path).
    ts: new Date().toISOString(),
    table_name: table,
    row_id: null,
    operation,
    before_json: before === null || before === undefined ? null : JSON.stringify(before),
    after_json: after === null || after === undefined ? null : JSON.stringify(after),
    undone: 0,
    session_id: sessionId ?? null,
  });
  feed.publish({ table, op: 'schema', rowId: null, source, summary });
}

/** Context shared by every mutation primitive. */
export interface MutationCtx {
  db: Lattice;
  feed: FeedBus;
  /** Tables that carry a `deleted_at` column (soft-delete eligible). */
  softDeletable: Set<string>;
  /** Who triggered the mutation — drives the feed source pill. */
  source: FeedSource;
  /**
   * The GUI session (one per server process) recorded on each audit entry so
   * undo/redo can be scoped to this session's own actions. Undefined for
   * non-GUI callers (undo/redo then falls back to the whole log).
   */
  sessionId?: string | undefined;
  /**
   * Team-cloud context. When set, every row mutation also appends a
   * `__lattice_change_log` envelope so the Postgres NOTIFY trigger fires and
   * OTHER clients (and this one's "last edited by" / flash UI) learn of the
   * change. Null/undefined on local SQLite (no broker, single writer).
   */
  team?: { teamId: string; myUserId: string } | null;
  /**
   * The originating client's edit time (ISO-8601), recorded on the change
   * envelope. Set by the offline-replay path from the X-Lattice-Client-Ts
   * header so replayed edits keep their true order; defaults to now.
   */
  clientTs?: string | undefined;
  /**
   * Client idempotency key for the originating edit (offline-replay safe).
   * Recorded on the change envelope so a re-sent edit is a no-op.
   */
  editId?: string | undefined;
  /**
   * Schema-op revert hooks. Row inverse/forward is pure-DB (applyInverse/
   * applyForward below), but reverting a SCHEMA op needs config-doc + openConfig
   * access that lives in the server. The server supplies these closures (over
   * its reassignable `active`) when handling undo/redo/revert; applyInverse/
   * applyForward delegate to them for `schema.*` entries. Absent for plain row
   * mutations — a schema entry encountered without them throws (the fail-loudly rule).
   */
  applySchemaInverse?: (entry: AuditEntry) => Promise<void>;
  applySchemaForward?: (entry: AuditEntry) => Promise<void>;
}

/**
 * Append a row-level change envelope to the cloud change-log when the active
 * DB is a team cloud. No-op on local SQLite. `op` is 'upsert' for
 * insert/update and 'delete' for removals; `after` is the post-image (null on
 * delete) so the change-log doubles as a recoverable per-row version history.
 */
async function emitTeamEnvelope(
  ctx: MutationCtx,
  table: string,
  pk: string | null,
  op: 'upsert' | 'delete',
  after: unknown,
): Promise<void> {
  if (!ctx.team) return;
  await appendChangeEnvelope(ctx.db, {
    team_id: ctx.team.teamId,
    table_name: table,
    pk,
    op,
    payload_json: after ? JSON.stringify(after) : null,
    owner_user_id: ctx.team.myUserId,
    client_ts: ctx.clientTs ?? new Date().toISOString(),
    edit_id: ctx.editId ?? null,
  });
}

export async function createRow(
  ctx: MutationCtx,
  table: string,
  values: Row,
): Promise<{ id: string; row: Row | null }> {
  const id = await ctx.db.insert(table, values);
  const row = await ctx.db.get(table, id);
  await appendAudit(ctx.db, ctx.feed, table, id, 'insert', null, row, ctx.source, ctx.sessionId);
  await emitTeamEnvelope(ctx, table, id, 'upsert', row);
  return { id, row };
}

/**
 * True when a stored cell value already equals a requested (JSON) value,
 * tolerating the type coercion the DB applies (boolean ↔ 0/1, number ↔ numeric
 * string, null ↔ ''). Used to decide whether an update actually requested a
 * change, so the write-landed guard never false-positives on a no-op edit.
 */
function storedValueMatches(stored: unknown, requested: unknown): boolean {
  if (stored === requested) return true;
  const storedEmpty = stored === null || stored === undefined || stored === '';
  const reqEmpty = requested === null || requested === undefined || requested === '';
  if (storedEmpty && reqEmpty) return true;
  if (typeof requested === 'boolean') return Number(stored) === Number(requested);
  if (typeof requested === 'number') return Number(stored) === requested;
  return String(stored) === String(requested);
}

/** Shallow byte-identical comparison of two rows (same column set from db.get). */
function rowsEqual(a: Row, b: Row): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
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
  // the fail-loudly rule: a requested change that left the row byte-identical means the
  // write did not land (a read-only data source silently no-ops the UPDATE).
  // Surface it loudly instead of reporting a phantom success. A genuine no-op
  // (the new value already equals the stored value) is NOT an error.
  if (before != null && after != null) {
    const wantedChange = Object.keys(values).some(
      (k) => !storedValueMatches(before[k], (values as Row)[k]),
    );
    if (wantedChange && rowsEqual(before, after)) {
      throw new Error('Row update did not persist — the data source may be read-only');
    }
  }
  await appendAudit(
    ctx.db,
    ctx.feed,
    table,
    id,
    'update',
    before,
    after,
    ctx.source,
    ctx.sessionId,
  );
  await emitTeamEnvelope(ctx, table, id, 'upsert', after);
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
    await appendAudit(
      ctx.db,
      ctx.feed,
      table,
      id,
      'update',
      before,
      after,
      ctx.source,
      ctx.sessionId,
    );
    // A soft-delete is a row UPDATE (deleted_at set) — the post-image carries
    // the tombstone, so emit an upsert envelope, not a delete.
    await emitTeamEnvelope(ctx, table, id, 'upsert', after);
  } else {
    await ctx.db.delete(table, id);
    await appendAudit(
      ctx.db,
      ctx.feed,
      table,
      id,
      'delete',
      before,
      null,
      ctx.source,
      ctx.sessionId,
    );
    await emitTeamEnvelope(ctx, table, id, 'delete', null);
  }
}

export async function linkRows(ctx: MutationCtx, table: string, body: Row): Promise<void> {
  await ctx.db.link(table, body);
  await appendAudit(ctx.db, ctx.feed, table, null, 'link', null, body, ctx.source, ctx.sessionId);
}

export async function unlinkRows(ctx: MutationCtx, table: string, body: Row): Promise<void> {
  await ctx.db.unlink(table, body);
  await appendAudit(ctx.db, ctx.feed, table, null, 'unlink', body, null, ctx.source, ctx.sessionId);
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
  /** A row AuditOp (insert|update|delete|link|unlink) OR a `schema.*` op. */
  operation: string;
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
    operation: String(row.operation),
    before_json: str(row.before_json),
    after_json: str(row.after_json),
    undone: Number(row.undone),
  };
}

async function applyInverse(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  if (isSchemaOp(entry.operation)) {
    if (!ctx.applySchemaInverse) {
      throw new Error(`Cannot revert schema op "${entry.operation}": no schema handler in context`);
    }
    await ctx.applySchemaInverse(entry);
    return;
  }
  const db = ctx.db;
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

async function applyForward(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  if (isSchemaOp(entry.operation)) {
    if (!ctx.applySchemaForward) {
      throw new Error(`Cannot redo schema op "${entry.operation}": no schema handler in context`);
    }
    await ctx.applySchemaForward(entry);
    return;
  }
  const db = ctx.db;
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

async function liveAudit(db: Lattice, undone: 0 | 1, sessionId?: string): Promise<AuditEntry[]> {
  return (
    (await db.query('_lattice_gui_audit', {
      filters: sessionUndoneFilters(undone, sessionId),
    })) as Record<string, unknown>[]
  ).map(parseAudit);
}

/** A readable feed line for an undo/redo/revert of a row or schema op. */
function reverseSummary(verb: 'Undid' | 'Redid' | 'Reverted', entry: AuditEntry): string {
  if (isSchemaOp(entry.operation)) {
    const what = entry.operation.slice(SCHEMA_OP_PREFIX.length).replace(/_/g, ' ');
    return `${verb} schema change (${what}) on ${entry.table_name}`;
  }
  return `${verb} ${entry.operation} on ${entry.table_name}`;
}

/** Undo this session's most recent live mutation. Returns the reverted entry, or null. */
export async function undoLast(ctx: MutationCtx): Promise<AuditEntry | null> {
  const target = (await liveAudit(ctx.db, 0, ctx.sessionId)).sort((a, b) =>
    b.ts.localeCompare(a.ts),
  )[0];
  if (!target) return null;
  await applyInverse(ctx, target);
  await ctx.db.update('_lattice_gui_audit', target.id, { undone: 1 });
  ctx.feed.publish({
    table: target.table_name,
    op: 'undo',
    rowId: target.row_id,
    source: ctx.source,
    summary: reverseSummary('Undid', target),
  });
  return target;
}

/** Redo this session's oldest undone mutation. Returns the re-applied entry, or null. */
export async function redoLast(ctx: MutationCtx): Promise<AuditEntry | null> {
  const target = (await liveAudit(ctx.db, 1, ctx.sessionId)).sort((a, b) =>
    a.ts.localeCompare(b.ts),
  )[0];
  if (!target) return null;
  await applyForward(ctx, target);
  await ctx.db.update('_lattice_gui_audit', target.id, { undone: 0 });
  ctx.feed.publish({
    table: target.table_name,
    op: 'redo',
    rowId: target.row_id,
    source: ctx.source,
    summary: reverseSummary('Redid', target),
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
  // applyInverse runs first; only if it succeeds do we flip `undone`. A schema
  // revert that throws (e.g. purged, or a name collision) leaves the entry
  // Revertable and surfaces the error to the caller (the fail-loudly rule).
  await applyInverse(ctx, entry);
  await ctx.db.update('_lattice_gui_audit', id, { undone: 1 });
  ctx.feed.publish({
    table: entry.table_name,
    op: 'undo',
    rowId: entry.row_id,
    source: ctx.source,
    summary: reverseSummary('Reverted', entry),
  });
  return { ok: true, entry };
}
