import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { sendJson, readJson } from './http.js';
import type { Connector } from '../connectors/types.js';
import {
  listConnectors,
  getConnector,
  createConnector,
  getConnectorByToolkit,
} from '../connectors/registry.js';
import { syncConnector, syncStaleConnectors } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import {
  getComposioApiKey,
  setComposioApiKey,
  clearComposioApiKey,
  ConnectorUnavailableError,
} from '../connectors/composio/client.js';

/**
 * Connectors settings routes — connect/refresh/disconnect external sources and
 * read connector status. The connect flow is a Composio OAuth redirect; sync
 * runs on connect, on manual refresh, and (via /sync-if-stale) on GUI load.
 *
 * User-actionable failures (missing API key / dependency, bad input) answer with
 * a clear error JSON; unexpected errors propagate to the server's loud 500.
 */

export interface ConnectorsRouteDeps {
  db: Lattice;
  /** The connector implementation serving the GUI (e.g. the Composio connector). */
  connector: Connector;
  /** Rendered-context output dir, for teardown to prune files. */
  outputDir: string;
  /** Identity that owns connections made in this session (member role / user id). */
  connectedBy: string;
}

/** Map a ConnectorUnavailableError (no key / no dep) to a 422 the GUI can show. */
function isActionable(err: unknown): err is Error {
  return err instanceof ConnectorUnavailableError;
}

export async function dispatchConnectorsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorsRouteDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  if (!pathname.startsWith('/api/connectors')) return false;

  const { db, connector, outputDir, connectedBy } = deps;

  try {
    // GET /api/connectors — list connectors + whether the Composio key is set.
    if (pathname === '/api/connectors' && method === 'GET') {
      const connectors = await listConnectors(db);
      sendJson(res, {
        apiKeySet: getComposioApiKey() !== null,
        toolkits: connector.toolkits(),
        connectors: connectors.map((c) => ({
          id: c.id,
          toolkit: c.toolkit,
          displayName: c.displayName,
          status: c.status,
          lastSyncAt: c.lastSyncAt,
          lastError: c.lastError,
        })),
      });
      return true;
    }

    // PUT/DELETE /api/connectors/composio-key — manage the workspace API key.
    if (pathname === '/api/connectors/composio-key') {
      if (method === 'PUT') {
        const body = await readJson<{ key?: unknown }>(req).catch(() => ({}) as { key?: unknown });
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key) {
          sendJson(res, { error: 'key is required' }, 400);
          return true;
        }
        setComposioApiKey(key);
        sendJson(res, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        clearComposioApiKey();
        sendJson(res, { ok: true });
        return true;
      }
    }

    // POST /api/connectors/sync-if-stale — GUI-load refresh hook.
    if (pathname === '/api/connectors/sync-if-stale' && method === 'POST') {
      const results = await syncStaleConnectors(db, connector);
      sendJson(res, { synced: results.length });
      return true;
    }

    // /api/connectors/<toolkit>/<action>
    const rest = pathname.slice('/api/connectors/'.length).split('/');
    const toolkit = rest[0] ?? '';
    const action = rest[1] ?? '';
    if (toolkit && connector.toolkits().includes(toolkit)) {
      // GET /api/connectors/<toolkit>/models — the connected data types + visibility.
      if (action === 'models' && method === 'GET') {
        sendJson(res, {
          models: connector.models(toolkit).map((m) => ({
            model: m.model,
            table: m.table,
            defaultVisibility: m.definition.source?.defaultVisibility ?? 'private',
          })),
        });
        return true;
      }

      // POST /api/connectors/<toolkit>/authorize — begin OAuth, return redirect URL.
      if (action === 'authorize' && method === 'POST') {
        const { redirectUrl, pendingId } = await connector.authorize(connectedBy, toolkit);
        sendJson(res, { redirectUrl, pendingId });
        return true;
      }

      // POST /api/connectors/<toolkit>/finalize — record the connection + initial sync.
      if (action === 'finalize' && method === 'POST') {
        const { connectionId } = await connector.completeAuth(connectedBy, toolkit);
        const connectorId = await createConnector(db, {
          connector: connector.connector,
          toolkit,
          displayName: toolkit,
          composioConnectionId: connectionId,
          connectedBy,
        });
        const result = await syncConnector(db, connector, connectorId);
        sendJson(res, { connectorId, result });
        return true;
      }

      // POST /api/connectors/<toolkit>/refresh — manual re-sync.
      if (action === 'refresh' && method === 'POST') {
        const body = await readJson<{ connectorId?: unknown }>(req).catch(
          () => ({}) as { connectorId?: unknown },
        );
        const connectorId =
          typeof body.connectorId === 'string'
            ? body.connectorId
            : (await getConnectorByToolkit(db, toolkit, connectedBy))?.id;
        if (!connectorId) {
          sendJson(res, { error: `No connected ${toolkit} to refresh` }, 404);
          return true;
        }
        const result = await syncConnector(db, connector, connectorId);
        sendJson(res, { result });
        return true;
      }

      // DELETE /api/connectors/<toolkit> — disconnect + teardown.
      if (!action && method === 'DELETE') {
        const body = await readJson<{ connectorId?: unknown }>(req).catch(
          () => ({}) as { connectorId?: unknown },
        );
        const connectorId =
          typeof body.connectorId === 'string'
            ? body.connectorId
            : (await getConnectorByToolkit(db, toolkit, connectedBy))?.id;
        if (!connectorId || !(await getConnector(db, connectorId))) {
          sendJson(res, { error: `No connected ${toolkit} to disconnect` }, 404);
          return true;
        }
        const result = await disconnectConnector(db, connector, connectorId, { outputDir });
        sendJson(res, { result });
        return true;
      }
    }

    return false;
  } catch (err) {
    if (isActionable(err)) {
      sendJson(res, { error: err.message }, 422);
      return true;
    }
    throw err; // unexpected — surfaced loudly by the server's 500 handler
  }
}
