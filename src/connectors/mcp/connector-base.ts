/**
 * The base for every MCP-backed connector.
 *
 * A concrete connector (Gmail, Calendar, Jira, …) supplies only schema + mapping:
 * the connected {@link ConnectedModelDef}s (`models`), the MCP server(s) it reads
 * from (`mcpServers`), and, per model, which read tool feeds it and how to map the
 * tool's JSON into rows (`bindings`). Everything else — connecting (per-server
 * OAuth or a local stdio server), paging, and yielding {@link ExternalRecord}s to
 * the unchanged sync engine — lives here.
 *
 * The transport and OAuth driver are constructor seams so tests inject fakes and
 * never touch the network or the MCP SDK.
 */

import { ConnectorUnavailableError } from '../errors.js';
import { sanitizeConnectorLabel } from '../sanitize-label.js';
import { curatedLabelForServerUrl } from '../prefab/curated.js';
import type {
  McpConnector,
  ConnectedModelDef,
  ExternalRecord,
  ListChangesContext,
  ToolkitPresentation,
  AuthorizeResult,
  ConnectionResult,
  McpServerSpec,
  McpBeginResult,
} from '../types.js';
import type { McpTransport, McpTransportFactory, McpServerRef } from './transport.js';
import { connectDirect } from './direct-transport.js';
import {
  beginOAuth,
  completeOAuth,
  type BeginOAuthArgs,
  type CompleteOAuthArgs,
} from './direct-transport.js';
import {
  newConnectionId,
  newState,
  putPendingConnect,
  takePendingConnect,
  setMcpServerUrl,
  getMcpServerUrl,
  setMcpClientInformation,
  revokeMcpSecrets,
  clearMcpConnection,
} from './oauth.js';

/** Hard cap on pages per model, so a paginating tool can never loop unbounded. */
const MAX_PAGES = 1000;

// --- Display-name ladder -----------------------------------------------------

/**
 * Self-reported server names that identify nothing. A vendor that hosts several MCP endpoints on
 * one platform commonly answers every handshake with the same generic word, so taking that name
 * verbatim renders three different connectors under one identical title. Compared after stripping
 * case and separators, so "mcp-server", "MCP Server" and "mcp_server" all collapse to one entry.
 */
const PLACEHOLDER_SERVER_NAMES = new Set([
  'statelessserver',
  'statelessmcpserver',
  'mcpstatelessserver',
  'server',
  'mcp',
  'mcpserver',
  'servermcp',
  'httpserver',
  'streamablehttpserver',
  'sseserver',
  'stdioserver',
  'default',
  'defaultserver',
  'unnamed',
  'unnamedserver',
  'unknown',
  'unknownserver',
  'untitled',
  'anonymous',
  'example',
  'exampleserver',
  'service',
  'app',
]);

/**
 * True when a server's self-reported name is absent, empty, or one of the generic placeholders
 * above. A placeholder must LOSE the name ladder and fall through to a label derived from the
 * endpoint — otherwise a present-but-worthless name beats every good fallback, which is exactly
 * how several distinct connections ended up sharing one title.
 */
export function isPlaceholderServerName(name: string | null | undefined): boolean {
  if (name == null) return true;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s._\-/]+/g, '');
  if (normalized === '') return true;
  return PLACEHOLDER_SERVER_NAMES.has(normalized);
}

/** Host labels that name infrastructure rather than a service — never a display name on their own. */
const GENERIC_HOST_LABELS = new Set([
  'www',
  'api',
  'mcp',
  'app',
  'apps',
  'server',
  'remote',
  'gateway',
  'service',
  'services',
  'host',
  'cloud',
  'connect',
  'auth',
  'oauth',
  'login',
  'sso',
  'edge',
  'proxy',
  'endpoint',
]);

/** Public suffixes whose second label is still part of the suffix (so we don't return "Co"). */
const TWO_PART_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);

/**
 * Split a host label into display words: hyphens/underscores separate, and a fused "mcp" prefix or
 * suffix is split off so "drivemcp" reads as two words rather than one unpronounceable run.
 */
function tokenizeHostLabel(label: string): string[] {
  const out: string[] = [];
  for (const part of label.split(/[-_]+/).filter(Boolean)) {
    if (part === 'mcp') {
      out.push('mcp');
      continue;
    }
    const suffix = /^(.+?)mcp$/.exec(part);
    const prefix = /^mcp(.+)$/.exec(part);
    if (suffix?.[1] && suffix[1].length >= 2) out.push(suffix[1], 'mcp');
    else if (prefix?.[1] && prefix[1].length >= 2) out.push('mcp', prefix[1]);
    else out.push(part);
  }
  return out;
}

function titleToken(token: string): string {
  if (token === 'mcp') return 'MCP';
  if (token === 'api') return 'API';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * A display label read out of an MCP endpoint's hostname, or null when nothing in the host reads as
 * a name. A vendor that fans several MCP endpoints out of one domain names the service in the
 * subdomain, so a subdomain carrying an "mcp" token plus a real word wins; otherwise the
 * registrable label is the brand. A label that is itself generic infrastructure ("mcp.example"
 * would read as "Mcp") yields null so the caller falls through to its own label.
 */
export function hostnameLabelFor(serverUrl: string | null | undefined): string | null {
  if (!serverUrl) return null;
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // an address literal names nothing
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const subdomain = tokenizeHostLabel(labels[0] ?? '');
  if (subdomain.length > 1 && subdomain.includes('mcp')) {
    return subdomain.map(titleToken).join(' ');
  }
  let idx = labels.length - 2;
  if (idx > 0 && TWO_PART_SUFFIXES.has(labels[idx] ?? '')) idx -= 1;
  const brand = labels[idx] ?? '';
  if (brand.length < 2 || /^\d+$/.test(brand) || brand.startsWith('xn--')) return null;
  if (GENERIC_HOST_LABELS.has(brand)) return null;
  return tokenizeHostLabel(brand).map(titleToken).join(' ');
}

/**
 * The label a connection should carry, resolved down a fixed ladder:
 *
 *  1. the curated catalog label for this endpoint (authoritative — it is the only thing that tells
 *     apart several services of one vendor that all report the same handshake name);
 *  2. the server's own name, when it is not a generic placeholder (sanitized, since it is
 *     attacker-controlled text that later reaches an LLM prompt);
 *  3. a label derived from the hostname;
 *  4. the caller's fallback (its own toolkit label).
 */
export function resolveConnectorDisplayName(opts: {
  serverUrl?: string | null;
  serverName?: string | null;
  fallback?: string | null;
}): string | null {
  const curated = curatedLabelForServerUrl(opts.serverUrl);
  if (curated) return curated;
  const reported = opts.serverName == null ? '' : sanitizeConnectorLabel(opts.serverName);
  if (reported !== '' && !isPlaceholderServerName(reported)) return reported;
  return hostnameLabelFor(opts.serverUrl) ?? opts.fallback ?? null;
}

/** Binds one connected model to the MCP read tool that feeds it, plus its mapper. */
export interface McpModelBinding {
  /** The connected model key (matches {@link ConnectedModelDef.model}). */
  model: string;
  /** The MCP read tool that feeds this model. */
  tool: string;
  /**
   * Build the tool arguments for one page. `parentKey` is set for per-parent
   * models (e.g. an issue key when fetching its comments); `cursor` is the page
   * token from {@link nextCursor} on the prior page (null on the first page).
   */
  buildArgs(ctx: { parentKey?: string; cursor?: string | null }): Record<string, unknown>;
  /** Pull the array of raw items out of the tool's JSON result. */
  items(result: unknown): unknown[];
  /** Map one raw item to an {@link ExternalRecord}. Return null to skip it. */
  map(item: unknown, ctx: { parentKey?: string }): ExternalRecord | null;
  /** Extract the next-page cursor, or a falsy value when the last page was reached. */
  nextCursor?(result: unknown): string | null | undefined;
}

/** OAuth driver seam — the real SDK-backed functions in production, fakes in tests. */
export interface McpOAuthDriver {
  begin(
    args: BeginOAuthArgs,
  ): Promise<{ authorizationUrl: string | undefined; toolNames: string[]; serverName?: string }>;
  complete(args: CompleteOAuthArgs): Promise<{ toolNames: string[]; serverName?: string }>;
}

const DEFAULT_OAUTH_DRIVER: McpOAuthDriver = { begin: beginOAuth, complete: completeOAuth };

export abstract class McpConnectorBase implements McpConnector {
  protected constructor(
    private readonly transportFactory: McpTransportFactory = connectDirect,
    private readonly oauth: McpOAuthDriver = DEFAULT_OAUTH_DRIVER,
  ) {}

  // --- Concrete connectors implement these ----------------------------------

  abstract readonly connector: string;
  abstract toolkits(): string[];
  abstract presentation(toolkit: string): ToolkitPresentation;
  abstract models(toolkit: string): ConnectedModelDef[];
  abstract mcpServers(toolkit: string): McpServerSpec[];
  /** The per-model tool + mapper bindings for a toolkit. */
  protected abstract bindings(toolkit: string): McpModelBinding[];
  /** Optional OAuth scope string requested for a toolkit's server. */
  protected scope(_toolkit: string): string | undefined {
    return undefined;
  }

  // --- Server / ref resolution ----------------------------------------------

  private resolveServer(toolkit: string, serverUrlOverride?: string): McpServerSpec {
    const servers = this.mcpServers(toolkit);
    const server = servers[0];
    if (!server) throw new ConnectorUnavailableError(`No MCP server configured for "${toolkit}".`);
    if (serverUrlOverride) return { ...server, url: serverUrlOverride };
    return server;
  }

  private transportKind(server: McpServerSpec): 'http' | 'sse' | 'stdio' {
    if (server.transport) return server.transport;
    if (server.command) return 'stdio';
    if (server.url?.endsWith('/sse')) return 'sse';
    return 'http';
  }

  private needsOAuth(server: McpServerSpec, kind: 'http' | 'sse' | 'stdio'): boolean {
    return server.oauth ?? kind !== 'stdio';
  }

  private buildRef(
    server: McpServerSpec,
    connectionId: string,
    kind: 'http' | 'sse' | 'stdio',
  ): McpServerRef {
    const ref: McpServerRef = { name: server.name, transport: kind, connectionId };
    if (server.url !== undefined) ref.url = server.url;
    if (server.command !== undefined) ref.command = server.command;
    if (server.args !== undefined) ref.args = server.args;
    return ref;
  }

  /** Open a transport to this toolkit's server for an existing connection (sync time). */
  protected async openServerTransport(
    toolkit: string,
    connectionId: string,
  ): Promise<McpTransport> {
    let server = this.resolveServer(toolkit);
    if (!server.url && !server.command) {
      // A bring-your-own-URL toolkit has no URL in its spec — the connection's
      // stored URL is authoritative. Resolving it here (not just inside the
      // transport) lets transportKind see an `/sse` suffix.
      const stored = getMcpServerUrl(connectionId);
      if (stored) server = { ...server, url: stored };
    }
    const kind = this.transportKind(server);
    const ref = this.buildRef(server, connectionId, kind);
    return this.transportFactory(ref);
  }

  // --- Connect (MCP: per-server OAuth or a local stdio server) ---------------

  async beginConnect(
    _userId: string,
    toolkit: string,
    opts?: {
      redirectUri?: string;
      serverUrl?: string;
      clientInfo?: { client_id: string; client_secret?: string };
      targetConnectorId?: string;
      /** Per-connect OAuth scopes (a prefab catalog entry's curated scopes); overrides the default. */
      scope?: string;
    },
  ): Promise<McpBeginResult> {
    const server = this.resolveServer(toolkit, opts?.serverUrl);
    const kind = this.transportKind(server);
    const connectionId = newConnectionId();
    // A user-supplied pre-registered client (for authorization servers with no
    // client-ID-metadata-document support and no dynamic registration): stored
    // up front so the SDK's clientInformation() short-circuit skips registration.
    if (opts?.clientInfo?.client_id) setMcpClientInformation(connectionId, opts.clientInfo);

    if (!this.needsOAuth(server, kind)) {
      // Local stdio server or an open HTTP/SSE server — validate via tools/list, no redirect.
      if (kind !== 'stdio' && server.url) setMcpServerUrl(connectionId, server.url);
      const ref = this.buildRef(server, connectionId, kind);
      const transport = await this.transportFactory(ref);
      let serverName: string | undefined;
      try {
        await transport.listTools();
        serverName = transport.serverInfo?.()?.name;
      } finally {
        await transport.close();
      }
      return {
        kind: 'connected',
        connectionId,
        displayName: resolveConnectorDisplayName({
          serverUrl: server.url ?? null,
          serverName: serverName ?? null,
          fallback: this.displayNameFor(toolkit),
        }),
      };
    }

    // OAuth HTTP/SSE server.
    const serverUrl = server.url;
    if (!serverUrl) {
      throw new ConnectorUnavailableError(
        `Toolkit "${toolkit}" needs an MCP server URL to connect.`,
      );
    }
    const redirectUri = opts?.redirectUri;
    if (!redirectUri) {
      throw new ConnectorUnavailableError('Missing OAuth redirect URI for the MCP connect flow.');
    }
    const httpKind: 'http' | 'sse' = kind === 'sse' ? 'sse' : 'http';
    const targetConnectorId = opts.targetConnectorId;
    const state = newState();
    const beginArgs: BeginOAuthArgs = {
      connectionId,
      serverUrl,
      redirectUri,
      state,
      transportKind: httpKind,
    };
    const scope = opts.scope ?? this.scope(toolkit);
    if (scope !== undefined) beginArgs.scope = scope;
    const begin = await this.oauth.begin(beginArgs);

    if (!begin.authorizationUrl) {
      // The server accepted the connection without a redirect (open / pre-authorized).
      return {
        kind: 'connected',
        connectionId,
        displayName: resolveConnectorDisplayName({
          serverUrl,
          serverName: begin.serverName ?? null,
          fallback: this.displayNameFor(toolkit),
        }),
      };
    }
    putPendingConnect(state, {
      connectionId,
      connector: this.connector,
      toolkit,
      serverUrl,
      redirectUri,
      transportKind: httpKind,
      ...(scope !== undefined ? { scope } : {}),
      ...(targetConnectorId ? { targetConnectorId } : {}),
    });
    return { kind: 'redirect', redirectUrl: begin.authorizationUrl, pendingId: state };
  }

  async completeConnect(
    pendingId: string,
    params: { code: string; state?: string },
  ): Promise<{
    connectionId: string;
    displayName: string | null;
    serverName?: string;
    targetConnectorId?: string;
  }> {
    const pending = takePendingConnect(pendingId);
    if (!pending) {
      throw new ConnectorUnavailableError('No pending MCP connection — restart the connect flow.');
    }
    const completeArgs: CompleteOAuthArgs = {
      connectionId: pending.connectionId,
      redirectUri: pending.redirectUri,
      code: params.code,
      transportKind: pending.transportKind,
      state: pendingId,
    };
    const scope = pending.scope ?? this.scope(pending.toolkit);
    if (scope !== undefined) completeArgs.scope = scope;
    const done = await this.oauth.complete(completeArgs);
    // Echo `serverName` only when the server actually named itself: a generic placeholder is
    // worse than nothing downstream, where it would beat a host- or catalog-derived label.
    const reported = done.serverName == null ? '' : sanitizeConnectorLabel(done.serverName);
    const named = reported !== '' && !isPlaceholderServerName(reported);
    return {
      connectionId: pending.connectionId,
      displayName: resolveConnectorDisplayName({
        serverUrl: pending.serverUrl,
        serverName: done.serverName ?? null,
        fallback: this.displayNameFor(pending.toolkit),
      }),
      ...(named ? { serverName: reported } : {}),
      ...(pending.targetConnectorId ? { targetConnectorId: pending.targetConnectorId } : {}),
    };
  }

  disconnect(connectionId: string): Promise<void> {
    // Secrets only — the stored server URL stays so a disconnected connector can
    // be reconnected without re-entering it. Hard teardown removes the URL too,
    // via purgeConnection.
    revokeMcpSecrets(connectionId);
    return Promise.resolve();
  }

  purgeConnection(connectionId: string): Promise<void> {
    clearMcpConnection(connectionId);
    return Promise.resolve();
  }

  // --- Sync: page an MCP read tool, yield rows (sync engine unchanged) --------

  // While a sync session is active for a connection, ONE transport is opened
  // lazily (on the first listChanges) and reused across every model + parent key,
  // then closed by endSyncSession. Outside a session, listChanges opens + closes
  // its own (single-shot callers, e.g. connect-time validation).
  private readonly _activeSessions = new Set<string>();
  private readonly _sessionTransports = new Map<string, McpTransport>();

  /** Reuse ONE transport for this connection across the sync's models/parents. */
  beginSyncSession(connectionId: string): Promise<void> {
    this._activeSessions.add(connectionId); // transport opened lazily on first use
    return Promise.resolve();
  }

  /** Close + evict the shared transport opened during the session (idempotent). */
  async endSyncSession(connectionId: string): Promise<void> {
    this._activeSessions.delete(connectionId);
    const t = this._sessionTransports.get(connectionId);
    this._sessionTransports.delete(connectionId);
    if (t) await t.close();
  }

  /**
   * Get a transport for an out-of-listChanges operation (e.g. a drift reconcile): reuse the active
   * session transport when one is open (release is a no-op — endSyncSession closes it), else open a
   * one-shot transport the caller MUST release. Mirrors the listChanges reuse so a reconcile shares
   * the sync's single connection instead of opening a second one.
   */
  protected async acquireTransport(
    toolkit: string,
    connectionId: string,
  ): Promise<{ transport: McpTransport; release: () => Promise<void> }> {
    const sessionActive = this._activeSessions.has(connectionId);
    const existing = this._sessionTransports.get(connectionId);
    if (existing) return { transport: existing, release: () => Promise.resolve() };
    const transport = await this.openServerTransport(toolkit, connectionId);
    if (sessionActive) {
      this._sessionTransports.set(connectionId, transport);
      return { transport, release: () => Promise.resolve() };
    }
    return { transport, release: () => transport.close() };
  }

  async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    const binding = this.bindings(toolkit).find((b) => b.model === model);
    if (!binding) return;
    // Reuse the session transport when a sync session is active; otherwise open a
    // one-shot transport and close it in the finally. This collapses the old
    // per-parent-key N+1 (a fresh connect/initialize per parent) to one connect
    // for the whole connector sync.
    const sessionActive = this._activeSessions.has(ctx.connectionId);
    let transport = this._sessionTransports.get(ctx.connectionId);
    if (!transport) {
      transport = await this.openServerTransport(toolkit, ctx.connectionId);
      if (sessionActive) this._sessionTransports.set(ctx.connectionId, transport);
    }
    try {
      let cursor: string | null | undefined = ctx.cursor ?? null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const args = binding.buildArgs({
          ...(ctx.parentKey !== undefined ? { parentKey: ctx.parentKey } : {}),
          cursor,
        });
        const result = await transport.callTool({ tool: binding.tool, args });
        for (const item of binding.items(result)) {
          const rec = binding.map(
            item,
            ctx.parentKey !== undefined ? { parentKey: ctx.parentKey } : {},
          );
          if (rec) yield rec;
        }
        const next = binding.nextCursor ? binding.nextCursor(result) : undefined;
        if (!next) break;
        cursor = next;
      }
    } finally {
      // Session transports are closed by endSyncSession; one-shot transports here.
      if (!sessionActive) await transport.close();
    }
  }

  // --- Base Connector OAuth-redirect SPI (not used by MCP connectors) --------

  authorize(_userId: string, _toolkit: string): Promise<AuthorizeResult> {
    return Promise.reject(
      new ConnectorUnavailableError('MCP connectors connect via beginConnect, not authorize().'),
    );
  }

  completeAuth(_userId: string, _toolkit: string): Promise<ConnectionResult> {
    return Promise.reject(
      new ConnectorUnavailableError(
        'MCP connectors connect via completeConnect, not completeAuth().',
      ),
    );
  }

  // --- Helpers ---------------------------------------------------------------

  private displayNameFor(toolkit: string): string | null {
    try {
      return this.presentation(toolkit).label;
    } catch {
      return toolkit;
    }
  }
}

/** A single-toolkit MCP connector defined purely by schema + bindings. */
export interface McpConnectorSpec {
  /** Connector id (also the toolkit id unless {@link toolkit} is set). */
  connector: string;
  /** Toolkit id, if it differs from the connector id. */
  toolkit?: string;
  presentation: ToolkitPresentation;
  servers: McpServerSpec[];
  models: ConnectedModelDef[];
  bindings: McpModelBinding[];
  /** OAuth scope requested for the server, if any. */
  scope?: string;
}

/** Test/DI seams for a {@link SimpleMcpConnector}. */
export interface McpConnectorDeps {
  transportFactory?: McpTransportFactory;
  oauth?: McpOAuthDriver;
}

/**
 * The concrete connector every built-in MCP connector module instantiates: it
 * wires a {@link McpConnectorSpec} into the base, so a connector module is just
 * its table schema + per-model tool bindings — no class boilerplate.
 */
export class SimpleMcpConnector extends McpConnectorBase {
  // A plain data field (assigned in the constructor), NOT a getter: the abstract
  // base declares `connector`, and under `useDefineForClassFields` a getter here
  // collides with the base field's [[Set]] init ("cannot set property … which has
  // only a getter"), 500-ing the connectors route. GenericMcpConnector does the same.
  readonly connector: string;
  private readonly toolkit: string;

  constructor(
    private readonly spec: McpConnectorSpec,
    deps: McpConnectorDeps = {},
  ) {
    super(deps.transportFactory, deps.oauth);
    this.connector = spec.connector;
    this.toolkit = spec.toolkit ?? spec.connector;
  }

  toolkits(): string[] {
    return [this.toolkit];
  }
  presentation(_toolkit: string): ToolkitPresentation {
    return this.spec.presentation;
  }
  models(_toolkit: string): ConnectedModelDef[] {
    return this.spec.models;
  }
  mcpServers(_toolkit: string): McpServerSpec[] {
    return this.spec.servers;
  }
  protected bindings(_toolkit: string): McpModelBinding[] {
    return this.spec.bindings;
  }
  protected override scope(_toolkit: string): string | undefined {
    return this.spec.scope;
  }
}
