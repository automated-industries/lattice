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
import { enableConnectorRls, secureConnectorTables } from '../connectors/acl.js';
import { ConnectorUnavailableError } from '../connectors/jira/connector.js';

/**
 * Connectors settings routes — connect/refresh/disconnect external sources and
 * read connector status. Jira connects with the user's own Atlassian credentials
 * (site URL + email + API token, validated against Jira on connect — no OAuth
 * redirect, no broker key). Sync runs on connect, on manual refresh, and (via
 * /sync-if-stale) on GUI load.
 *
 * User-actionable failures (bad credentials, missing dependency, bad input)
 * answer with a clear error JSON; unexpected errors propagate to the loud 500.
 */

export interface ConnectorsRouteDeps {
  db: Lattice;
  /** The connector implementation serving the GUI (the Jira connector). */
  connector: Connector;
  /** Rendered-context output dir, for teardown to prune files. */
  outputDir: string;
  /** Identity that owns connections made in this session (member role / user id). */
  connectedBy: string;
}

/** Map a ConnectorUnavailableError (no dep / no stored creds) to a 422 the GUI can show. */
function isActionable(err: unknown): err is Error {
  return err instanceof ConnectorUnavailableError;
}

/** A connector that connects via direct credentials (validated + stored), not an OAuth redirect. */
type CredentialConnector = Connector & {
  connect(creds: { site: string; email: string; apiToken: string }): Promise<{
    connectionId: string;
    displayName: string | null;
  }>;
};
function supportsCredentialConnect(c: Connector): c is CredentialConnector {
  return typeof (c as Partial<CredentialConnector>).connect === 'function';
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
    // GET /api/connectors — list THIS member's connectors + the available toolkits.
    if (pathname === '/api/connectors' && method === 'GET') {
      const connectors = await listConnectors(db, connectedBy);
      sendJson(res, {
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

    // POST /api/connectors/sync-if-stale — GUI-load refresh hook.
    if (pathname === '/api/connectors/sync-if-stale' && method === 'POST') {
      // Owner-only no-op: ensure connected tables created in any member's session
      // are RLS-secured on the cloud (the owner auto-secures on open).
      await secureConnectorTables(db, connector);
      // Scope to THIS member — never sync another member's connectors as ourselves.
      const { synced, failed } = await syncStaleConnectors(db, connector, undefined, connectedBy);
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

      // POST /api/connectors/<toolkit>/connect — validate credentials, store them,
      // record the connection + run the initial sync. Idempotent: reconnecting
      // reuses this (toolkit, member)'s registry row and retires the old creds.
      if (action === 'connect' && method === 'POST') {
        if (!supportsCredentialConnect(connector)) {
          sendJson(
            res,
            { error: `Toolkit "${toolkit}" does not support credential connect.` },
            400,
          );
          return true;
        }
        const body = await readJson<{ site?: unknown; email?: unknown; token?: unknown }>(
          req,
        ).catch(() => ({}) as { site?: unknown; email?: unknown; token?: unknown });
        const site = typeof body.site === 'string' ? body.site.trim().replace(/\/+$/, '') : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (!site || !email || !token) {
          sendJson(res, { error: 'site, email, and token are all required' }, 400);
          return true;
        }
        if (!/^https?:\/\//i.test(site)) {
          sendJson(
            res,
            { error: 'site must be a full URL, e.g. https://your-domain.atlassian.net' },
            400,
          );
          return true;
        }
        let connection: { connectionId: string; displayName: string | null };
        try {
          connection = await connector.connect({ site, email, apiToken: token });
        } catch (e) {
          // Bad credentials / unreachable site — surface the specific reason.
          sendJson(res, { error: (e as Error).message }, 422);
          return true;
        }
        const existing = await getConnectorByToolkit(db, toolkit, connectedBy);
        let connectorId: string;
        if (existing) {
          // Retire the prior connection's stored credentials before repointing.
          if (existing.connectionRef && existing.connectionRef !== connection.connectionId) {
            await connector.disconnect(existing.connectionRef);
          }
          await updateConnectorConnection(db, existing.id, connection.connectionId);
          connectorId = existing.id;
        } else {
          connectorId = await createConnector(db, {
            connector: connector.connector,
            toolkit,
            displayName: connection.displayName ?? toolkit,
            connectionRef: connection.connectionId,
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
