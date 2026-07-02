import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson, parsePageParam, MAX_ROWS_PAGE } from './http.js';
import type { Row } from '../types.js';
import type { GuiRequestContext } from './request-context.js';
import { readRelationFor, attachRowAccess } from './active-db.js';
import { createRow, updateRow, deleteRow, linkRows, unlinkRows } from './mutations.js';
import { ROWS_PATH, LINK_PATH } from './route-paths.js';

/**
 * Row CRUD + junction link/unlink routes, extracted from server.ts as the second
 * route module (after read-routes.ts). A flat leaf mirroring read-routes.ts: the
 * same (req, res, ctx, deps) boolean-returning contract, re-parsing url/method
 * from the request. These routes MUTATE (via ctx.buildMutationCtx) but never
 * reassign the active workspace, so `const active = ctx.active()` once at the top
 * is referentially identical to the handler's per-request `active`. No body is
 * wrapped in a new try/catch — row_access_denied / row_owner_only /
 * row_write_conflict propagate to server.ts's outer catch (404/403/409 mapping).
 */

/**
 * Process-constant deps the table routes need that are not per-request active-DB
 * state — only the bind host, for `new URL(req.url, http://${host})`. Mirrors
 * ReadRoutesDeps (threaded here, not hung off GuiRequestContext).
 */
export interface TablesRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. Closure const in server.ts. */
  host: string;
}

/**
 * Read one request header as a trimmed string (Node lowercases header names and
 * may hand back an array for repeated headers — collapse to the first value).
 * Returns undefined when absent or blank so callers can treat "no header" and
 * "empty header" identically.
 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof v === 'string' ? v.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Ordered, first-match dispatcher for the row-CRUD + link/unlink routes. Returns
 * true iff it handled the request; server.ts calls it right after
 * handleReadRoutes (which has already peeled CONTEXT/ROW_HISTORY/LAST_EDITED off
 * the /rows family), so ROWS_PATH here only sees plain row paths.
 */
export async function handleTablesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: TablesRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const active = ctx.active();

  // ── In-place artifact content edit ────────────────────────────────
  // PUT /api/tables/files/rows/:id/content {text} — overwrite the artifact's body
  // (extracted_text) on the SAME row (audited → version history), never spawning a
  // new file. The reserved-file-col guard is relaxed for this trusted GUI path.
  // Must precede ROWS_PATH, whose greedy :id would otherwise swallow "/content".
  const contentMatch = /^\/api\/tables\/files\/rows\/([^/]+)\/content$/.exec(pathname);
  if (contentMatch && method === 'PUT') {
    const cid = decodeURIComponent(contentMatch[1] ?? '');
    const body = await readJson<{ text?: unknown }>(req).catch(() => ({}) as { text?: unknown });
    if (typeof body.text !== 'string') {
      sendJson(res, { error: 'text is required' }, 400);
      return true;
    }
    const mctx = ctx.buildMutationCtx({ clientTs: headerValue(req, 'x-lattice-client-ts') });
    mctx.allowReservedFileCols = true;
    await updateRow(mctx, 'files', cid, { extracted_text: body.text });
    sendJson(res, { ok: true });
    return true;
  }

  // ── Row CRUD: /api/tables/:table/rows[/:id] ───────────────────────
  const rowsMatch = ROWS_PATH.exec(pathname);
  if (rowsMatch) {
    const [, rawTable, rawId] = rowsMatch;
    const table = decodeURIComponent(rawTable ?? '');
    const id = rawId ? decodeURIComponent(rawId) : null;
    if (!active.validTables.has(table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    // #4.6 — the originating client's true edit time is honored for the
    // audit timestamp so an offline edit shows when it was made.
    const mctx = ctx.buildMutationCtx({
      clientTs: headerValue(req, 'x-lattice-client-ts'),
    });

    if (id === null) {
      if (method === 'GET') {
        // #4.9 — bound + validate the page params: an unbounded `limit` is a
        // full-table egress on a cloud hot path, and `Number('abc')` was
        // becoming `LIMIT NaN`. Reject non-numeric; clamp limit ≤ MAX.
        const limit = parsePageParam(url.searchParams.get('limit'), 'limit');
        const offset = parsePageParam(url.searchParams.get('offset'), 'offset');
        if (limit === 'invalid' || offset === 'invalid') {
          sendJson(res, { error: 'limit and offset must be non-negative integers' }, 400);
          return true;
        }
        const deletedMode = url.searchParams.get('deleted');
        // Row visibility is enforced by Postgres RLS at the database.
        const queryOpts: Parameters<typeof active.db.query>[1] = { limit, offset };
        const filters: NonNullable<typeof queryOpts.filters> = [];
        if (active.softDeletable.has(table) && deletedMode !== 'any') {
          filters.push({ col: 'deleted_at', op: deletedMode === 'only' ? 'isNotNull' : 'isNull' });
        }
        // The Artifacts object page pages the files that carry an artifact_type,
        // server-side (so it isn't capped at one client-side fetch window).
        if (url.searchParams.get('artifactType') === 'present') {
          filters.push({ col: 'artifact_type', op: 'isNotNull' });
        }
        if (filters.length) queryOpts.filters = filters;
        // Optional column projection (?exclude=col,col) so a caller can skip heavy
        // columns it doesn't need — e.g. the Sources sidebar excluding
        // files.extracted_text (up to 200 KB/row) on its frequent re-renders
        // (bounded-reads). RLS still applies (the read goes through the same
        // relation); the excluded columns are simply not selected.
        const excludeParam = url.searchParams.get('exclude');
        if (excludeParam) {
          const cols = excludeParam
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (cols.length) queryOpts.projection = { exclude: cols };
        }
        // #2.1 — a member reads an audience-masked table through its
        // `<table>_v` view (base SELECT was revoked); the base name is used
        // everywhere else (validTables, ownership lookups, writes).
        const rows = await active.db.query(readRelationFor(active, table), queryOpts);
        await attachRowAccess(active.db, table, rows);
        // Only the paginating caller asks for the total (?withTotal=1). The many
        // whole-list callers (loadAllRows, the Sources sidebar, relation-chip
        // fetches) discard it, so we skip the extra (bounded) count for them.
        if (url.searchParams.get('withTotal') === '1') {
          // Approximate total for pagination ("N–M of T", rendered "T+" when capped).
          // Counted through the SAME RLS-scoped relation + filters as the rows above,
          // so a member's total matches what they can actually see; bounded (stops
          // after MAX_ROWS_PAGE+1) so it never becomes a full-table COUNT.
          const approxTotal = await active.db.boundedCount(
            readRelationFor(active, table),
            queryOpts.filters
              ? { filters: queryOpts.filters, cap: MAX_ROWS_PAGE }
              : { cap: MAX_ROWS_PAGE },
          );
          sendJson(res, { rows, approxTotal, totalIsCapped: approxTotal > MAX_ROWS_PAGE });
        } else {
          sendJson(res, { rows });
        }
        return true;
      }
      if (method === 'POST') {
        const body = (await readJson<unknown>(req)) as Row;
        // #3.6 — pass the client edit-id through so a replayed offline POST
        // resolves to the same row (idempotent no-op) instead of a duplicate.
        const editId = headerValue(req, 'x-lattice-edit-id');
        const created = await createRow(mctx, table, body, undefined, editId);
        // A replayed POST (the row already existed) is reported as 200, not
        // 201, so the client can tell a fresh insert from an idempotent no-op.
        sendJson(res, { id: created.id }, created.idempotent ? 200 : 201);
        return true;
      }
    } else {
      if (method === 'GET') {
        // #2.1 — route a masked table's single-row read through `<table>_v`
        // too (base SELECT revoked for members). Build the pk filter from the
        // BASE table's registered key; the view exposes the same columns.
        const readRel = readRelationFor(active, table);
        let row: Row | null;
        if (readRel === table) {
          row = await active.db.get(table, id);
        } else {
          // Masked tables use a single `id` PK in practice; filter the view
          // on the first PK column (fallback `id`) — the view exposes it.
          const pkCol = active.db.getPrimaryKey(table)[0] ?? 'id';
          const found = await active.db.query(readRel, { where: { [pkCol]: id }, limit: 1 });
          row = found[0] ?? null;
        }
        if (row === null) {
          sendJson(res, { error: 'Row not found' }, 404);
          return true;
        }
        // A row the operator can't read already returns null (RLS-filtered /
        // not in the view), so reaching here means the row is visible.
        await attachRowAccess(active.db, table, [row]);
        sendJson(res, row);
        return true;
      }
      if (method === 'PATCH') {
        const body = (await readJson<unknown>(req)) as Partial<Row>;
        await updateRow(mctx, table, id, body);
        sendJson(res, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        const hard = url.searchParams.get('hard') === 'true';
        await deleteRow(mctx, table, id, hard);
        sendJson(res, { ok: true });
        return true;
      }
    }
    sendJson(res, { error: `Method ${method} not allowed` }, 405);
    return true;
  }

  // ── Junction link / unlink: /api/tables/:table/(link|unlink) ───────
  const linkMatch = LINK_PATH.exec(pathname);
  if (linkMatch) {
    const [, rawTable, op] = linkMatch;
    const table = decodeURIComponent(rawTable ?? '');
    if (!active.junctionTables.has(table)) {
      sendJson(res, { error: `Not a junction table: ${table}` }, 400);
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, { error: `Method ${method} not allowed` }, 405);
      return true;
    }
    const body = (await readJson<unknown>(req)) as Row;
    const linkCtx = ctx.buildMutationCtx();
    if (op === 'link') {
      await linkRows(linkCtx, table, body);
    } else {
      await unlinkRows(linkCtx, table, body);
    }
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
