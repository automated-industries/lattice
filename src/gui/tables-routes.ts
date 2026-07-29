import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson, parsePageParam, MAX_ROWS_PAGE } from './http.js';
import type { Row } from '../types.js';
import type { GuiRequestContext } from './request-context.js';
import type { ActiveDb } from './active-db.js';
import { readRelationFor, attachRowAccess, isRegisteredTable } from './active-db.js';
import {
  createRow,
  updateRow,
  deleteRow,
  linkRows,
  unlinkRows,
  loadSecretColumns,
  FILES_BYTE_LOCATION_COLS,
} from './mutations.js';
import { previewRowChanges, maskPreviewFields, PREVIEW_DEFAULT_LIMIT } from './change-preview.js';
import { maskedColumnsForTables } from '../cloud/audience.js';
import { ROWS_PATH, LINK_PATH } from './route-paths.js';

/** POST /api/tables/:table/preview-changes — read-only change preview. No overlap
 *  with ROWS_PATH (which requires a `/rows` segment) or any read-route regex. */
const PREVIEW_CHANGES_PATH = /^\/api\/tables\/([^/]+)\/preview-changes$/;

/** Placeholder shown in place of a framework-encrypted column's decrypted value in an API
 *  response (never ship cleartext credentials over HTTP). */
const ENCRYPTED_COL_MASK = '••••••••';

/** For a `files` write via the generic route, refuse (403) any body that sets a byte-location
 *  column. Returns true iff it handled (refused) the request. */
function rejectForgedFilesLocation(table: string, body: unknown, res: ServerResponse): boolean {
  if (table !== 'files' || body === null || typeof body !== 'object') return false;
  const bad = Object.keys(body as Record<string, unknown>).filter((k) =>
    FILES_BYTE_LOCATION_COLS.has(k),
  );
  if (bad.length === 0) return false;
  sendJson(res, { error: `Cannot set file location columns via this API: ${bad.join(', ')}` }, 403);
  return true;
}

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
 * POST /api/tables/:table/preview-changes — a READ-ONLY preview of a proposed
 * row change: which records would be affected and the before/after of every
 * field, without writing anything. Not wired to any approval or confirmation
 * flow — it is a lens, not a gate.
 *
 * Body: { set: {col: value, …}, ids?: string[] | filter?: [{col,op,val}…],
 *         limit?: number, offset?: number }
 * — the same change description the row-mutation tools compute internally
 * (update_row's id + values; bulk_update's filter + set). The row selection and
 * the per-field deltas run through the SAME functions the execution paths use
 * (bulkSelection / rowFieldDeltas via previewRowChanges), so the preview cannot
 * drift from what an execution then does.
 *
 * Bounded: one page-sized SELECT (limit clamped to MAX_ROWS_PAGE) plus one
 * bounded COUNT for the total — never a whole-table scan, however many rows
 * match. Permission-checked like the row reads: registered-table gate, the
 * `secrets` refusal, reads through the member's audience-masked view (so RLS
 * scopes the rows and guarded cells never reach the process), and a serve-time
 * viewer mask — framework-encrypted columns always, plus every column this
 * viewer's read views guard on a scoped cloud connection. A masked field ships
 * as a bare {column, masked:true} marker: no value in either direction and no
 * changed flag (which would be an equality oracle against the guarded cell).
 *
 * Table-level write gates mirror execution: a computed or connected-source
 * table answers 409 with the same "can't be edited" explanation the write
 * paths give, so a preview never promises a change execution would refuse.
 * Column-level write guards (reserved files/dashboards columns) stay at
 * execution — they refuse specific writes loudly; the preview only reads.
 */
async function handlePreviewChanges(
  req: IncomingMessage,
  res: ServerResponse,
  active: ActiveDb,
  table: string,
): Promise<void> {
  if (!isRegisteredTable(active, table)) {
    sendJson(res, { error: `Unknown table: ${table}` }, 400);
    return;
  }
  if (table === 'secrets') {
    sendJson(res, { error: `Table not available via this API: ${table}` }, 403);
    return;
  }
  if (active.db.isComputedTable(table)) {
    sendJson(
      res,
      {
        error: `"${table}" is a computed view and can't be edited directly — there is no change to preview. Change its underlying records or its definition instead.`,
      },
      409,
    );
    return;
  }
  if (active.db.getConnectedSource(table)) {
    sendJson(
      res,
      {
        error: `"${table}" is a live, read-only view of a connected external source and can't be edited — there is no change to preview.`,
      },
      409,
    );
    return;
  }

  const parsed = await readJson<unknown>(req).catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, { error: 'JSON object body required' }, 400);
    return;
  }
  const body = parsed as {
    set?: unknown;
    ids?: unknown;
    filter?: unknown;
    limit?: unknown;
    offset?: unknown;
  };
  if (!body.set || typeof body.set !== 'object' || Array.isArray(body.set)) {
    sendJson(res, { error: 'set object is required (the change to preview)' }, 400);
    return;
  }
  const set = body.set as Record<string, unknown>;
  if (Object.keys(set).length === 0) {
    sendJson(res, { error: 'set must contain at least one field' }, 400);
    return;
  }
  if ('visibility' in set) {
    // Sharing is row-level state, not a column value — there is no field-level
    // before/after to show for it. Refuse rather than previewing a lie.
    sendJson(res, { error: 'sharing settings ("visibility") have no field-level preview' }, 400);
    return;
  }
  if (body.ids !== undefined && body.filter !== undefined) {
    sendJson(res, { error: 'provide ids or filter, not both' }, 400);
    return;
  }
  let ids: string[] | undefined;
  if (body.ids !== undefined) {
    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      !body.ids.every((v) => typeof v === 'string')
    ) {
      sendJson(res, { error: 'ids must be a non-empty array of row ids' }, 400);
      return;
    }
    if (body.ids.length > MAX_ROWS_PAGE) {
      sendJson(res, { error: `ids is limited to ${String(MAX_ROWS_PAGE)} rows per preview` }, 400);
      return;
    }
    ids = body.ids;
  }
  const pageParam = (v: unknown, name: 'limit' | 'offset'): number | 'invalid' => {
    if (v === undefined) return name === 'limit' ? PREVIEW_DEFAULT_LIMIT : 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'invalid';
    return v;
  };
  const limit = pageParam(body.limit, 'limit');
  const offset = pageParam(body.offset, 'offset');
  if (limit === 'invalid' || offset === 'invalid') {
    sendJson(res, { error: 'limit and offset must be non-negative integers' }, 400);
    return;
  }

  let preview;
  try {
    preview = await previewRowChanges(
      active.db,
      table,
      // #2.1 — a member reads an audience-masked table through its `<table>_v`
      // view (base SELECT was revoked), so RLS scopes the rows and a guarded
      // cell never even reaches this process.
      readRelationFor(active, table),
      active.softDeletable,
      set,
      {
        ...(ids ? { ids } : {}),
        ...(body.filter !== undefined ? { filter: body.filter } : {}),
        limit,
        offset,
      },
    );
  } catch (err) {
    // Filter validation (unknown column / bad op) — recoverable input error.
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    return;
  }

  // Serve-time viewer mask. Framework-encrypted columns are ALWAYS masked (an
  // HTTP response never ships a decrypted credential — same rule as the row
  // read route); on a scoped cloud connection, every column the member's read
  // views guard (plus the gui-flagged secret columns) is masked too — the same
  // union the row-history serve path applies.
  const masked = new Set<string>(active.db.getEncryptedColumns(table));
  if (active.db.isCloudMemberOpen()) {
    const guarded = await maskedColumnsForTables(active.db, [table]);
    const flagged = await loadSecretColumns(active.db);
    for (const c of guarded.get(table) ?? []) masked.add(c);
    for (const c of flagged.get(table) ?? []) masked.add(c);
  }
  sendJson(res, { ...preview, rows: maskPreviewFields(preview.rows, masked) });
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

  // ── Read-only change preview: /api/tables/:table/preview-changes ──
  const previewMatch = PREVIEW_CHANGES_PATH.exec(pathname);
  if (previewMatch && method === 'POST') {
    await handlePreviewChanges(req, res, active, decodeURIComponent(previewMatch[1] ?? ''));
    return true;
  }

  // ── Row CRUD: /api/tables/:table/rows[/:id] ───────────────────────
  const rowsMatch = ROWS_PATH.exec(pathname);
  if (rowsMatch) {
    const [, rawTable, rawId] = rowsMatch;
    const table = decodeURIComponent(rawTable ?? '');
    const id = rawId ? decodeURIComponent(rawId) : null;
    if (!isRegisteredTable(active, table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    // The `secrets` credential store is refused on the generic CRUD route entirely (read AND
    // write). `secrets.value` is encrypted-at-rest and DECRYPTED on read, so a bare
    // `GET /api/tables/secrets/rows` here would have shipped cleartext API keys / OAuth tokens
    // as JSON. There is no dedicated secrets HTTP route and the GUI never reads secrets this way,
    // so a blanket refusal is safe. (Chat + `_lattice*` are handled by owner-scoping / the
    // registered-table gate, not refused here — the chat rail legitimately uses this route.)
    if (table === 'secrets') {
      sendJson(res, { error: `Table not available via this API: ${table}` }, 403);
      return true;
    }
    // Defense in depth for a user-DEFINED encrypted column (`encrypted:` in their config): those
    // are also decrypted on read, so mask every framework-encrypted column in any row this route
    // returns. `secrets` is already refused above; this covers everything else.
    const encryptedCols = active.db.getEncryptedColumns(table);
    const maskEncrypted = (row: Row): Row => {
      if (encryptedCols.size === 0) return row;
      const out: Row = { ...row };
      for (const c of encryptedCols) {
        if (c in out && out[c] != null && out[c] !== '') out[c] = ENCRYPTED_COL_MASK;
      }
      return out;
    };
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
        const rows = (await active.db.query(readRelationFor(active, table), queryOpts)).map(
          maskEncrypted,
        );
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
        if (rejectForgedFilesLocation(table, body, res)) return true;
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
        row = maskEncrypted(row);
        await attachRowAccess(active.db, table, [row]);
        sendJson(res, row);
        return true;
      }
      if (method === 'PATCH') {
        const body = (await readJson<unknown>(req)) as Partial<Row>;
        if (rejectForgedFilesLocation(table, body, res)) return true;
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
