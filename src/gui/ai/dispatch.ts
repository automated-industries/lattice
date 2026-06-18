import { getFunction } from './registry.js';
import type { MutationCtx } from '../mutations.js';
import { handleRead } from './handlers/read.js';
import { handleRowMutations } from './handlers/row-mutations.js';
import { handleCollaboration } from './handlers/collaboration.js';
import { handleHistory } from './handlers/history.js';
import {
  NOT_HANDLED,
  type DispatchCtx,
  type DispatchResult,
  type HandlerDeps,
} from './handlers/types.js';

// Re-export the public surface so every existing `from './ai/dispatch.js'`
// import keeps resolving unchanged after the switch was split into per-group
// handler modules. Consumers: chat-routes.ts + read-routes.ts (ASSISTANT_HIDDEN_TABLES,
// AssistantJunction, DispatchCtx), gui-ai-visibility-permission.test.ts
// (visibilityDenialReason), plus the moved helpers (belt-and-suspenders — keeps
// the relocation a non-API change regardless of who imports what by name).
export {
  ASSISTANT_HIDDEN_TABLES,
  type DispatchCtx,
  type DispatchResult,
  type AssistantJunction,
  type HandlerDeps,
} from './handlers/types.js';
export { visibilityDenialReason } from './handlers/permission.js';
export { requireString, requireTable } from './handlers/helpers.js';
export {
  SECRET_MASK,
  secretColumnsFor,
  redactRow,
  frameUntrustedFileContent,
} from './handlers/read.js';
export {
  normalizeUrl,
  userProvidedUrl,
  parseBulkFilters,
  isWriteConflict,
} from './handlers/row-mutations.js';

/**
 * Registry function names the dispatcher can execute. This is the data-and-
 * history surface — reads, row writes, junction links, undo/redo/revert, and the
 * NO-REOPEN schema mutations (create_entity, add_column, create_relationship,
 * delete_entity) that register live via defineLate so the assistant can shape the
 * workspace on request. Only database LIFECYCLE (switch/create a whole database),
 * which re-opens the active connection, stays UI-driven and excluded.
 */
export const DISPATCHABLE: ReadonlySet<string> = new Set([
  'list_entities',
  'list_rows',
  'get_row',
  'get_row_context',
  'search',
  'lattice_help',
  'get_history',
  'create_row',
  'create_artifact',
  'ingest_url',
  'set_definition',
  'set_visibility',
  'dedup',
  'update_row',
  'bulk_update',
  'delete_row',
  'link',
  'unlink',
  'create_entity',
  'add_column',
  'create_relationship',
  'delete_entity',
  'undo',
  'redo',
  'revert',
]);

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
    // Stamp the GUI session that initiated this chat turn, so the assistant's
    // writes land in the SAME session-scoped undo/redo stack as a manual edit —
    // the user can undo what they asked the assistant to do.
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.onColumnsAdded ? { onColumnsAdded: ctx.onColumnsAdded } : {}),
  };

  try {
    // The 25 dispatchable names partition disjointly across the four group
    // handlers; each returns NOT_HANDLED for a name it doesn't own. Try them in
    // source first-appearance order (read → row-mutations → collaboration →
    // history) and return the first real result. The SAME ctx reference is
    // threaded to every group, so in-turn ctx.validTables / ctx.junctionTables
    // mutations stay visible to later cases. The single try/catch below maps any
    // group throw to { ok: false, error } exactly as the prior switch did.
    const deps: HandlerDeps = { ctx, mctx, name, args };
    for (const group of [handleRead, handleRowMutations, handleCollaboration, handleHistory]) {
      const r = await group(deps);
      if (r !== NOT_HANDLED) return r;
    }
    return { ok: false, error: `Function "${name}" is not available to the assistant yet` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
