import type { Lattice } from '../../lattice.js';
import type { Row } from '../../types.js';
import type { FeedBus } from '../feed.js';
import { getFunction } from './registry.js';
import { fullTextSearch } from '../../search/fts.js';
import type { DeleteResolution, DeleteEntityOutcome } from '../schema-ops.js';
import {
  createRow,
  updateRow,
  deleteRow,
  linkRows,
  unlinkRows,
  undoLast,
  redoLast,
  revertEntry,
  parseAudit,
  type MutationCtx,
} from '../mutations.js';

/**
 * Executes a registry function on behalf of the AI tool loop. Writes flow
 * through the shared mutation primitives with `source='ai'`, so each AI action
 * lands in the audit log + activity feed exactly like a UI action — and is
 * undoable. Reads query the active Lattice directly.
 *
 * Scope: the data-centric functions an assistant needs to answer questions
 * about and edit the database. Schema, history, and database-management
 * functions are declared in the registry but not yet dispatchable; the chat
 * loop exposes only {@link DISPATCHABLE} to the model so it never calls a tool
 * that would just error.
 */

/**
 * Registry function names the dispatcher can execute. This is the data-and-
 * history surface — reads, row writes, junction links, and undo/redo/revert.
 * Schema mutations (create_entity, add_column, …) and database lifecycle
 * (switch/create) are intentionally excluded: they reshape the workspace and
 * re-open the active database, which a mid-conversation tool call must not do.
 * Those stay UI-driven.
 */
export const DISPATCHABLE: ReadonlySet<string> = new Set([
  'list_entities',
  'list_rows',
  'get_row',
  'search',
  'get_history',
  'create_row',
  'update_row',
  'delete_row',
  'link',
  'unlink',
  'create_entity',
  'create_relationship',
  'delete_entity',
  'undo',
  'redo',
  'revert',
]);

/**
 * Native tables the assistant must NEVER read, write, or be told about. The
 * chat route strips these from the callable `validTables`, the schema context
 * omits them, and `list_entities` skips them — so the model neither sees them
 * nor can target them (read OR write).
 *
 * - `secrets`: holds decrypted API keys / OAuth tokens; the dispatcher reads
 *   rows already-decrypted, so a request (or instructions injected via an
 *   attached file's `extracted_text`) could otherwise spill credentials.
 * - `chat_threads` / `chat_messages`: the assistant's OWN conversation storage.
 *   Letting the model `delete_row`/`update_row` here would let a prompt
 *   injection erase or rewrite chat history. Persistence writes go through
 *   `db.insert` directly (not the dispatcher), so hiding them here is safe.
 */
export const ASSISTANT_HIDDEN_TABLES: ReadonlySet<string> = new Set([
  'secrets',
  'chat_threads',
  'chat_messages',
]);

const SECRET_MASK = '••••••••';

/** Column names marked secret for a table (via the data-model `set_column_secret`). */
async function secretColumnsFor(db: Lattice, table: string): Promise<Set<string>> {
  try {
    const rows = (await db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: table },
        { col: 'secret', op: 'eq', val: 1 },
      ],
    })) as { column_name: string }[];
    return new Set(rows.map((r) => r.column_name));
  } catch {
    // Meta table absent (fresh DB) — nothing is marked secret.
    return new Set();
  }
}

/**
 * Replace secret-column values with a mask so a column a user flagged secret
 * (e.g. an `api_key` on an `integrations` table) never reaches the model — the
 * reads decrypt, so without this they'd leak into chat output. Mirrors the
 * row-context endpoint's redaction (server.ts).
 *
 * NOTE (v3.1): on a cloud this is **model-context safety only**, NOT the
 * cross-member privacy boundary. Marking a column secret now also sets its
 * `owner` audience in `__lattice_column_policy`, so Postgres masks it to non-owner
 * members at the database (`<table>_v` view) — that DB mask is the real boundary;
 * this redaction just keeps secret values out of the LLM prompt for the owner too.
 */
function redactRow(row: Row, secretCols: Set<string>): Row {
  if (secretCols.size === 0) return row;
  const out: Row = { ...row };
  for (const c of secretCols) {
    if (c in out && out[c] != null && out[c] !== '') out[c] = SECRET_MASK;
  }
  return out;
}

/** A junction the assistant created (or that already existed) for `link`. */
export interface AssistantJunction {
  junction: string;
  tableA: string;
  aFk: string;
  tableB: string;
  bFk: string;
}

export interface DispatchCtx {
  db: Lattice;
  feed: FeedBus;
  /**
   * "Private mode" (a chat-composer toggle): when true, rows the assistant creates
   * this turn are forced PRIVATE regardless of the table's default visibility — a
   * transient per-action choice, applied by calling the existing owner-only
   * `set_row_visibility` after create (the creator owns the new row). Off ⇒ new
   * rows follow the table default. Cloud (Postgres) only.
   */
  privateMode?: boolean;
  /** Allowlist of queryable/writable user tables (mirrors the HTTP gate). */
  validTables: Set<string>;
  /** Junction tables eligible for link/unlink. */
  junctionTables: Set<string>;
  /** Tables carrying a `deleted_at` column. */
  softDeletable: Set<string>;
  /**
   * Create a new entity (table) with inferred columns — audited + reversible,
   * no DB reopen (defineLate). Supplied by the server when schema creation is
   * allowed; absent → `create_entity` reports it's unavailable. Returns the
   * created table name, or null when it can't be created.
   */
  createEntity?: (name: string, columns: string[]) => Promise<string | null>;
  /**
   * Create (or return) a many-to-many junction between two existing tables —
   * audited + reversible, no reopen. Absent → `create_relationship` reports it's
   * unavailable. Returns the junction + its two foreign-key columns, or null.
   */
  createJunction?: (tableA: string, tableB: string) => Promise<AssistantJunction | null>;
  /**
   * Soft-delete a user table — guarded + reversible (no physical drop). Supplied
   * by the server; absent → `delete_entity` reports it's unavailable. An EMPTY
   * table is deleted immediately; a NON-empty table returns `needsResolution` so
   * the assistant asks the user, then re-calls with a resolution.
   */
  deleteEntity?: (name: string, resolution?: DeleteResolution) => Promise<DeleteEntityOutcome>;
}

export interface DispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} is required`);
  return v;
}

function requireTable(v: unknown, valid: Set<string>): string {
  const table = requireString(v, 'table');
  if (!valid.has(table)) throw new Error(`Unknown table: ${table}`);
  return table;
}

/**
 * Run a single tool call. Never throws — validation/runtime failures are
 * returned as `{ ok: false, error }` so the chat loop can hand the model a
 * tool_result it can recover from.
 */
export async function executeFunction(
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  if (!getFunction(name)) return { ok: false, error: `Unknown function: ${name}` };
  if (!DISPATCHABLE.has(name)) {
    return { ok: false, error: `Function "${name}" is not available to the assistant yet` };
  }

  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ai',
  };

  try {
    switch (name) {
      case 'list_entities': {
        const tables = ctx.db
          .getRegisteredTableNames()
          .filter(
            (n) =>
              !n.startsWith('_lattice_') &&
              !n.startsWith('__lattice_') &&
              !ASSISTANT_HIDDEN_TABLES.has(n),
          );
        const out: { name: string; rowCount: number }[] = [];
        for (const t of tables) out.push({ name: t, rowCount: await ctx.db.count(t) });
        return { ok: true, result: out };
      }
      case 'list_rows': {
        const table = requireTable(args.table, ctx.validTables);
        const includeDeleted = args.includeDeleted === true;
        // Deterministic, reproducible order — the 200-row window is only stable
        // if the sort is. Without an ORDER BY, two identical reads can return rows
        // in different orders, so the assistant reads a different row each time and
        // reports conflicting values. `created_at` gives a natural chronological
        // order where it exists; the primary key (single-column `id` here) is the
        // universal stable fallback. Explicit ORDER BY behaves identically on
        // SQLite + Postgres, and composes after the soft-delete WHERE.
        const cols = ctx.db.getRegisteredColumns(table);
        const orderBy =
          cols && 'created_at' in cols ? 'created_at' : (ctx.db.getPrimaryKey(table)[0] ?? 'id');
        // On a cloud, Postgres RLS filters reads to the rows this member may see.
        const opts: Parameters<typeof ctx.db.query>[1] = { limit: 200, orderBy, orderDir: 'asc' };
        if (ctx.softDeletable.has(table) && !includeDeleted) {
          opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
        }
        const rows: Row[] = await ctx.db.query(table, opts);
        const secretCols = await secretColumnsFor(ctx.db, table);
        return { ok: true, result: rows.map((r) => redactRow(r, secretCols)) };
      }
      case 'get_row': {
        const table = requireTable(args.table, ctx.validTables);
        const id = requireString(args.id, 'id');
        // RLS filters the read: get() returns null for a row this member can't
        // see, so a denied read is already indistinguishable from a missing one.
        const row = await ctx.db.get(table, id);
        if (row === null) return { ok: false, error: 'Row not found' };
        return { ok: true, result: redactRow(row, await secretColumnsFor(ctx.db, table)) };
      }
      case 'search': {
        const query = requireString(args.query, 'query');
        // Default to every searchable table. validTables already excludes the
        // hidden tables (secrets / chat storage), so the assistant can never
        // search those. An explicit `tables` arg is intersected with the
        // allowlist so it can't widen the scope.
        let tables = [...ctx.validTables];
        if (Array.isArray(args.tables)) {
          const want = new Set(args.tables.filter((t): t is string => typeof t === 'string'));
          tables = tables.filter((t) => want.has(t));
        }
        const limit = typeof args.limit === 'number' ? args.limit : 8;
        // On a cloud, search runs as the member's scoped role: the LIKE search on
        // the base table (the fallback when a member can't read the FTS index) is
        // filtered by Postgres RLS, so hits never include another member's rows.
        const result = await fullTextSearch(ctx.db.adapter, tables, {
          query,
          limitPerTable: limit,
        });
        return { ok: true, result };
      }
      case 'create_row': {
        const table = requireTable(args.table, ctx.validTables);
        if (!args.values || typeof args.values !== 'object') {
          throw new Error('values object is required');
        }
        // Private mode: force the new row private atomically at insert (the trigger
        // stamps it private regardless of the table default — no create-then-demote
        // window). Any failure propagates out of createRow and is reported as a
        // failed action rather than silently leaving the row at the table default.
        const { id } = await createRow(
          mctx,
          table,
          args.values as Row,
          ctx.privateMode ? 'private' : undefined,
        );
        return { ok: true, result: { id } };
      }
      case 'update_row': {
        const table = requireTable(args.table, ctx.validTables);
        const id = requireString(args.id, 'id');
        if (!args.values || typeof args.values !== 'object') {
          throw new Error('values object is required');
        }
        await updateRow(mctx, table, id, args.values as Partial<Row>);
        return { ok: true, result: { ok: true } };
      }
      case 'delete_row': {
        const table = requireTable(args.table, ctx.validTables);
        const id = requireString(args.id, 'id');
        await deleteRow(mctx, table, id, args.hard === true);
        return { ok: true, result: { ok: true } };
      }
      case 'link':
      case 'unlink': {
        const table = requireTable(args.table, ctx.junctionTables);
        if (!args.values || typeof args.values !== 'object') {
          throw new Error('values object (the junction row) is required');
        }
        const values = args.values as Row;
        if (name === 'link') await linkRows(mctx, table, values);
        else await unlinkRows(mctx, table, values);
        return { ok: true, result: { ok: true } };
      }
      case 'create_entity': {
        if (!ctx.createEntity) {
          return { ok: false, error: 'Creating tables is not available in this context' };
        }
        const name = requireString(args.name, 'name');
        const columns = Array.isArray(args.columns)
          ? args.columns.filter((c): c is string => typeof c === 'string')
          : [];
        const created = await ctx.createEntity(name, columns);
        if (!created) {
          return {
            ok: false,
            error: `Could not create table "${name}" — the name is invalid, reserved, or a table by that name already exists.`,
          };
        }
        // Make the new table usable by later tool calls in this same turn.
        ctx.validTables.add(created);
        return { ok: true, result: { entity: created } };
      }
      case 'create_relationship': {
        if (!ctx.createJunction) {
          return { ok: false, error: 'Creating relationships is not available in this context' };
        }
        const a = requireTable(args.table_a, ctx.validTables);
        const b = requireTable(args.table_b, ctx.validTables);
        const j = await ctx.createJunction(a, b);
        if (!j) {
          return {
            ok: false,
            error: `Could not create a relationship between "${a}" and "${b}" (one may be native, a junction, or invalid).`,
          };
        }
        ctx.validTables.add(j.junction);
        ctx.junctionTables.add(j.junction);
        // Tell the model the junction name + the two FK columns to use with `link`.
        return {
          ok: true,
          result: {
            junction: j.junction,
            link_columns: { [j.aFk]: j.tableA, [j.bFk]: j.tableB },
          },
        };
      }
      case 'delete_entity': {
        if (!ctx.deleteEntity) {
          return { ok: false, error: 'Deleting tables is not available in this context' };
        }
        const target = requireString(args.name, 'name');
        // Optional resolution for a NON-empty table: delete its data too, or move
        // it into another table. Omitted → the tool reports the table isn't empty
        // and the assistant must ask the user before retrying.
        let resolution: DeleteResolution | undefined;
        if (args.resolution === 'delete_data') resolution = 'delete_data';
        else if (typeof args.move_to === 'string' && args.move_to) {
          resolution = { move_to: args.move_to };
        }
        const outcome = await ctx.deleteEntity(target, resolution);
        // Not deleted (table not empty + no resolution): hand the question back to
        // the model as a successful tool result so it asks the user what to do.
        if ('needsResolution' in outcome) return { ok: true, result: outcome };
        if (!outcome.ok) return { ok: false, error: outcome.error };
        // Keep the in-turn allowlist consistent with the deletion.
        ctx.validTables.delete(target);
        ctx.junctionTables.delete(target);
        return { ok: true, result: outcome };
      }
      case 'get_history': {
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const rows = (await ctx.db.query('_lattice_gui_audit', { limit })) as Record<
          string,
          unknown
        >[];
        let entries = rows.map(parseAudit);
        if (typeof args.table === 'string')
          entries = entries.filter((e) => e.table_name === args.table);
        return { ok: true, result: entries };
      }
      case 'undo': {
        const entry = await undoLast(mctx);
        return entry ? { ok: true, result: entry } : { ok: false, error: 'Nothing to undo' };
      }
      case 'redo': {
        const entry = await redoLast(mctx);
        return entry ? { ok: true, result: entry } : { ok: false, error: 'Nothing to redo' };
      }
      case 'revert': {
        const auditId = requireString(args.auditId, 'auditId');
        const result = await revertEntry(mctx, auditId);
        return result.ok
          ? { ok: true, result: result.entry }
          : {
              ok: false,
              error:
                result.reason === 'not_found' ? 'Audit entry not found' : 'Entry already undone',
            };
      }
      default:
        return { ok: false, error: `Function "${name}" is not available to the assistant yet` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
