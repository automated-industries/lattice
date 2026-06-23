import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { sendJson, readJson } from './http.js';
import type { Connector } from '../connectors/types.js';
import {
  listConnectors,
  getConnector,
  createConnector,
  getConnectorByToolkit,
  updateConnectorConnection,
} from '../connectors/registry.js';
import { syncConnector, syncStaleConnectors } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { enableConnectorRls } from '../connectors/acl.js';
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
    // GET /api/connectors — list THIS member's connectors + whether the key is set.
    if (pathname === '/api/connectors' && method === 'GET') {
      const connectors = await listConnectors(db, connectedBy);
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
      const { synced, failed } = await syncStaleConnectors(db, connector);
      sendJson(res, { synced: synced.length, failed: failed.length });
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
      // Idempotent: re-running OAuth reuses the existing connector for this
      // (toolkit, member) instead of orphaning the prior one with a duplicate row.
      if (action === 'finalize' && method === 'POST') {
        const { connectionId } = await connector.completeAuth(connectedBy, toolkit);
        const existing = await getConnectorByToolkit(db, toolkit, connectedBy);
        let connectorId: string;
        if (existing) {
          await updateConnectorConnection(db, existing.id, connectionId);
          connectorId = existing.id;
        } else {
          connectorId = await createConnector(db, {
            connector: connector.connector,
            toolkit,
            displayName: toolkit,
            composioConnectionId: connectionId,
            connectedBy,
          });
        }
        // Define + (owner-only) secure the connected tables before ingest, so a
        // cloud owner's rows are RLS-stamped on insert. No-op off-cloud/non-owner.
        for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
        await enableConnectorRls(db, connector, toolkit);
        const result = await syncConnector(db, connector, connectorId);
        sendJson(res, { connectorId, result });
        return true;
      }

      // Resolve the target connector for refresh/disconnect, verifying OWNERSHIP
      // at the app layer (a caller-supplied id must belong to this member — never
      // trust RLS alone, since the app connection is BYPASSRLS).
      const resolveOwned = async (
        bodyId: unknown,
      ): Promise<{ id: string } | { error: string; status: number }> => {
        if (typeof bodyId === 'string') {
          const rec = await getConnector(db, bodyId);
          if (rec?.connectedBy !== connectedBy) {
            return { error: 'connector not found', status: 404 };
          }
          return { id: rec.id };
        }
        const rec = await getConnectorByToolkit(db, toolkit, connectedBy);
        if (!rec) return { error: `No connected ${toolkit}`, status: 404 };
        return { id: rec.id };
      };

      // POST /api/connectors/<toolkit>/refresh — manual re-sync.
      if (action === 'refresh' && method === 'POST') {
        const body = await readJson<{ connectorId?: unknown }>(req).catch(
          () => ({}) as { connectorId?: unknown },
        );
        const owned = await resolveOwned(body.connectorId);
        if ('error' in owned) {
          sendJson(res, { error: owned.error }, owned.status);
          return true;
        }
        const result = await syncConnector(db, connector, owned.id);
        sendJson(res, { result });
        return true;
      }

      // DELETE /api/connectors/<toolkit> — disconnect + teardown.
      if (!action && method === 'DELETE') {
        const body = await readJson<{ connectorId?: unknown }>(req).catch(
          () => ({}) as { connectorId?: unknown },
        );
        const owned = await resolveOwned(body.connectorId);
        if ('error' in owned) {
          sendJson(res, { error: owned.error }, owned.status);
          return true;
        }
        const result = await disconnectConnector(db, connector, owned.id, { outputDir });
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
