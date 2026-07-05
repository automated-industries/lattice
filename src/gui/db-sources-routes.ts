import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import type { FeedBus } from './feed.js';
import { sendJson, readJson } from './http.js';
import { listConnectors, getConnector, createConnector } from '../connectors/registry.js';
import { syncConnector, syncStaleConnectors } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { enableConnectorRls } from '../connectors/acl.js';
import { ConnectorUnavailableError } from '../connectors/errors.js';
import { DatabaseConnector } from '../connectors/db-source/connector.js';
import { getSchemaDescriptor } from '../connectors/db-source/schema-cache.js';

/**
 * External-database "db-source" routes (`/api/db-sources`) — connect / list /
 * tables / refresh / disconnect / sync-if-stale. A db-source is its OWN connection
 * with its own table set, so (unlike the single-connection generic connect route)
 * every connect CREATES a new registry row keyed on `toolkit = db_source:<id>`.
 * Distinct from the existing `/api/databases` (which switches sibling Lattice
 * config files within a workspace) — different concept, different prefix.
 */
export interface DbSourcesRouteDeps {
  db: Lattice;
  /** Rendered-context output dir, for teardown to prune files. */
  outputDir: string;
  /** Identity that owns connections made in this session. */
  connectedBy: string;
  /**
   * Activity feed — a table import surfaces the same way a file ingest does
   * (a summary line in the feed / status), so connecting a database gives the
   * same live feedback as dropping files.
   */
  feed: FeedBus;
  /** Test seam — substitute connector (defaults to a real DatabaseConnector). */
  connectorOverride?: DatabaseConnector;
}

const ID_RE = /^[a-z0-9-]+$/i;

export async function dispatchDbSourcesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DbSourcesRouteDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/db-sources')) return false;
  const method = req.method ?? 'GET';
  const { db, outputDir, connectedBy } = deps;
  const connector = deps.connectorOverride ?? new DatabaseConnector();

  // List this member's connected databases (+ table count from the descriptor).
  if (pathname === '/api/db-sources' && method === 'GET') {
    const rows = (await listConnectors(db, connectedBy)).filter((c) => c.connector === 'db_source');
    const sources = rows.map((c) => {
      const descriptor = c.connectionRef ? getSchemaDescriptor(c.connectionRef) : null;
      return {
        id: c.id,
        displayName: c.displayName,
        status: c.status,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        tableCount: descriptor ? descriptor.tables.filter((t) => t.selected).length : 0,
      };
    });
    sendJson(res, { sources });
    return true;
  }

  // Connect a new external database → validate, introspect, register, import.
  if (pathname === '/api/db-sources/connect' && method === 'POST') {
    const raw = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
    const creds: Record<string, string> = {};
    for (const f of connector.credentialFields()) {
      const v = raw[f.key];
      creds[f.key] = typeof v === 'string' ? v.trim() : '';
    }
    const schemaVal = raw.schema;
    if (typeof schemaVal === 'string' && schemaVal.trim()) creds.schema = schemaVal.trim();

    let connection: { connectionId: string; displayName: string | null };
    try {
      connection = await connector.connect(creds);
    } catch (e) {
      // Bad credentials / unreachable / unsupported dialect / no tables.
      sendJson(res, { error: (e as Error).message }, 422);
      return true;
    }
    const toolkit = `db_source:${connection.connectionId}`;
    // Always a NEW row — multiple databases coexist (never upsert-by-toolkit).
    const connectorId = await createConnector(db, {
      connector: 'db_source',
      toolkit,
      displayName: connection.displayName ?? 'Database',
      connectionRef: connection.connectionId,
      connectedBy,
    });
    // Phase 1 — SETUP (pre-persistence): define the tables + RLS. A failure here
    // means NO rows or connection data ever landed, so roll the whole connection
    // back (registry row, creds, descriptor) — a failed setup must leave NOTHING
    // behind (no phantom entry in the Databases list). A rollback failure is
    // appended to the error rather than swallowed.
    try {
      for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
      await enableConnectorRls(db, connector, toolkit);
    } catch (e) {
      let rollbackNote = '';
      try {
        await disconnectConnector(db, connector, connectorId, { outputDir, mode: 'hard' });
      } catch (re) {
        rollbackNote = ` (cleanup also failed: ${(re as Error).message} — remove the connection from Databases manually)`;
      }
      sendJson(
        res,
        { error: `Connection setup failed: ${(e as Error).message}${rollbackNote}` },
        isActionable(e) ? 422 : 500,
      );
      return true;
    }

    // Phase 2 — IMPORT (post-persistence): sync the rows. A failure here must NOT
    // discard rows that already imported, nor the connection itself — that
    // all-or-nothing rollback is exactly the "data imports then silently vanishes"
    // bug (a late/derived step throwing after thousands of rows are committed wiped
    // every one of them). syncConnector's own catch has already stamped the
    // registry row status='error' + last_error, and GET /api/db-sources returns
    // every status, so the connection stays visible with its error and the user can
    // Refresh (retry) or Disconnect. Surface the error loudly (no silent failures) and log the
    // raw error server-side first — the registry's last_error is sanitized, so this
    // is the only full-fidelity trace.
    try {
      const result = await syncConnector(db, connector, connectorId);
      publishImportSummary(deps.feed, connection.displayName ?? 'database', result.upserted);
      sendJson(res, { connectorId, displayName: connection.displayName, result });
    } catch (e) {
      console.error(`[latticesql] db-source import failed for connection ${connectorId}:`, e);
      sendJson(
        res,
        {
          error: `Import failed: ${(e as Error).message} — the connection is kept with this error; use Refresh to retry.`,
          connectorId,
        },
        isActionable(e) ? 422 : 500,
      );
    }
    return true;
  }

  // Refresh on GUI load — sync every stale db-source for this member.
  if (pathname === '/api/db-sources/sync-if-stale' && method === 'POST') {
    const r = await syncStaleConnectors(db, connector, undefined, connectedBy);
    sendJson(res, { synced: r.synced, failed: r.failed });
    return true;
  }

  // Per-connection routes: /api/db-sources/<id>[/tables|/refresh]
  const m = /^\/api\/db-sources\/([^/]+)(?:\/(tables|refresh))?$/.exec(pathname);
  if (m) {
    const id = decodeURIComponent(m[1] ?? '');
    const sub = m[2];
    if (!ID_RE.test(id)) {
      sendJson(res, { error: 'Invalid connection id' }, 400);
      return true;
    }
    const rec = await getConnector(db, id);
    if (rec?.connector !== 'db_source' || rec.connectedBy !== connectedBy) {
      sendJson(res, { error: 'Database connection not found' }, 404);
      return true;
    }

    // GET /<id>/tables — the introspected tables (for the UI).
    if (sub === 'tables' && method === 'GET') {
      const descriptor = rec.connectionRef ? getSchemaDescriptor(rec.connectionRef) : null;
      const tables = (descriptor?.tables ?? []).map((t) => ({
        name: t.name,
        columns: t.columns.length,
        pk: t.pk,
        selected: t.selected,
      }));
      sendJson(res, { tables });
      return true;
    }

    // POST /<id>/refresh — re-sync this connection.
    if (sub === 'refresh' && method === 'POST') {
      try {
        const result = await syncConnector(db, connector, id);
        publishImportSummary(deps.feed, rec.displayName ?? 'database', result.upserted);
        sendJson(res, { result });
      } catch (e) {
        sendJson(res, { error: (e as Error).message }, isActionable(e) ? 422 : 500);
      }
      return true;
    }

    // DELETE /<id> — disconnect: soft-delete imported rows, clear stored creds +
    // schema (connector.disconnect), prune context files, and remove the row.
    if (!sub && method === 'DELETE') {
      const result = await disconnectConnector(db, connector, id, { outputDir, mode: 'hard' });
      sendJson(res, { ok: true, result });
      return true;
    }
  }

  return false;
}

function isActionable(err: unknown): boolean {
  return err instanceof ConnectorUnavailableError;
}

/**
 * Surface a table import in the activity feed exactly like a file ingest does —
 * one summary line covering what landed (same live-feedback contract as files).
 */
function publishImportSummary(
  feed: FeedBus,
  displayName: string,
  upserted: Record<string, number>,
): void {
  const tables = Object.keys(upserted);
  if (tables.length === 0) return;
  const rows = Object.values(upserted).reduce((a, b) => a + b, 0);
  feed.publish({
    table: tables[0] ?? 'files',
    op: 'insert',
    rowId: null,
    source: 'system',
    summary: `Imported ${String(rows)} rows across ${String(tables.length)} tables from "${displayName}"`,
  });
}
