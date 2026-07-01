import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { sendJson, readJson } from './http.js';
import type { Connector, CredentialField } from '../connectors/types.js';
import { isCredentialConnector, isMcpConnector } from '../connectors/types.js';
import type { McpConnector } from '../connectors/types.js';
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
import { ConnectorUnavailableError } from '../connectors/errors.js';
import { peekPendingConnect } from '../connectors/mcp/oauth.js';

/**
 * Connectors settings routes — connect/refresh/disconnect external sources and
 * read connector status. Many connectors are served at once; each declares its
 * presentation (label + logo) and, for credential connectors, its credential
 * form, so the route + GUI are fully data-driven and adding a connector touches
 * neither. Credential connectors validate the submitted credentials against the
 * source on connect (no OAuth redirect, no broker key). Sync runs on connect, on
 * manual refresh, and (via /sync-if-stale) on GUI load.
 *
 * User-actionable failures (bad credentials, missing dependency, bad input)
 * answer with a clear error JSON; unexpected errors propagate to the loud 500.
 */

export interface ConnectorsRouteDeps {
  db: Lattice;
  /** The connector implementations serving the GUI (one per built-in toolkit). */
  connectors: Connector[];
  /** Rendered-context output dir, for teardown to prune files. */
  outputDir: string;
  /** Identity that owns connections made in this session (member role / user id). */
  connectedBy: string;
}

/** Map a ConnectorUnavailableError (no dep / no stored creds / bad input) to a 422 the GUI can show. */
function isActionable(err: unknown): err is Error {
  return err instanceof ConnectorUnavailableError;
}

/** Index connectors by toolkit (first wins — a toolkit collision is a wiring bug). */
function indexByToolkit(connectors: Connector[]): Map<string, Connector> {
  const map = new Map<string, Connector>();
  for (const c of connectors) {
    for (const tk of c.toolkits()) {
      if (!map.has(tk)) map.set(tk, c);
    }
  }
  return map;
}

interface ToolkitDescriptor {
  toolkit: string;
  label: string;
  icon?: string;
  /** How this toolkit connects, so the GUI renders the right affordance. */
  connectVia: 'credential' | 'mcp';
  credentialFields?: CredentialField[];
  helpUrl?: string;
  /** MCP: the user must supply the server URL at connect (no default endpoint). */
  needsServerUrl?: boolean;
}

/** A toolkit's presentation + connect affordance, for the GET /api/connectors response. */
function toolkitDescriptor(connector: Connector, toolkit: string): ToolkitDescriptor {
  const pres = connector.presentation(toolkit);
  const out: ToolkitDescriptor = { toolkit, label: pres.label, connectVia: 'credential' };
  if (pres.icon !== undefined) out.icon = pres.icon;
  if (isMcpConnector(connector)) {
    out.connectVia = 'mcp';
    const server = connector.mcpServers(toolkit)[0];
    if (server && !server.url && !server.command) out.needsServerUrl = true;
  } else if (isCredentialConnector(connector)) {
    out.credentialFields = connector.credentialFields();
    const help = connector.helpUrl?.();
    if (help !== undefined) out.helpUrl = help;
  }
  return out;
}

/** The loopback OAuth callback for THIS GUI origin (works in browser + desktop webview). */
function mcpOAuthRedirectUri(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}/api/connectors/oauth/callback`;
}

/** A minimal HTML page shown at the end of the browser OAuth round-trip. */
function oauthResultPage(message: string): string {
  const safe = message.replace(
    /[<>&]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c,
  );
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Lattice</title>` +
    `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>` +
    `</head><body><h2>Lattice</h2><p>${safe}</p></body></html>`
  );
}

/**
 * Upsert the registry row for an established MCP connection, define + secure its
 * connected tables, and run the initial sync. Shared by the direct connect path
 * (open/stdio server) and the OAuth callback.
 */
async function finishMcpConnection(
  deps: ConnectorsRouteDeps,
  connector: McpConnector,
  toolkit: string,
  connectionId: string,
  displayName: string | null,
): Promise<{ connectorId: string; result: unknown }> {
  const { db, connectedBy } = deps;
  const existing = await getConnectorByToolkit(db, toolkit, connectedBy);
  let connectorId: string;
  if (existing) {
    if (existing.connectionRef && existing.connectionRef !== connectionId) {
      await connector.disconnect(existing.connectionRef);
    }
    await updateConnectorConnection(db, existing.id, connectionId);
    connectorId = existing.id;
  } else {
    connectorId = await createConnector(db, {
      connector: connector.connector,
      toolkit,
      displayName: displayName ?? toolkit,
      connectionRef: connectionId,
      connectedBy,
    });
  }
  for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
  await enableConnectorRls(db, connector, toolkit);
  const result = await syncConnector(db, connector, connectorId);
  return { connectorId, result };
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

  const { db, connectors, outputDir, connectedBy } = deps;
  const byToolkit = indexByToolkit(connectors);

  try {
    // GET /api/connectors — list THIS member's connectors + the available toolkits
    // (each with its presentation + credential form so the GUI renders no per-
    // connector code).
    if (pathname === '/api/connectors' && method === 'GET') {
      const connected = await listConnectors(db, connectedBy);
      const toolkits: ReturnType<typeof toolkitDescriptor>[] = [];
      for (const c of connectors) {
        for (const tk of c.toolkits()) toolkits.push(toolkitDescriptor(c, tk));
      }
      sendJson(res, {
        toolkits,
        connectors: connected.map((c) => ({
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

    // POST /api/connectors/sync-if-stale — GUI-load refresh hook. Loops every
    // connector; each filters to its own registry rows, so no cross-talk.
    if (pathname === '/api/connectors/sync-if-stale' && method === 'POST') {
      let synced = 0;
      let failed = 0;
      for (const connector of connectors) {
        // Owner-only no-op: ensure connected tables created in any member's session
        // are RLS-secured on the cloud (the owner auto-secures on open).
        await secureConnectorTables(db, connector);
        // Scope to THIS member — never sync another member's connectors as ourselves.
        const r = await syncStaleConnectors(db, connector, undefined, connectedBy);
        synced += r.synced.length;
        failed += r.failed.length;
      }
      sendJson(res, { synced, failed });
      return true;
    }

    // GET /api/connectors/oauth/callback — the per-server MCP OAuth redirect lands
    // here (loopback, same origin as the GUI). Resolve the pending connection,
    // exchange the code, then upsert + sync. Returns an HTML page for the browser.
    if (pathname === '/api/connectors/oauth/callback' && method === 'GET') {
      const errParam = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const htmlErr = (msg: string, status = 400): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(oauthResultPage(msg));
      };
      if (errParam) {
        htmlErr(`Authorization was denied or failed (${errParam}). You can close this tab.`);
        return true;
      }
      if (!code || !state) {
        htmlErr('Missing authorization code — restart the connect flow from Lattice.');
        return true;
      }
      const pending = peekPendingConnect(state);
      if (!pending) {
        htmlErr(
          'This connection request expired or was already completed. Restart it from Lattice.',
        );
        return true;
      }
      const mcp = byToolkit.get(pending.toolkit);
      if (!mcp || !isMcpConnector(mcp)) {
        htmlErr('Unknown connector for this authorization.');
        return true;
      }
      try {
        const { connectionId, displayName } = await mcp.completeConnect(state, { code });
        await finishMcpConnection(deps, mcp, pending.toolkit, connectionId, displayName);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          oauthResultPage(
            `Connected ${mcp.presentation(pending.toolkit).label}. You can close this tab and return to Lattice.`,
          ),
        );
      } catch (e) {
        if (isActionable(e)) {
          htmlErr(e.message, 422);
          return true;
        }
        htmlErr('Failed to finish connecting. Check the Lattice logs and try again.', 500);
      }
      return true;
    }

    // /api/connectors/<toolkit>/<action>
    const rest = pathname.slice('/api/connectors/'.length).split('/');
    const toolkit = rest[0] ?? '';
    const action = rest[1] ?? '';
    const connector = toolkit ? byToolkit.get(toolkit) : undefined;
    if (toolkit && connector) {
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
        // MCP connectors: begin per-server OAuth (return a redirect the GUI opens),
        // or — for an open/stdio server — connect + sync immediately.
        if (isMcpConnector(connector)) {
          const raw = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          const serverUrl =
            typeof raw.serverUrl === 'string' && raw.serverUrl.trim()
              ? raw.serverUrl.trim()
              : undefined;
          const begin = await connector.beginConnect(connectedBy, toolkit, {
            redirectUri: mcpOAuthRedirectUri(req),
            ...(serverUrl ? { serverUrl } : {}),
          });
          if (begin.kind === 'redirect') {
            sendJson(res, { redirectUrl: begin.redirectUrl, pendingId: begin.pendingId });
            return true;
          }
          const out = await finishMcpConnection(
            deps,
            connector,
            toolkit,
            begin.connectionId,
            begin.displayName,
          );
          sendJson(res, out);
          return true;
        }
        if (!isCredentialConnector(connector)) {
          sendJson(
            res,
            { error: `Toolkit "${toolkit}" does not support credential connect.` },
            400,
          );
          return true;
        }
        // Generic credential read: collect every declared field by key, coercing
        // to string + trimming. Presence-check the required fields here (400);
        // format/auth validation lives in the connector's connect() (→ 422).
        const raw = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const fields = connector.credentialFields();
        const creds: Record<string, string> = {};
        const missing: string[] = [];
        for (const f of fields) {
          const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : '';
          creds[f.key] = v;
          if (f.required !== false && !v) missing.push(f.key);
        }
        if (missing.length > 0) {
          sendJson(
            res,
            { error: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required` },
            400,
          );
          return true;
        }
        let connection: { connectionId: string; displayName: string | null };
        try {
          connection = await connector.connect(creds);
        } catch (e) {
          // Bad credentials / bad input / unreachable source — surface the reason.
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
