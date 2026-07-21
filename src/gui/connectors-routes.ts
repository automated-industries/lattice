import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';
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
import { syncConnector, syncStaleConnectors, collectConnectorKeys } from '../connectors/sync.js';
import { disconnectConnector } from '../connectors/teardown.js';
import { enableConnectorRls, secureConnectorTables } from '../connectors/acl.js';
import { ConnectorUnavailableError } from '../connectors/errors.js';
import {
  peekPendingConnect,
  takePendingConnect,
  clearMcpConnection,
  getMcpServerUrl,
} from '../connectors/mcp/oauth.js';
import { mcpToolkitFor, connectionIdFromToolkit } from '../connectors/mcp/schema-cache.js';
import { brandFromHost } from '../connectors/describe-connected.js';

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

/**
 * A curated, user-facing reason for a connect failure, or null when the cause is
 * unknown (→ the generic 500, which is now logged for diagnosis). We never surface
 * a raw non-curated error string to the browser; only known, safe patterns get a
 * specific message.
 */
export function connectFailureHint(err: unknown): string | null {
  if (err instanceof ConnectorUnavailableError) return err.message;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid_grant|code (?:has )?(?:expired|already been used|already used)|expired.*code/.test(msg))
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

/**
 * Record an established MCP connection, define + secure its connected tables,
 * and run the initial sync. Shared by the direct connect path (open/stdio
 * server) and the OAuth callback. Every NEW connect creates its own registry
 * row — a member can connect several MCP servers side by side. A reconnect
 * (`targetConnectorId`) repoints the existing row instead, after an ownership
 * check, retiring the old connection's secrets.
 */
async function finishMcpConnection(
  deps: ConnectorsRouteDeps,
  connector: McpConnector,
  _toolkit: string,
  connectionId: string,
  displayName: string | null,
  targetConnectorId?: string,
): Promise<{ connectorId: string; result: unknown }> {
  const { db, connectedBy } = deps;
  // MCP is modeled PER CONNECTION (like db_source:<id>): the toolkit carries the connection id,
  // so each server groups under its own schema header + gets its own typed tables.
  const toolkit = mcpToolkitFor(connectionId);
  // The server brand (from its host) names the tables + the sidebar group.
  let host: string | null = null;
  try {
    host = new URL(getMcpServerUrl(connectionId) ?? '').hostname || null;
  } catch {
    /* stdio / no stored URL */
  }
  const brand = brandFromHost(host);
  // Introspect the server into a typed schema descriptor — one table per record kind. Best-effort:
  // on failure the connection still works via the flat `mcp_items` fallback (models() returns it
  // when no descriptor exists).
  if (connector.introspect) {
    try {
      await connector.introspect(
        connectionId,
        toolkit,
        brand ?? displayName ?? connector.connector,
      );
    } catch (e) {
      console.warn(
        `[connectors] MCP introspection failed for ${connectionId} (flat fallback): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  let connectorId: string;
  if (targetConnectorId) {
    const existing = await getConnector(db, targetConnectorId);
    // Ownership AND kind must match — a member may only repoint their own row,
    // and only a row of THIS connector kind (never a db_source or retired row
    // reached by id through the MCP route).
    if (existing?.connectedBy !== connectedBy || existing.connector !== connector.connector) {
      throw new ConnectorUnavailableError('Connector not found — it may have been removed.');
    }
    if (existing.connectionRef && existing.connectionRef !== connectionId) {
      // The old connection is fully superseded (the new connectionId carries its
      // own stored URL), so PURGE it — a plain disconnect would leave the old
      // connection's server-URL key orphaned with nothing referencing it.
      await (connector.purgeConnection?.(existing.connectionRef) ??
        connector.disconnect(existing.connectionRef));
    }
    // Re-key the toolkit to the new connection (its typed tables live under mcp:<newId>).
    await updateConnectorConnection(db, existing.id, connectionId, toolkit);
    connectorId = existing.id;
  } else {
    connectorId = await createConnector(db, {
      connector: connector.connector,
      toolkit,
      displayName: displayName ?? brand ?? connector.connector,
      connectionRef: connectionId,
      connectedBy,
    });
  }
  for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
  await enableConnectorRls(db, connector, toolkit);
  const result = await syncConnector(db, connector, connectorId);
  return { connectorId, result };
}

/**
 * Migrate a LEGACY MCP connection (flat `mcp_items`, toolkit `mcp`) to typed per-kind tables:
 * introspect the server, re-key the row's toolkit to `mcp:<connId>`, register the typed tables,
 * and force a sync to populate them. Idempotent + best-effort — returns false (leaving the flat
 * connection untouched) if the connector can't introspect or the server exposes nothing modelable.
 * Runs on the GUI-load sync-if-stale path (NOT the open hot path), so its network introspection
 * never blocks a workspace open. Once migrated, reopen re-registers the typed tables with no network.
 */
async function migrateLegacyMcpConnection(
  deps: ConnectorsRouteDeps,
  connector: McpConnector,
  row: { id: string; connectionRef: string | null; displayName: string | null },
): Promise<boolean> {
  const { db } = deps;
  const connectionId = row.connectionRef;
  if (!connectionId || !connector.introspect) return false;
  const toolkit = mcpToolkitFor(connectionId);
  let host: string | null = null;
  try {
    host = new URL(getMcpServerUrl(connectionId) ?? '').hostname || null;
  } catch {
    /* stdio / no stored URL */
  }
  const brand = brandFromHost(host);
  const descriptor = await connector.introspect(
    connectionId,
    toolkit,
    brand ?? row.displayName ?? connector.connector,
  );
  if (!descriptor) return false; // nothing modelable → keep the flat mcp_items fallback
  // The re-key must happen BEFORE syncConnector (which reads the toolkit off the row to pick the
  // typed models). But the re-key is the only step the retry gate keys on (it re-selects
  // `toolkit==='mcp'`), so if any later step fails after re-keying, roll the toolkit back to
  // `mcp` — otherwise the row is left typed-but-empty with its data stranded in mcp_items and the
  // migration never retries. Better a retriable flat connection than a silent half-migration.
  await updateConnectorConnection(db, row.id, connectionId, toolkit);
  try {
    for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);
    await enableConnectorRls(db, connector, toolkit);
    await syncConnector(db, connector, row.id); // force-populate the typed tables now
    // Retire the pre-migration flat `mcp_items` rows for this connection: their data now lives in
    // the typed tables, so leaving them would double the data live, inflate the item count, and
    // survive a later disconnect (which tears down only the current toolkit's typed tables).
    // Soft-delete (never hard) so they stay recoverable and drop out of context/search/counts.
    // Skip cleanly when there is no mcp_items table; a real DB error propagates to the rollback.
    if (db.getRegisteredTableNames().includes('mcp_items')) {
      const now = new Date().toISOString();
      const staleKeys = await collectConnectorKeys(db, 'mcp_items', 'item_id', row.id);
      for (const key of staleKeys) await db.update('mcp_items', key, { deleted_at: now });
    }
  } catch (e) {
    // Roll the re-key back so the ENTIRE migration retries on the next load (idempotently:
    // introspect re-sets the descriptor, syncConnector upserts). The caller logs the failure —
    // and with the row back on `mcp`, its "flat fallback kept" message is now accurate.
    await updateConnectorConnection(db, row.id, connectionId, 'mcp');
    throw e;
  }
  return true;
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
      const itemCounts = new Map<string, number>();
      const countedTables = new Set<string>();
      for (const c of connected) {
        const impl = connectorForRowToolkit(byToolkit, c.toolkit);
        if (!impl) continue;
        for (const m of impl.models(c.toolkit)) {
          if (countedTables.has(m.table)) continue;
          countedTables.add(m.table);
          try {
            const rows = (await allAsyncOrSync(
              db.adapter,
              `SELECT "_source_connector_id" AS cid, COUNT(*) AS n FROM "${m.table}" WHERE "deleted_at" IS NULL GROUP BY "_source_connector_id"`,
              [],
              // Postgres returns COUNT(*) as a string, SQLite as a number — coerce.
            )) as { cid: string; n: number | string }[];
            for (const r of rows)
              if (r.cid) itemCounts.set(r.cid, (itemCounts.get(r.cid) ?? 0) + Number(r.n));
          } catch {
            // Table not created yet (no sync) — contributes zero.
          }
        }
      }
      const toolkits: ReturnType<typeof toolkitDescriptor>[] = [];
      for (const c of connectors) {
        for (const tk of c.toolkits()) toolkits.push(toolkitDescriptor(c, tk));
      }
      sendJson(res, {
        toolkits,
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
            serverUrl,
            // Synced rows are lineage-stamped with the registry row id.
            itemCount: itemCounts.get(c.id) ?? 0,
          };
        }),
      });
      return true;
    }

    // POST /api/connectors/sync-if-stale — GUI-load refresh hook. Loops every
    // connector; each filters to its own registry rows, so no cross-talk.
    if (pathname === '/api/connectors/sync-if-stale' && method === 'POST') {
      let synced = 0;
      let failed = 0;
      // First, migrate any legacy flat-`mcp_items` connections to typed per-kind tables
      // (introspect once, re-key the toolkit, populate). One-time per connection; fault-isolated
      // so a slow/unreachable server never fails the load refresh.
      const mcpImpl = byToolkit.get('mcp');
      if (mcpImpl && isMcpConnector(mcpImpl)) {
        const legacy = (await listConnectors(db, connectedBy)).filter(
          (c) => c.connector === 'mcp' && c.toolkit === 'mcp' && c.status !== 'disconnected',
        );
        for (const row of legacy) {
          try {
            await migrateLegacyMcpConnection(deps, mcpImpl, row);
          } catch (e) {
            console.warn(
              `[connectors] MCP typed-table migration failed for ${row.id} (flat fallback kept): ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
      }
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
        // Prefer the server's self-reported name, then its hostname — the generic
        // toolkit label ("MCP server") identifies nothing once several are connected.
        const name = done.serverName ?? hostnameOf(pending.serverUrl) ?? done.displayName;
        await finishMcpConnection(
          deps,
          mcp,
          pending.toolkit,
          done.connectionId,
          name,
          done.targetConnectorId,
        );
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
            '[lattice] MCP connector finish failed (toolkit=' + pending.toolkit + '): ' + err.message,
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
      if (action === 'connect' && method === 'POST') {
        // MCP connectors: begin per-server OAuth (return a redirect the GUI opens),
        // or — for an open/stdio server — connect + sync immediately.
        if (isMcpConnector(connector)) {
          const raw = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          const str = (k: string): string | undefined =>
            typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : undefined;
          let serverUrl = str('serverUrl');
          const clientId = str('clientId');
          const clientSecret = str('clientSecret');
          // Reconnect: re-authorize an EXISTING row (ownership-checked). Its
          // server URL was retained across the disconnect, so the caller need
          // not resend it.
          const targetConnectorId = str('connectorId');
          if (targetConnectorId) {
            const rec = await getConnector(db, targetConnectorId);
            // Ownership AND connector-kind must match: the MCP route may never
            // reach a db_source or retired-kind row by id.
            if (rec?.connectedBy !== connectedBy || rec.connector !== connector.connector) {
              sendJson(res, { error: 'connector not found' }, 404);
              return true;
            }
            if (!serverUrl && rec.connectionRef) {
              serverUrl = getMcpServerUrl(rec.connectionRef) ?? undefined;
            }
            if (!serverUrl) {
              sendJson(
                res,
                { error: 'This connector has no stored server URL — add it again.' },
                422,
              );
              return true;
            }
          }
          let begin;
          try {
            begin = await connector.beginConnect(connectedBy, toolkit, {
              redirectUri: mcpOAuthRedirectUri(req),
              ...(serverUrl ? { serverUrl } : {}),
              ...(clientId
                ? {
                    clientInfo: {
                      client_id: clientId,
                      ...(clientSecret ? { client_secret: clientSecret } : {}),
                    },
                  }
                : {}),
              ...(targetConnectorId ? { targetConnectorId } : {}),
            });
          } catch (e) {
            // The SDK's terminal "no way to identify this client" failures: the
            // authorization server has no registration endpoint ("does not
            // support dynamic client registration"), OR its registration
            // endpoint rejected the request ("dynamic client registration
            // failed: …"). Either way the fix is a pre-registered client, so a
            // distinct code lets the GUI switch the form into that mode instead
            // of dead-ending. (Both messages contain "dynamic client
            // registration"; matching that phrase covers both without swallowing
            // unrelated errors, which are rethrown to the loud 500.)
            const msg = e instanceof Error ? e.message : String(e);
            if (/dynamic client registration/i.test(msg)) {
              sendJson(
                res,
                {
                  error:
                    'This MCP server requires a pre-registered OAuth client. Enter the client ID (and secret, if it has one) issued by the provider.',
                  code: 'client_registration_unsupported',
                },
                422,
              );
              return true;
            }
            throw e;
          }
          if (begin.kind === 'redirect') {
            sendJson(res, { redirectUrl: begin.redirectUrl, pendingId: begin.pendingId });
            return true;
          }
          const out = await finishMcpConnection(
            deps,
            connector,
            toolkit,
            begin.connectionId,
            begin.displayName ?? hostnameOf(serverUrl),
            targetConnectorId,
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
