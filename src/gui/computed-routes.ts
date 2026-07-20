import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http.js';
import type { GuiRequestContext } from './request-context.js';
import { narrowComputedDef } from '../config/parser.js';
import type { ComputedTableDef } from '../config/types.js';
import { denyIfNotCloudOwner } from './schema-routes.js';
import {
  createComputedTable,
  updateComputedTable,
  deleteComputedTable,
  previewComputedTable,
  refreshComputedTable,
  listComputedTables,
  reachableFields,
} from './computed-ops.js';

/**
 * Computed-table HTTP surface (`/api/computed-tables`) — list / inspect /
 * field-picker / preview / create / update / delete / refresh. A flat
 * boolean-handled leaf in the ordered dispatch registry (registered in
 * server.ts next to the schema routes), delegating every mutation to the
 * audited primitives in `computed-ops.ts`.
 *
 * Mutating verbs (and the preview/refresh POSTs, which belong to the same
 * owner-side builder) are gated exactly like the schema-mutation routes: a
 * scoped team-cloud member gets a 403 from {@link denyIfNotCloudOwner} —
 * these paths write the owner's on-disk config and run DDL, neither of which
 * RLS protects.
 */

/** Process-constant deps (mirrors SchemaRoutesDeps). */
export interface ComputedRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. Closure const in server.ts. */
  host: string;
}

/** Narrow a request body's `def`, mapping a shape error to a thrown message. */
function narrowDefOrThrow(name: string, raw: unknown): ComputedTableDef {
  if (raw === undefined || raw === null) throw new Error('def is required');
  return narrowComputedDef(name, raw);
}

export async function handleComputedRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: ComputedRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/computed-tables')) return false;
  const method = req.method ?? 'GET';
  const active = ctx.active();
  const sessionId = ctx.sessionId;

  // ── List: definitions + per-field fill state ──
  if (method === 'GET' && pathname === '/api/computed-tables') {
    sendJson(res, { tables: await listComputedTables(active) });
    return true;
  }

  // ── Field picker: what a definition on `base` could reference ──
  // (Registered before /:name — "fields" would otherwise match as a name.)
  if (method === 'GET' && pathname === '/api/computed-tables/fields') {
    const base = url.searchParams.get('base') ?? '';
    try {
      sendJson(res, { fields: reachableFields(active, base) });
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // ── Preview: dry-run a definition (no DDL, no persist, no audit) ──
  if (method === 'POST' && pathname === '/api/computed-tables/preview') {
    if (await denyIfNotCloudOwner(active.db, res, 'preview a computed table')) return true;
    const body = (await readJson<unknown>(req)) as { def?: unknown; limit?: unknown };
    try {
      const def = narrowDefOrThrow('preview', body.def);
      const limit = typeof body.limit === 'number' ? body.limit : 50;
      sendJson(res, await previewComputedTable(active, def, limit));
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // ── Create ──
  if (method === 'POST' && pathname === '/api/computed-tables') {
    if (await denyIfNotCloudOwner(active.db, res, 'create a computed table')) return true;
    const body = (await readJson<unknown>(req)) as { name?: unknown; def?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendJson(res, { error: 'name is required' }, 400);
      return true;
    }
    try {
      const def = narrowDefOrThrow(name, body.def);
      await createComputedTable(active, name, def, sessionId);
      sendJson(res, { ok: true, name });
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // ── Per-table routes: /api/computed-tables/:name[/refresh] ──
  const m = /^\/api\/computed-tables\/([^/]+)(?:\/(refresh))?$/.exec(pathname);
  if (!m) return false;
  const name = decodeURIComponent(m[1] ?? '');
  const sub = m[2];

  // ── Inspect: definition + compiled SQL (for display) ──
  if (!sub && method === 'GET') {
    const info = (await listComputedTables(active)).find((t) => t.name === name);
    if (!info) {
      sendJson(res, { error: `Unknown computed table "${name}"` }, 404);
      return true;
    }
    const compiled = active.db.getComputedRegistration()?.compiled.get(name);
    sendJson(res, { def: info.def, sql: compiled?.selectSql ?? null });
    return true;
  }

  // ── Update ──
  if (!sub && method === 'PUT') {
    if (await denyIfNotCloudOwner(active.db, res, 'update a computed table')) return true;
    const body = (await readJson<unknown>(req)) as { def?: unknown };
    try {
      const def = narrowDefOrThrow(name, body.def);
      await updateComputedTable(active, name, def, sessionId);
      sendJson(res, { ok: true });
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // ── Delete (refused while other computed tables are built on it) ──
  if (!sub && method === 'DELETE') {
    if (await denyIfNotCloudOwner(active.db, res, 'delete a computed table')) return true;
    try {
      await deleteComputedTable(active, name, sessionId);
      sendJson(res, { ok: true });
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // ── Refresh: run the AI fill, streaming per-field progress as NDJSON ──
  if (sub === 'refresh' && method === 'POST') {
    if (await denyIfNotCloudOwner(active.db, res, 'refresh a computed table')) return true;
    const body = (await readJson<unknown>(req).catch(() => ({}))) as { fields?: unknown };
    const fields =
      Array.isArray(body.fields) && body.fields.every((f) => typeof f === 'string')
        ? body.fields
        : undefined;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    });
    const emit = (p: object): void => {
      res.write(JSON.stringify(p) + '\n');
    };
    try {
      await refreshComputedTable(active, name, { ...(fields ? { fields } : {}), sessionId }, emit);
      emit({ done: true });
    } catch (e) {
      // The headers are already out as a 200 stream — the error rides the
      // stream itself (same contract as the import apply route).
      emit({ phase: 'error', message: (e as Error).message });
    }
    res.end();
    return true;
  }

  return false;
}
