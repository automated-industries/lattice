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
        displayName: serverName ?? this.displayNameFor(toolkit),
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
    const scope = this.scope(toolkit);
    if (scope !== undefined) beginArgs.scope = scope;
    const begin = await this.oauth.begin(beginArgs);

    if (!begin.authorizationUrl) {
      // The server accepted the connection without a redirect (open / pre-authorized).
      return {
        kind: 'connected',
        connectionId,
        displayName: begin.serverName ?? this.displayNameFor(toolkit),
      };
    }
    putPendingConnect(state, {
      connectionId,
      connector: this.connector,
      toolkit,
      serverUrl,
      redirectUri,
      transportKind: httpKind,
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
    const scope = this.scope(pending.toolkit);
    if (scope !== undefined) completeArgs.scope = scope;
    const done = await this.oauth.complete(completeArgs);
    return {
      connectionId: pending.connectionId,
      displayName: done.serverName ?? this.displayNameFor(pending.toolkit),
      ...(done.serverName ? { serverName: done.serverName } : {}),
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
