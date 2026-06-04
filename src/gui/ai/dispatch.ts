import type { Lattice } from '../../lattice.js';
import type { Row } from '../../types.js';
import type { FeedBus } from '../feed.js';
import { getFunction } from './registry.js';
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
  'get_history',
  'create_row',
  'update_row',
  'delete_row',
  'link',
  'unlink',
  'undo',
  'redo',
  'revert',
]);

export interface DispatchCtx {
  db: Lattice;
  feed: FeedBus;
  /** Allowlist of queryable/writable user tables (mirrors the HTTP gate). */
  validTables: Set<string>;
  /** Junction tables eligible for link/unlink. */
  junctionTables: Set<string>;
  /** Tables carrying a `deleted_at` column. */
  softDeletable: Set<string>;
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
          .filter((n) => !n.startsWith('_lattice_') && !n.startsWith('__lattice_'));
        const out: { name: string; rowCount: number }[] = [];
        for (const t of tables) out.push({ name: t, rowCount: await ctx.db.count(t) });
        return { ok: true, result: out };
      }
      case 'list_rows': {
        const table = requireTable(args.table, ctx.validTables);
        const opts: Parameters<typeof ctx.db.query>[1] = { limit: 200 };
        if (ctx.softDeletable.has(table) && args.includeDeleted !== true) {
          opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
        }
        return { ok: true, result: await ctx.db.query(table, opts) };
      }
      case 'get_row': {
        const table = requireTable(args.table, ctx.validTables);
        const id = requireString(args.id, 'id');
        const row = await ctx.db.get(table, id);
        return row === null ? { ok: false, error: 'Row not found' } : { ok: true, result: row };
      }
      case 'create_row': {
        const table = requireTable(args.table, ctx.validTables);
        if (!args.values || typeof args.values !== 'object') {
          throw new Error('values object is required');
        }
        const { id } = await createRow(mctx, table, args.values as Row);
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
