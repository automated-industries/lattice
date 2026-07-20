import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.js';
import type { GuiRequestContext } from './request-context.js';
import {
  parseAudit,
  isSchemaOp,
  undoLast,
  redoLast,
  revertEntry,
  auditEntryWithoutImages,
  type AuditEntry,
} from './mutations.js';
import { applySchemaConfig } from './lifecycle.js';
import { emitDdlEnvelope } from './schema-ops.js';

/**
 * Version-history routes — audit-log undo / redo / revert — extracted from
 * server.ts. A flat leaf mirroring the other route modules: the
 * (req, res, ctx, deps) boolean-returning contract, re-parsing url/method from
 * the request. Schema-op entries are reverted IN PLACE here (they reopen the
 * config via applySchemaConfig, the second ctx.swapActive user); plain row
 * entries delegate to undoLast/redoLast/revertEntry. No body adds a new
 * try/catch beyond the two pre-existing applySchemaConfig 400-mappers, which
 * moved verbatim.
 */

/** Process-constant deps not carried by the per-request ctx. */
export interface HistoryRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. */
  host: string;
  /** Workspace (autoRender) mode — passed to applySchemaConfig on a schema revert. */
  autoRender: boolean;
}

/** Human one-liner for an undo/redo/revert of a schema entry (activity feed). */
function schemaReverseSummary(verb: string, entry: AuditEntry): string {
  const what = entry.operation.replace('schema.', '').replace(/_/g, ' ');
  return `${verb} schema change (${what}) on ${entry.table_name}`;
}

export async function handleHistoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: HistoryRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  let active = ctx.active();
  const sessionId = ctx.sessionId;

  if (method === 'POST' && pathname === '/api/history/undo') {
    // Peek the latest LIVE entry to branch row vs schema. Schema reverts
    // need config + re-open (which dispose the db row helpers capture), so
    // they're handled here directly; row ops go through undoLast.
    // Newest live entry only — ISO `ts` sorts lexically == chronologically, so
    // ORDER BY ts DESC LIMIT 1 in SQL replaces loading the whole session log to
    // pick one row.
    const live = (
      (await active.db.query('_lattice_gui_audit', {
        filters: [
          { col: 'undone', op: 'eq', val: 0 },
          { col: 'session_id', op: 'eq', val: sessionId },
        ],
        orderBy: 'ts',
        orderDir: 'desc',
        limit: 1,
      })) as Record<string, unknown>[]
    ).map(parseAudit);
    const target = live[0];
    if (target && isSchemaOp(target.operation)) {
      try {
        ctx.swapActive(await applySchemaConfig(active, target, 'inverse', deps.autoRender));
        active = ctx.active();
      } catch (err) {
        sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        return true;
      }
      await active.db.update('_lattice_gui_audit', target.id, { undone: 1 });
      active.feed.publish({
        table: target.table_name,
        op: 'undo',
        rowId: null,
        source: 'gui',
        summary: schemaReverseSummary('Undid', target),
      });
      await emitDdlEnvelope(active, target.table_name);
      sendJson(res, { ok: true, entry: auditEntryWithoutImages(target) });
      return true;
    }
    const entry = await undoLast(ctx.buildMutationCtx());
    if (!entry) {
      sendJson(res, { error: 'Nothing to undo' }, 400);
      return true;
    }
    sendJson(res, { ok: true, entry: auditEntryWithoutImages(entry) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/history/redo') {
    // Oldest undone entry only — redo replays in the order originally undone, so
    // ORDER BY ts ASC LIMIT 1 in SQL replaces loading every undone row to pick one.
    const undone = (
      (await active.db.query('_lattice_gui_audit', {
        filters: [
          { col: 'undone', op: 'eq', val: 1 },
          { col: 'session_id', op: 'eq', val: sessionId },
        ],
        orderBy: 'ts',
        orderDir: 'asc',
        limit: 1,
      })) as Record<string, unknown>[]
    ).map(parseAudit);
    const target = undone[0];
    if (target && isSchemaOp(target.operation)) {
      try {
        ctx.swapActive(await applySchemaConfig(active, target, 'forward', deps.autoRender));
        active = ctx.active();
      } catch (err) {
        sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        return true;
      }
      await active.db.update('_lattice_gui_audit', target.id, { undone: 0 });
      active.feed.publish({
        table: target.table_name,
        op: 'redo',
        rowId: null,
        source: 'gui',
        summary: schemaReverseSummary('Redid', target),
      });
      await emitDdlEnvelope(active, target.table_name);
      sendJson(res, { ok: true, entry: auditEntryWithoutImages(target) });
      return true;
    }
    const entry = await redoLast(ctx.buildMutationCtx());
    if (!entry) {
      sendJson(res, { error: 'Nothing to redo' }, 400);
      return true;
    }
    sendJson(res, { ok: true, entry: auditEntryWithoutImages(entry) });
    return true;
  }
  if (method === 'POST' && pathname.startsWith('/api/history/revert/')) {
    const id = decodeURIComponent(pathname.slice('/api/history/revert/'.length));
    const row = (await active.db.get('_lattice_gui_audit', id)) as Record<string, unknown> | null;
    if (row && isSchemaOp(String(row.operation))) {
      const target = parseAudit(row);
      if (target.undone === 1) {
        sendJson(res, { error: 'Entry already undone' }, 400);
        return true;
      }
      try {
        ctx.swapActive(await applySchemaConfig(active, target, 'inverse', deps.autoRender));
        active = ctx.active();
      } catch (err) {
        sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        return true;
      }
      await active.db.update('_lattice_gui_audit', id, { undone: 1 });
      active.feed.publish({
        table: target.table_name,
        op: 'undo',
        rowId: null,
        source: 'gui',
        summary: schemaReverseSummary('Reverted', target),
      });
      await emitDdlEnvelope(active, target.table_name);
      sendJson(res, { ok: true });
      return true;
    }
    // The per-entry Revert stays GLOBAL — intentionally NO sessionId in this
    // ctx (do not route through ctx.buildMutationCtx, which always injects it).
    const result = await revertEntry(
      {
        db: active.db,
        feed: active.feed,
        softDeletable: active.softDeletable,
        source: 'gui',
      },
      id,
    );
    if (!result.ok) {
      sendJson(
        res,
        {
          error: result.reason === 'not_found' ? 'Audit entry not found' : 'Entry already undone',
        },
        result.reason === 'not_found' ? 404 : 400,
      );
      return true;
    }
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
