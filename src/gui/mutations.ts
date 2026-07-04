import { createHash } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { FeedBus, type FeedOp, type FeedSource } from './feed.js';
import { cloudRlsInstalled } from '../framework/cloud-connect.js';
import { regenerateAudienceViewFromDb } from '../cloud/audience.js';

/**
 * Shared GUI mutation primitives. The HTTP row-CRUD routes write through these
 * functions, so every mutation — whoever triggered it — appends the same
 * audit-log entry AND publishes the same feed event. This is the single
 * chokepoint that guarantees the sidebar activity feed (and undo/redo) sees
 * every change.
 */

export type AuditOp = 'insert' | 'update' | 'delete' | 'link' | 'unlink';

/**
 * A short human label for a row, used in activity-feed summaries so a bubble
 * reads "Added Acme Consulting Agreement to consulting_agreements" instead of a
 * faceless "Added a row to …". Prefers the same title-ish columns the GUI's
 * card view (`fsDisplayName`) uses — so the feed and the object's card show the
 * same name — then falls back to a snippet of a body/description field. Returns
 * null when the row has no usable label (caller keeps the generic phrasing).
 */
export function rowLabel(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  const primary =
    str(r.name) || str(r.title) || str(r.label) || str(r.original_name) || str(r.subject);
  if (primary.trim()) return primary.trim().slice(0, 80);
  const secondary =
    str(r.summary) ||
    str(r.description) ||
    str(r.body) ||
    str(r.content) ||
    str(r.url) ||
    str(r.path);
  if (secondary.trim()) {
    const s = secondary.trim().replace(/\s+/g, ' ');
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  }
  // No conventional label column (e.g. an inferred entity keyed by
  // `invoice_number`): use the first meaningful cell value — skipping id /
  // timestamp / foreign-key columns — so the row still reads as something
  // human, not a bare `#id`. Object key order tracks column order.
  for (const [k, v] of Object.entries(r)) {
    if (k === 'id' || /_id$|_at$/.test(k)) continue;
    const s = str(v).trim();
    if (s) return s.replace(/\s+/g, ' ').slice(0, 80);
  }
  return null;
}

/**
 * One-line activity-feed summary for an op on a table. Handles the row `AuditOp`
 * set (live feed) AND the persisted `schema.*` audit operations (rail backfill)
 * — the single source of truth for both, so the live bubble and the
 * reloaded-from-audit bubble always read the same.
 */
export function feedSummary(op: string, table: string, row?: unknown): string {
  const label = rowLabel(row);
  switch (op) {
    case 'insert':
      return label ? `Added ${label} to ${table}` : `Added a row to ${table}`;
    case 'update':
      return label ? `Updated ${label} in ${table}` : `Updated a row in ${table}`;
    case 'delete':
      return label ? `Removed ${label} from ${table}` : `Removed a row from ${table}`;
    case 'link':
      return `Linked rows in ${table}`;
    case 'unlink':
      return `Unlinked rows in ${table}`;
    case 'schema.create_entity':
      return `Created table ${table}`;
    case 'schema.delete_entity':
      return `Deleted table ${table}`;
    case 'schema.rename_entity':
      return `Renamed table ${table}`;
    case 'schema.add_column':
      return `Added a column to ${table}`;
    case 'schema.rename_column':
      return `Renamed a column on ${table}`;
    case 'schema.add_link':
    case 'schema.create_junction':
      return `Added a link to ${table}`;
    case 'schema.delete_link':
      return `Deleted a link on ${table}`;
    case 'schema.create_computed':
      return `Created computed table ${table}`;
    case 'schema.update_computed':
      return `Updated computed table ${table}`;
    case 'schema.delete_computed':
      return `Deleted computed table ${table}`;
    case 'schema.refresh_computed':
      return `Refreshed computed table ${table}`;
    case 'schema.purge':
      return `Purged ${table}`;
    default:
      return `${op} on ${table}`;
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

/** Columns of a `_lattice_gui_audit` row, in insert order. */
const AUDIT_COLUMNS = [
  'id',
  'ts',
  'table_name',
  'row_id',
  'operation',
  'before_json',
  'after_json',
  'undone',
  'session_id',
  'source',
] as const;

/**
 * Build a fully-populated audit row. Shared by the high-level insert path and the
 * transactional hard-delete path so both record IDENTICAL columns. The explicit
 * `ts` (rather than the column DEFAULT) avoids the SQLite-only `strftime(...)`
 * default that yields a non-parseable timestamp on Postgres (cloud history then
 * rendered "Invalid Date"); the originating client's validated edit time is
 * honored when present (an offline edit replayed later records when it was MADE,
 * not when it synced), else now().
 */
function buildAuditRow(
  table: string,
  rowId: string | null,
  op: AuditOp,
  before: unknown,
  after: unknown,
  sessionId: string | undefined,
  editTs: string | undefined,
  source: FeedSource = 'gui',
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    ts: sanitizeEditTs(editTs) ?? new Date().toISOString(),
    table_name: table,
    row_id: rowId,
    operation: op,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    undone: 0,
    session_id: sessionId ?? null,
    source,
  };
}

/** Publish a mutation's feed event. Names the row in the bubble: insert/update
 *  read the post-image, delete the pre-image (the row is gone); link/unlink carry
 *  the junction body, which has no human label so feedSummary falls back to the
 *  generic phrasing. */
function publishMutationFeed(
  feed: FeedBus,
  table: string,
  rowId: string | null,
  op: AuditOp,
  before: unknown,
  after: unknown,
  source: FeedSource,
): void {
  const labelRow = op === 'delete' ? before : after;
  feed.publish({
    table,
    op: op as FeedOp,
    rowId,
    source,
    summary: feedSummary(op, table, labelRow),
  });
}

/**
 * Purge THIS session's redo stack (a new edit invalidates pending redos). The
 * DELETEs hit the session's own undone entries, which the connected member can
 * already see (RLS scopes the audit log by row visibility / NULL row_id), so the
 * member's `SELECT, INSERT, UPDATE, DELETE` grant + the audit table's per-op
 * DELETE policy permit them.
 */
async function purgeRedoStack(db: Lattice, sessionId?: string): Promise<void> {
  const undone = (await db.query('_lattice_gui_audit', {
    filters: sessionUndoneFilters(1, sessionId),
  })) as { id: string }[];
  for (const r of undone) await db.delete('_lattice_gui_audit', r.id);
}

/**
 * A schema change one or more dashboards may be consuming. Fired from
 * {@link recordSchemaAudit} for the BREAKING operations (rename/delete of
 * tables, columns, links) — additive changes can't break an authored page.
 */
export interface SchemaChangeEvent {
  table: string;
  operation: string;
  before: unknown;
  after: unknown;
  summary: string;
}

/** Schema ops that can break a page authored against the previous model. */
const BREAKING_SCHEMA_OPS = new Set([
  'schema.rename_entity',
  'schema.rename_column',
  'schema.delete_entity',
  'schema.delete_link',
  'schema.purge',
]);

// Per-Lattice schema-change listener (the dashboard auto-repair service).
// A WeakMap registration — not an import — so this shared mutation module
// never depends on the repair module (which pulls in the model client).
const schemaChangeListeners = new WeakMap<Lattice, (ev: SchemaChangeEvent) => void>();

/** Install (or replace) the workspace's schema-change listener. */
export function setSchemaChangeListener(
  db: Lattice,
  listener: ((ev: SchemaChangeEvent) => void) | null,
): void {
  if (listener) schemaChangeListeners.set(db, listener);
  else schemaChangeListeners.delete(db);
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
  editTs?: string,
): Promise<void> {
  await purgeRedoStack(db, sessionId);
  await db.insert(
    '_lattice_gui_audit',
    buildAuditRow(table, rowId, op, before, after, sessionId, editTs, source),
  );
  publishMutationFeed(feed, table, rowId, op, before, after, source);
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
  await purgeRedoStack(db, sessionId);
  await db.insert('_lattice_gui_audit', {
    id: crypto.randomUUID(),
    // Explicit ISO ts — see buildAuditRow (the SQLite-only strftime DEFAULT
    // rendered "Invalid Date" on the Postgres/cloud path).
    ts: new Date().toISOString(),
    table_name: table,
    row_id: null,
    operation,
    before_json: before === null || before === undefined ? null : JSON.stringify(before),
    after_json: after === null || after === undefined ? null : JSON.stringify(after),
    undone: 0,
    session_id: sessionId ?? null,
    source,
  });
  feed.publish({ table, op: 'schema', rowId: null, source, summary });
  // A breaking model change may orphan dashboards built on this table — hand
  // it to the workspace's repair listener (fire-and-forget; the listener
  // debounces and does its own error surfacing).
  if (BREAKING_SCHEMA_OPS.has(operation)) {
    const listener = schemaChangeListeners.get(db);
    if (listener) listener({ table, operation, before, after, summary });
  }
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
   * Fired (un-awaited) by {@link announceAddedColumns} whenever a write
   * auto-adds columns — the single chokepoint for manual, ingest, and AI
   * writes. The server attaches a fail-silent closure that generates column
   * definitions via a cheap model. Kept off `mutations` itself so this module
   * stays AI-free; absent ⇒ no auto-generation.
   */
  onColumnsAdded?: (table: string, columns: string[]) => void;
  /**
   * Schema-op revert hooks. Row inverse/forward is pure-DB (applyInverse/
   * applyForward below), but reverting a SCHEMA op needs config-doc + openConfig
   * access that lives in the server. The server supplies these closures (over
   * its reassignable `active`) when handling undo/redo/revert; applyInverse/
   * applyForward delegate to them for `schema.*` entries. Absent for plain row
   * mutations — a schema entry encountered without them throws loudly.
   */
  applySchemaInverse?: (entry: AuditEntry) => Promise<void>;
  applySchemaForward?: (entry: AuditEntry) => Promise<void>;
  /**
   * The originating client's true edit time (`x-lattice-client-ts`), honored for
   * the audit/history timestamp so an OFFLINE edit replayed later shows when it
   * was actually made, not when it finally synced (#4.6). Validated by
   * {@link sanitizeEditTs}; ignored if absent/implausible.
   */
  clientTs?: string | undefined;
  /**
   * Set ONLY by the trusted HTML-file authoring tools (create_html_file /
   * edit_html_file). It permits a write to set the reserved `artifact_type='html'`
   * marker that makes a `files` row render as an EXECUTABLE inline HTML document.
   * Absent/false on every other path (generic create_row/update_row, bulk_update,
   * the HTTP row-CRUD routes, ingest), so an untrusted caller — or a prompt
   * injection — cannot forge an executable artifact for another viewer to render.
   * See {@link guardReservedColumns}.
   */
  allowReservedFileCols?: boolean;
}

/**
 * Accept a client-supplied edit timestamp ONLY when it's a parseable ISO instant
 * that isn't in the future (beyond a small clock-skew margin). An offline edit
 * is legitimately in the PAST (it synced late), so old values are fine; a future
 * value (clock skew or a client trying to sort its edit ahead of everyone) is
 * rejected so it can't jump the audit order. Returns the validated ISO string or
 * null (caller falls back to server now()). #4.6
 */
export function sanitizeEditTs(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  if (t > Date.now() + 5 * 60 * 1000) return null; // > 5 min in the future — reject
  return new Date(t).toISOString();
}

/**
 * An error a queued OFFLINE edit can never replay successfully: the target row is
 * gone / invisible under RLS, or the write didn't land. Tagged with a stable
 * `code` so the HTTP layer maps it to 409 and the client routes the edit to its
 * dead-letter queue (marks it failed + surfaces it) instead of retrying forever
 * (#4.5 — previously these threw a generic 500 the drain loop retried endlessly).
 */
export function writeConflict(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'row_write_conflict' });
}

/**
 * Friendly write guard for the mutation chokepoint: a computed table is a live,
 * read-only projection, so a row write against it can never be honored (the
 * core refuses too, but with library-facing wording). Thrown as a write
 * conflict (HTTP 409) so an offline client dead-letters the edit instead of
 * retrying it forever.
 */
function assertNotComputedTable(db: Lattice, table: string): void {
  if (db.isComputedTable(table)) {
    throw writeConflict(
      `"${table}" is a computed view and can't be edited directly — change its underlying records or its definition instead.`,
    );
  }
}

/** Infer a column type for an auto-created column from its first written value. */
function inferColumnType(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  if (typeof v === 'boolean') return 'INTEGER';
  return 'TEXT';
}

/**
 * Auto-create any columns present in `values` that the table's schema lacks, so
 * a caller (e.g. the assistant) that writes a field the table doesn't have gets
 * the data PERSISTED rather than silently dropped (Rule: no silent failures —
 * the old behaviour filtered unknown columns away and still reported success).
 * Internal bookkeeping tables (`_lattice_*` / `__lattice_*`) are never extended.
 * On a secured cloud the generated per-column audience (mask) view is rebuilt so
 * members see the new columns too. Returns the names of columns it created (for
 * the activity feed). `addColumn` throws on an unsafe identifier — surfaced, not
 * silently skipped.
 */
async function ensureColumns(db: Lattice, table: string, values: Row): Promise<string[]> {
  if (table.startsWith('_lattice_') || table.startsWith('__lattice_')) return [];
  const existing = db.getRegisteredColumns(table);
  if (!existing) return []; // unknown table — the write fails loudly downstream
  const added = Object.keys(values).filter((k) => !(k in existing));
  if (added.length === 0) return [];
  for (const col of added) await db.addColumn(table, col, inferColumnType(values[col]));
  // Cloud: the masked audience view selects an explicit column list, so a newly
  // added column is invisible to members until the view is regenerated. A scoped
  // member can't run that DDL, so its addColumn already regenerated the view inside
  // the owner-side SECURITY DEFINER helper — don't regenerate again here (the
  // member's role would fail the CREATE OR REPLACE VIEW). The owner path rebuilds
  // it here as before.
  if (!db.isCloudMemberOpen() && db.getDialect() === 'postgres' && (await cloudRlsInstalled(db))) {
    const cols = db.getRegisteredColumns(table);
    const pk = db.getPrimaryKey(table);
    if (cols && pk.length > 0) await regenerateAudienceViewFromDb(db, table, Object.keys(cols), pk);
  }
  return added;
}

/** Record + surface an auto-column-add so it is never a silent schema change. */
async function announceAddedColumns(
  ctx: MutationCtx,
  table: string,
  added: string[],
): Promise<void> {
  if (added.length === 0) return;
  const summary = `Added column${added.length > 1 ? 's' : ''} ${added.join(', ')} to ${table}`;
  await recordSchemaAudit(
    ctx.db,
    ctx.feed,
    table,
    'schema.add_column',
    null,
    { columns: added },
    summary,
    ctx.source,
    ctx.sessionId,
  );
  // Auto-generate definitions for the new columns (non-blocking, fail-silent).
  // Runs AFTER the audit so the schema change is recorded regardless.
  ctx.onColumnsAdded?.(table, added);
}

/**
 * Derive a STABLE row id from a client edit-id (#3.6 offline-replay idempotency).
 * The GUI stamps every logical row write with an `x-lattice-edit-id` (a per-edit
 * UUID, persisted in its offline IndexedDB queue) and may REPLAY the same POST
 * after a reconnect — or when the original response was lost after the row had
 * already been committed. Deriving the new row's id deterministically from that
 * edit-id means a replay targets the SAME id, so {@link createRow} can detect the
 * row already exists and no-op instead of inserting a duplicate. Hashing (rather
 * than using the header verbatim) bounds the id length and normalizes the charset
 * regardless of what the client sent. The 128-bit slice is collision-resistant.
 */
export function deriveRowIdFromEditId(editId: string): string {
  return createHash('sha256').update(editId).digest('hex').slice(0, 32);
}

/**
 * Reserve the executable-artifact marker. A `files` row renders as a live,
 * script-running inline HTML document ONLY when artifact_type==='html' (see
 * renderFilePreview). That column is therefore security-sensitive: only the trusted
 * create_html_file / edit_html_file tools may set it (they pass
 * allowReservedFileCols). Every other write path — generic create_row/update_row,
 * bulk_update, the HTTP /api/tables/files/rows routes, ingest — is refused, so a
 * caller (or a prompt injection) cannot plant an executable HTML artifact that
 * another user would render. Fails loud rather than silently dropping the field.
 */
export function guardReservedColumns(
  ctx: MutationCtx,
  table: string,
  values: Partial<Row> | undefined,
): void {
  if (ctx.allowReservedFileCols || !values) return;
  if (table === 'files' && (values as Record<string, unknown>).artifact_type === 'html') {
    throw new Error(
      "artifact_type='html' marks an executable inline HTML file and may only be set by the create_html_file / edit_html_file tools",
    );
  }
  // dashboards.html IS the executable document body (rendered in a sandboxed
  // iframe for every viewer), so unlike files there is no marker value to
  // check: ANY write that touches the column outside the trusted authoring
  // tools is refused — set and change alike, which is why no post-read body
  // guard is needed for dashboards.
  if (table === 'dashboards' && Object.prototype.hasOwnProperty.call(values, 'html')) {
    throw new Error(
      'a dashboard page may only be written by the create_dashboard / edit_dashboard tools',
    );
  }
}

export async function createRow(
  ctx: MutationCtx,
  table: string,
  values: Row,
  forceVisibility?: 'private' | 'everyone',
  editId?: string,
): Promise<{ id: string; row: Row | null; idempotent: boolean }> {
  assertNotComputedTable(ctx.db, table);
  guardReservedColumns(ctx, table, values);
  // #3.6 — offline-replay idempotency. Scoped to callers that carry an edit-id
  // (the GUI row-write path; the assistant/ingest paths pass none and keep their
  // prior behaviour untouched). When the table uses the default single-column
  // `id` PK, derive a deterministic id from the edit-id (unless the caller pinned
  // one) so a replayed POST resolves to the SAME id; if that row already exists,
  // it's a true no-op — no duplicate row, no duplicate audit entry, no duplicate
  // feed event. Composite/custom-PK tables (e.g. junctions) keep normal id
  // assignment and are never deduped here.
  const pk = ctx.db.getPrimaryKey(table);
  const isDefaultPk = pk.length === 1 && pk[0] === 'id';
  let toInsert = values;
  if (editId && isDefaultPk) {
    const provided = values.id;
    // A usable caller-supplied id is a primitive; anything else (or absent) → derive
    // deterministically from the edit-id (also satisfies no-base-to-string).
    const hasId = typeof provided === 'string' || typeof provided === 'number';
    const targetId = hasId ? String(provided) : deriveRowIdFromEditId(editId);
    if (!hasId) toInsert = { ...values, id: targetId };
    const existing = await ctx.db.get(table, targetId);
    if (existing !== null) return { id: targetId, row: existing, idempotent: true };
  }
  // Persist fields the schema lacks by creating the columns first (no silent drop).
  const addedCols = await ensureColumns(ctx.db, table, toInsert);
  await announceAddedColumns(ctx, table, addedCols);
  // When the caller demands a specific cloud visibility for this row (e.g. chat
  // "private mode"), stamp it atomically at insert via insertForcingVisibility —
  // never create-then-demote, which would leave the row briefly visible at the
  // table default and broadcast its existence before the demote lands. On SQLite
  // / non-cloud this degrades to a plain insert. A failure propagates (no swallow)
  // so a row that could not be forced to the requested visibility is reported, not
  // silently left shared (Rule: no silent failures).
  const id =
    forceVisibility !== undefined
      ? await ctx.db.insertForcingVisibility(table, toInsert, forceVisibility)
      : await ctx.db.insert(table, toInsert);
  const row = await ctx.db.get(table, id);
  // On a cloud, row ownership + the change feed are recorded by Postgres
  // triggers; no app-layer ACL or change-envelope write is needed.
  await appendAudit(
    ctx.db,
    ctx.feed,
    table,
    id,
    'insert',
    null,
    row,
    ctx.source,
    ctx.sessionId,
    ctx.clientTs,
  );
  return { id, row, idempotent: false };
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
  assertNotComputedTable(ctx.db, table);
  guardReservedColumns(ctx, table, values);
  const before = await ctx.db.get(table, id);
  // Never silently "succeed" against a row that doesn't exist. A
  // missing row means the caller (e.g. the assistant) used a stale/wrong id;
  // the no-op UPDATE would otherwise record a bogus audit/feed entry whose
  // row link 404s on click. Fail loudly so the caller can correct.
  if (before === null) {
    throw writeConflict(`Cannot update "${table}": no row with id "${id}"`);
  }
  // Reserve EXECUTABLE-artifact bodies too. Changing the rendered content of a row
  // that is ALREADY an html artifact is as security-sensitive as creating one — it
  // changes what executes when a viewer re-opens it — so a body edit is likewise
  // limited to the trusted edit_html_file tool (which passes allowReservedFileCols).
  // (guardReservedColumns above only reserves SETTING the artifact_type marker;
  // it can't see the existing row, which is why this lives here, after `before`.)
  if (
    table === 'files' &&
    !ctx.allowReservedFileCols &&
    (before as Record<string, unknown>).artifact_type === 'html' &&
    Object.prototype.hasOwnProperty.call(values, 'extracted_text')
  ) {
    throw new Error(
      'the body of an executable HTML file may only be changed by the edit_html_file tool',
    );
  }
  // Persist fields the schema lacks by creating the columns first (no silent drop).
  const addedCols = await ensureColumns(ctx.db, table, values as Row);
  await announceAddedColumns(ctx, table, addedCols);
  // No app-layer permission gate: on a cloud, Postgres RLS confines a member to
  // the rows it may edit (an update to an invisible row simply affects 0 rows).
  await ctx.db.update(table, id, values);
  const after = await ctx.db.get(table, id);
  // A requested change that left the row byte-identical means the
  // write did not land (a read-only data source silently no-ops the UPDATE).
  // Surface it loudly instead of reporting a phantom success. A genuine no-op
  // (the new value already equals the stored value) is NOT an error.
  // (before is non-null here — the guard above throws when the row is missing.)
  if (after != null) {
    const wantedChange = Object.keys(values).some(
      (k) => !storedValueMatches(before[k], (values as Row)[k]),
    );
    if (wantedChange && rowsEqual(before, after)) {
      throw writeConflict('Row update did not persist — the data source may be read-only');
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
    ctx.clientTs,
  );
  return { row: after };
}

export async function deleteRow(
  ctx: MutationCtx,
  table: string,
  id: string,
  hard: boolean,
): Promise<void> {
  assertNotComputedTable(ctx.db, table);
  const before = await ctx.db.get(table, id);
  // Deleting a non-existent row is a no-op that would still record a
  // bogus audit/feed entry. Surface the bad id instead of faking success.
  if (before === null) {
    throw writeConflict(`Cannot delete from "${table}": no row with id "${id}"`);
  }
  // RLS confines a member to the rows it may delete (no app-layer gate).
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
      ctx.clientTs,
    );
  } else {
    await hardDelete(ctx, table, id, before);
  }
}

/**
 * Hard-delete a row AND record its delete-audit entry so the audit INSERT lands
 * BEFORE the base row (and its cloud ownership record) are removed.
 *
 * Ordering is load-bearing on a cloud: the audit table's INSERT policy WITH CHECK
 * is `row_id IS NULL OR lattice_row_visible(table_name, row_id)`, and the base
 * table's AFTER DELETE trigger removes the row's `__lattice_owners` record — after
 * which `lattice_row_visible` is false and the audit INSERT would be rejected. So
 * the audit row must be written while the ownership record still exists.
 *
 * When the adapter supports a transaction (cloud Postgres), the audit INSERT and
 * the base DELETE run in ONE transaction as raw statements, so they commit
 * together or not at all — no orphaned audit row if the delete fails, and the
 * trigger that drops the ownership record fires only at the (single) COMMIT. The
 * feed event is published after a successful commit. Tables that opt into the
 * changelog substrate keep the full high-level delete path (so their changelog /
 * write-hook / embedding side effects still fire); the audit row is written first
 * there too, which is the part the WITH CHECK depends on.
 */
async function hardDelete(
  ctx: MutationCtx,
  table: string,
  id: string,
  before: Row | null,
): Promise<void> {
  const withClient = ctx.db.adapter.withClient?.bind(ctx.db.adapter);
  const pkCols = ctx.db.getPrimaryKey(table);
  const pkCol = pkCols.length === 1 ? pkCols[0] : undefined;
  // The atomic raw path keys the base DELETE on a single-column primary key. Keep
  // the high-level path for: no transaction support (SQLite / older adapters),
  // changelog-tracked tables (their substrate / write-hook / embedding side
  // effects must still fire), and composite/keyless PKs (the high-level
  // db.delete resolves those). In every fallback the audit INSERT runs FIRST —
  // the ordering the cloud audit WITH CHECK depends on.
  if (!withClient || ctx.db.isChangelogTracked(table) || pkCol === undefined) {
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
      ctx.clientTs,
    );
    await ctx.db.delete(table, id);
    return;
  }
  const auditRow = buildAuditRow(
    table,
    id,
    'delete',
    before,
    null,
    ctx.sessionId,
    ctx.clientTs,
    ctx.source,
  );
  await purgeRedoStack(ctx.db, ctx.sessionId);
  const auditCols = AUDIT_COLUMNS.map((c) => `"${c}"`).join(', ');
  const auditPlaceholders = AUDIT_COLUMNS.map(() => '?').join(', ');
  const auditValues = AUDIT_COLUMNS.map((c) => auditRow[c]);
  const pkColQuoted = pkCol.replace(/"/g, '""');
  await withClient(async (tx) => {
    await tx.run(
      `INSERT INTO "_lattice_gui_audit" (${auditCols}) VALUES (${auditPlaceholders})`,
      auditValues,
    );
    await tx.run(`DELETE FROM "${table.replace(/"/g, '""')}" WHERE "${pkColQuoted}" = ?`, [id]);
  });
  publishMutationFeed(ctx.feed, table, id, 'delete', before, null, ctx.source);
}

/**
 * Insert a junction row to link two records, audited + feed-published.
 *
 * `forceVisibility` stamps the junction row's cloud visibility atomically at
 * insert (via the same `insertForcingVisibility` primitive {@link createRow}
 * uses), instead of letting it inherit the junction table's default. Callers
 * pass `'private'` when the link encodes a relationship that must stay private —
 * e.g. an enrichment link from a PRIVATE source file: even if it points at a
 * SHARED entity, the link row itself would otherwise leak the private file's
 * association under an 'everyone'-default junction. Omit it for ordinary links
 * (the prior behaviour — inherit the table default). On SQLite / non-cloud it
 * degrades to the plain link insert (single-user, no cross-viewer leak).
 */
export async function linkRows(
  ctx: MutationCtx,
  table: string,
  body: Row,
  forceVisibility?: 'private' | 'everyone',
): Promise<void> {
  assertNotComputedTable(ctx.db, table);
  if (forceVisibility !== undefined) {
    // Route through the GUC-scoped insert so the junction row carries the forced
    // visibility from the moment it exists (no create-then-demote window). A
    // failure propagates — a link that couldn't be forced private is reported,
    // not silently left shared.
    await ctx.db.insertForcingVisibility(table, body, forceVisibility);
  } else {
    await ctx.db.link(table, body);
  }
  await appendAudit(ctx.db, ctx.feed, table, null, 'link', null, body, ctx.source, ctx.sessionId);
}

export async function unlinkRows(ctx: MutationCtx, table: string, body: Row): Promise<void> {
  assertNotComputedTable(ctx.db, table);
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

/**
 * The single audit entry an undo/redo acts on: the newest LIVE entry (undone=0,
 * DESC) or the oldest UNDONE entry (undone=1, ASC). ISO `ts` sorts lexically ==
 * chronologically, so ORDER BY ts + LIMIT 1 in SQL picks it without loading (and
 * before/after-JSON-transferring) the whole session log.
 */
async function pickAuditTarget(
  db: Lattice,
  undone: 0 | 1,
  sessionId?: string,
): Promise<AuditEntry | null> {
  const rows = (await db.query('_lattice_gui_audit', {
    filters: sessionUndoneFilters(undone, sessionId),
    orderBy: 'ts',
    orderDir: undone === 0 ? 'desc' : 'asc',
    limit: 1,
  })) as Record<string, unknown>[];
  return rows[0] ? parseAudit(rows[0]) : null;
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
  const target = await pickAuditTarget(ctx.db, 0, ctx.sessionId);
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
  const target = await pickAuditTarget(ctx.db, 1, ctx.sessionId);
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
  // Revertable and surfaces the error to the caller (fail loudly).
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
