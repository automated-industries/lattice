import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import type { FeedBus } from './feed.js';
import { sendJson, readJson } from './http.js';
import { listConnectors, getConnector } from '../connectors/registry.js';
import { syncConnector, syncStaleConnectors } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { ConnectorUnavailableError } from '../connectors/errors.js';
import {
  DatabaseConnector,
  describeDbSourceConnection,
} from '../connectors/db-source/connector.js';
import { getSchemaDescriptor } from '../connectors/db-source/schema-cache.js';
import {
  connectDatabaseSource,
  reconnectDatabaseSource,
  type DatabaseSourceConnected,
} from '../ops/connect-source.js';
import { connectorErrorCode, type ConnectorError } from '../ops/connector-errors.js';

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

/**
 * What a tagged connect-a-database failure means on this transport.
 *
 * The capability refuses with a situation rather than a number, because the same
 * call serves a command line and a library caller that have no statuses at all.
 * The two 500s are the ones that are genuinely ours: a setup that had to be
 * rolled back, and an import that failed after rows were already landing.
 */
const STATUS_FOR_CONNECTOR_ERROR: Record<string, number> = {
  invalid_request: 400,
  unsupported: 400,
  connector_not_found: 404,
  source_rejected: 422,
  source_unavailable: 422,
  setup_failed: 500,
  import_failed: 500,
};

/**
 * Answer a tagged refusal, or rethrow anything that is not one.
 *
 * `connectorId` rides along when the failure LEFT the connection in place — the
 * import half — because the caller needs its id to retry or remove it. A failure
 * that kept something and did not say what would be the quiet part of a loud
 * failure.
 */
function sendConnectorError(res: ServerResponse, err: unknown): void {
  const code = connectorErrorCode(err);
  if (!code) throw err;
  const tagged = err as ConnectorError;
  sendJson(
    res,
    {
      error: tagged.message,
      ...(tagged.connectorId !== undefined ? { connectorId: tagged.connectorId } : {}),
    },
    STATUS_FOR_CONNECTOR_ERROR[code] ?? 500,
  );
}

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
      // The (non-secret) host + database are surfaced so the full-width
      // Databases table can show which server/db each row points at without a
      // per-row fetch. The password is never included (same contract as the
      // /connection endpoint).
      const parts = c.connectionRef ? describeDbSourceConnection(c.connectionRef) : null;
      return {
        id: c.id,
        displayName: c.displayName,
        status: c.status,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        host: parts?.host ?? null,
        database: parts?.database ?? null,
        schema: parts?.schema ?? null,
        tableCount: descriptor ? descriptor.tables.filter((t) => t.selected).length : 0,
      };
    });
    sendJson(res, { sources });
    return true;
  }

  // Connect a new external database → validate, introspect, register, import.
  // The two failure halves (a rolled-back setup, a kept-but-errored import) are
  // the capability's to distinguish; this route only turns each into a status.
  // @capability connector.connect-database
  if (pathname === '/api/db-sources/connect' && method === 'POST') {
    const raw = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
    let out: DatabaseSourceConnected;
    try {
      out = await connectDatabaseSource(db, {
        credentials: raw,
        connectedBy,
        outputDir,
        ...(deps.connectorOverride ? { connector: deps.connectorOverride } : {}),
      });
    } catch (e) {
      sendConnectorError(res, e);
      return true;
    }
    publishImportSummary(deps.feed, out.displayName ?? 'database', out.result.upserted);
    sendJson(res, {
      connectorId: out.connectorId,
      displayName: out.displayName,
      result: out.result,
    });
    return true;
  }

  // Refresh on GUI load — sync every stale db-source for this member.
  // @capability connector.sync-stale
  if (pathname === '/api/db-sources/sync-if-stale' && method === 'POST') {
    const r = await syncStaleConnectors(db, connector, undefined, connectedBy);
    sendJson(res, { synced: r.synced, failed: r.failed });
    return true;
  }

  // Per-connection routes: /api/db-sources/<id>[/tables|/refresh|/reconnect|/connection]
  const m = /^\/api\/db-sources\/([^/]+)(?:\/(tables|refresh|reconnect|connection))?$/.exec(
    pathname,
  );
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

    // GET /<id>/connection — the NON-SECRET connection parts, for pre-filling the
    // edit form. The password is never returned (Lattice does not echo secrets).
    if (sub === 'connection' && method === 'GET') {
      const parts = rec.connectionRef ? describeDbSourceConnection(rec.connectionRef) : null;
      if (!parts) {
        sendJson(res, { error: 'This connection cannot be edited.' }, 400);
        return true;
      }
      sendJson(res, { connection: { ...parts, displayName: rec.displayName } });
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

    // POST /<id>/reconnect — edit the stored credentials (rotated password,
    // corrected host/port) and re-sync. Reuses the same connection id + table
    // prefix so the imported objects stay put and rows upsert idempotently.
    // @capability connector.reconnect-database
    if (sub === 'reconnect' && method === 'POST') {
      const raw = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      let out: DatabaseSourceConnected;
      try {
        out = await reconnectDatabaseSource(db, {
          connectorId: id,
          credentials: raw,
          connectedBy,
          outputDir,
          ...(deps.connectorOverride ? { connector: deps.connectorOverride } : {}),
        });
      } catch (e) {
        sendConnectorError(res, e);
        return true;
      }
      publishImportSummary(deps.feed, out.displayName ?? 'database', out.result.upserted);
      sendJson(res, { ok: true, result: out.result });
      return true;
    }

    // POST /<id>/refresh — re-sync this connection.
    // @capability connector.sync
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
    // @capability connector.disconnect
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
