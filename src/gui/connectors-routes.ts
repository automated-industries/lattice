import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { countItemsBySourceConnector } from '../connectors/item-counts.js';
import { sendJson, readJson } from './http.js';
import type { Connector, CredentialField } from '../connectors/types.js';
import { isCredentialConnector, isMcpConnector } from '../connectors/types.js';
import type { PrefabCatalog } from '../connectors/prefab/index.js';
import {
  listConnectors,
  getConnector,
  getConnectorByToolkit,
  classifyConnectorFailure,
  isSetupIncomplete,
} from '../connectors/registry.js';
import { syncConnector } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { ConnectorUnavailableError } from '../connectors/errors.js';
import {
  peekPendingConnect,
  takePendingConnect,
  clearMcpConnection,
  getMcpServerUrl,
} from '../connectors/mcp/oauth.js';
import { connectionIdFromToolkit } from '../connectors/mcp/schema-cache.js';
import {
  connectSource,
  completeMcpConnection,
  mcpConnectionLabel,
  refreshStaleSources,
  type SourceConnectRequest,
} from '../ops/connect-source.js';
import { connectorErrorCode, type ConnectorErrorCode } from '../ops/connector-errors.js';

/**
 * What a tagged connect-a-source failure means on this transport.
 *
 * The capability layer refuses with a situation, not a number, because the same
 * call serves a command line and a library caller that have no statuses at all.
 * Turning one into the other is this adapter's job, and it is the only place the
 * mapping exists.
 */
const STATUS_FOR_CONNECTOR_ERROR: Record<ConnectorErrorCode, number> = {
  invalid_request: 400,
  unsupported: 400,
  connector_not_found: 404,
  source_rejected: 422,
  source_unavailable: 422,
  setup_failed: 500,
  import_failed: 500,
};

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
  /** The prefab connector catalog (curated + registry metadata). Omit to disable the grid. */
  catalog?: PrefabCatalog;
}

/** Map a ConnectorUnavailableError (no dep / no stored creds / bad input) to a 422 the GUI can show. */
function isActionable(err: unknown): err is Error {
  return err instanceof ConnectorUnavailableError;
}

/**
 * A curated, user-facing reason for a connect failure, or null when the cause is
 * unknown (→ the generic 500, which is now logged for diagnosis). We never surface
 * a raw non-curated error string to the browser; only known, safe patterns get a
 * specific message.
 */
export function connectFailureHint(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  // A failure with a shared classification always reads as its curated message, on every path.
  const known = classifyConnectorFailure(raw);
  if (known) return known.message;
  if (err instanceof ConnectorUnavailableError) return err.message;
  const msg = raw.toLowerCase();
  if (
    /invalid_grant|code (?:has )?(?:expired|already been used|already used)|expired.*code/.test(msg)
  )
    return 'The authorization code expired or was already used — click Connect again to get a fresh code.';
  if (/redirect[_ ]uri|redirect url/.test(msg))
    return 'The redirect URL did not match what the connector expects. Restart the connect flow from Lattice.';
  if (/invalid_client|unauthorized_client|\b401\b|\b403\b/.test(msg))
    return 'The connector rejected the authorization (client not authorized). Restart the connect flow.';
  if (/\btimeout|timed out|etimedout\b/.test(msg))
    return 'Timed out talking to the connector (its MCP endpoint did not respond in time). Try again.';
  return null;
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

/**
 * Resolve the connector implementation for a registry ROW's toolkit. MCP connections use a
 * per-connection toolkit (`mcp:<connId>`) that the catalog doesn't index (the catalog only knows
 * the connector TYPE `mcp`), so map any `mcp:<id>` back to the generic MCP connector.
 */
function connectorForRowToolkit(
  byToolkit: Map<string, Connector>,
  toolkit: string,
): Connector | undefined {
  if (connectionIdFromToolkit(toolkit)) return byToolkit.get('mcp');
  return byToolkit.get(toolkit);
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

/**
 * The loopback OAuth callback for THIS GUI origin (works in browser + desktop
 * webview). Pinned to a loopback authority: a non-loopback / rebound Host header
 * can't steer the redirect_uri off-box (mirrors the assistant OAuth path). A
 * captured code is unusable anyway (PKCE code_verifier stays server-side), so
 * falling back to bare 127.0.0.1 on a bad Host is the safe failure.
 */
/**
 * True for a loopback Host authority, tolerating a trailing `:port` and IPv6
 * brackets — the GUI runs on whatever local port was free, so the real Host
 * header carries that port. (The strict bind-host predicate in origin-guard has
 * no port stripping; using it here would reject `localhost:4317` and collapse
 * the redirect below to a portless — :80 — URL the browser can't reach.)
 */
function isLoopbackAuthority(host: string): boolean {
  const h = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function mcpOAuthRedirectUri(req: IncomingMessage): string {
  const rawHost = req.headers.host ?? '127.0.0.1';
  // Keep the real host:port (the browser must return to the running GUI); only
  // fall back when the Host isn't loopback (a forged/proxied header we distrust).
  const host = isLoopbackAuthority(rawHost) ? rawHost : '127.0.0.1';
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

/** The hostname of a server URL, as display-name material. */
function hostnameOf(serverUrl: string | null | undefined): string | null {
  if (!serverUrl) return null;
  try {
    return new URL(serverUrl).hostname || null;
  } catch {
    return null;
  }
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
      // Only rows whose toolkit has a live implementation in this catalog. That
      // excludes external databases (db_source rows render under Inputs >
      // DATABASES via /api/db-sources) and rows from retired connector kinds
      // (pre-MCP-only builds) that have no serving code left.
      const connected = (await listConnectors(db, connectedBy)).filter(
        (c) => connectorForRowToolkit(byToolkit, c.toolkit) !== undefined,
      );
      // Per-connection synced-item counts for the table view. A typed connection writes to its
      // own `mcp_<prefix>_<kind>` tables (NOT `mcp_items`), so aggregating only `mcp_items` would
      // report 0 for every typed connection. Resolve each connection's real tables via its
      // connector impl and sum a bounded COUNT(*) per table (never a row load), de-duped so a
      // table is scanned once. A legacy flat connection resolves to `mcp_items` as before.
      const countedTables: string[] = [];
      for (const c of connected) {
        const impl = connectorForRowToolkit(byToolkit, c.toolkit);
        if (!impl) continue;
        for (const m of impl.models(c.toolkit)) countedTables.push(m.table);
      }
      const itemCounts = await countItemsBySourceConnector(db.adapter, countedTables);
      const toolkits: ReturnType<typeof toolkitDescriptor>[] = [];
      for (const c of connectors) {
        for (const tk of c.toolkits()) toolkits.push(toolkitDescriptor(c, tk));
      }
      // Prefab catalog: kick a background registry refresh (never blocks this response) and hide
      // entries whose server is already connected. OAuth cards need a loopback callback — absent in
      // a hosted (non-loopback) session — so the client disables them there via oauthLoopbackAvailable.
      deps.catalog?.refreshInBackground();
      const connectedHosts = new Set<string>();
      for (const c of connected) {
        // A connection that errored before it ever synced is NOT wired up — treating it as such
        // hid the very card offering the way to finish it, so the broken row concealed its own fix.
        if (isSetupIncomplete(c)) continue;
        const impl = connectorForRowToolkit(byToolkit, c.toolkit);
        const su =
          impl && isMcpConnector(impl) && c.connectionRef ? getMcpServerUrl(c.connectionRef) : null;
        const h = hostnameOf(su);
        if (h) connectedHosts.add(h);
      }
      const catalog = (deps.catalog?.getEntries() ?? []).filter((e) => {
        const h = hostnameOf(e.serverUrl);
        return !h || !connectedHosts.has(h);
      });
      sendJson(res, {
        toolkits,
        catalog,
        oauthLoopbackAvailable: isLoopbackAuthority(req.headers.host ?? '127.0.0.1'),
        connectors: connected.map((c) => {
          const impl = connectorForRowToolkit(byToolkit, c.toolkit);
          // The URL is retained across disconnects (it is not a secret), so the
          // GUI can offer Reconnect without re-asking for it. MCP rows only.
          const serverUrl =
            impl && isMcpConnector(impl) && c.connectionRef
              ? getMcpServerUrl(c.connectionRef)
              : null;
          return {
            id: c.id,
            toolkit: c.toolkit,
            displayName: c.displayName,
            status: c.status,
            lastSyncAt: c.lastSyncAt,
            lastError: c.lastError,
            // A stable code for a failure the member can act on, so the GUI can offer the fix
            // instead of printing a sentence and stopping there.
            lastErrorCode: classifyConnectorFailure(c.lastError ?? '')?.code ?? null,
            // Never authenticated: unfinished, not broken — and not a working connection either.
            setupIncomplete: isSetupIncomplete(c),
            serverUrl,
            // Synced rows are lineage-stamped with the registry row id.
            itemCount: itemCounts.get(c.id) ?? 0,
          };
        }),
      });
      return true;
    }

    // POST /api/connectors/sync-if-stale — GUI-load refresh hook. The whole pass
    // (legacy-layout repair, securing, then the stale syncs) is one capability
    // call, so a scheduled job does exactly what loading the page does.
    // @capability connector.refresh-all
    if (pathname === '/api/connectors/sync-if-stale' && method === 'POST') {
      sendJson(res, await refreshStaleSources(db, connectors, connectedBy));
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
        // The user denied or the AS errored before any token exchange. Consume
        // the pending record and purge the abandoned connection's local state so
        // its verifier/URL/pending keys don't accumulate. This is the NEW
        // connectionId (a reconnect's existing row keeps its own stored URL under
        // its old connectionRef), so a full clear is safe.
        if (state) {
          const abandoned = takePendingConnect(state);
          if (abandoned) clearMcpConnection(abandoned.connectionId);
        }
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
      let exchangedConnectionId: string | undefined;
      try {
        const done = await mcp.completeConnect(state, { code });
        exchangedConnectionId = done.connectionId;
        const name = mcpConnectionLabel({
          serverUrl: pending.serverUrl,
          serverName: done.serverName,
          displayName: done.displayName,
        });
        await completeMcpConnection(db, mcp, {
          connectionId: done.connectionId,
          connectedBy,
          displayName: name,
          ...(done.targetConnectorId !== undefined
            ? { targetConnectorId: done.targetConnectorId }
            : {}),
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          oauthResultPage(
            `Connected ${name ?? mcp.presentation(pending.toolkit).label}. You can close this tab and return to Lattice.`,
          ),
        );
      } catch (e) {
        // LOG IT. The 500 page below says "check the Lattice logs", but this catch
        // used to write nothing — every MCP-connect finish failure was a black box
        // (no message, no stack, nothing on stderr). Surface it FIRST, before any
        // cleanup that could itself throw and hide the original cause.
        {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(
            '[lattice] MCP connector finish failed (toolkit=' +
              pending.toolkit +
              '): ' +
              err.message,
          );
          if (err.stack) console.error(err.stack);
          if (err.cause) console.error('  cause:', err.cause);
        }
        // The token exchange may have already persisted access/refresh tokens
        // under the new connectionId. If no registry row ended up referencing it
        // (the failure happened before/at row creation), those tokens are a live
        // grant nothing could ever revoke — purge them. If a row DOES reference
        // it (a later step like the initial sync failed), leave them: the row
        // owns the grant and Disconnect can revoke it.
        if (exchangedConnectionId) {
          const rows = await listConnectors(db, connectedBy);
          const owned = rows.some((r) => r.connectionRef === exchangedConnectionId);
          if (!owned) clearMcpConnection(exchangedConnectionId);
        }
        const hint = connectFailureHint(e);
        if (hint) {
          htmlErr(hint, 422);
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
    const connector = toolkit ? connectorForRowToolkit(byToolkit, toolkit) : undefined;
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
      // An MCP server that needs a person's approval answers with the URL to
      // approve rather than a connection, and the callback below finishes it.
      // @capability connector.connect
      if (action === 'connect' && method === 'POST') {
        const raw = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const str = (k: string): string | undefined =>
          typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : undefined;
        let request: SourceConnectRequest;
        if (isMcpConnector(connector)) {
          let serverUrl = str('serverUrl');
          let scope: string | undefined;
          // A prefab catalog card connects by id: the entry's URL + scope are AUTHORITATIVE
          // (resolved server-side — a page cannot fabricate a scope or endpoint for a curated entry).
          const catalogId = str('catalogId');
          if (catalogId) {
            const entry = deps.catalog?.getEntries().find((e) => e.id === catalogId);
            if (!entry) {
              sendJson(res, { error: 'unknown connector' }, 404);
              return true;
            }
            serverUrl = entry.serverUrl;
            scope = entry.scope;
          }
          request = {
            kind: 'mcp',
            redirectUri: mcpOAuthRedirectUri(req),
            serverUrl,
            scope,
            clientId: str('clientId'),
            clientSecret: str('clientSecret'),
            // Reconnect: re-authorize an EXISTING row (ownership-checked in the
            // capability). Its server URL was retained across the disconnect, so
            // the caller need not resend it.
            targetConnectorId: str('connectorId'),
          };
        } else {
          request = { kind: 'credential', credentials: raw };
        }
        const out = await connectSource(db, connector, toolkit, connectedBy, request);
        if (out.kind === 'authorize') {
          sendJson(res, { redirectUrl: out.redirectUrl, pendingId: out.pendingId });
          return true;
        }
        sendJson(res, { connectorId: out.connectorId, result: out.result });
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
          // Ownership AND connector-kind must match — a caller-supplied id must be
          // this member's AND of the kind this route serves, so refresh/disconnect
          // on /api/connectors/<toolkit> can never reach a db_source or retired row.
          if (rec?.connectedBy !== connectedBy || rec.connector !== connector.connector) {
            return { error: 'connector not found', status: 404 };
          }
          return { id: rec.id };
        }
        const rec = await getConnectorByToolkit(db, toolkit, connectedBy);
        if (!rec) return { error: `No connected ${toolkit}`, status: 404 };
        return { id: rec.id };
      };

      // POST /api/connectors/<toolkit>/refresh — manual re-sync.
      // @capability connector.sync
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
      // @capability connector.disconnect
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
    // A capability's own refusal is already the final answer: it named the
    // situation, so translate it and stop. Checked FIRST so its wording is never
    // re-read as one of the connector-level failure patterns below.
    const tagged = connectorErrorCode(err);
    if (tagged) {
      sendJson(res, { error: (err as Error).message }, STATUS_FOR_CONNECTOR_ERROR[tagged]);
      return true;
    }
    // A classified failure answers with its code wherever it surfaced — including from a step
    // AFTER the connect call itself (the initial sync), which otherwise reached the caller as an
    // opaque 500 with no hint that supplying a client id is the fix.
    const known = classifyConnectorFailure(err instanceof Error ? err.message : String(err));
    if (known) {
      sendJson(res, { error: known.message, code: known.code }, 422);
      return true;
    }
    if (isActionable(err)) {
      sendJson(res, { error: err.message }, 422);
      return true;
    }
    throw err; // unexpected — surfaced loudly by the server's 500 handler
  }
}
