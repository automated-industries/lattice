/**
 * Local, per-server MCP OAuth — persistence + the client provider.
 *
 * Lattice is the MCP client (mechanism 2): the user authorizes each MCP server
 * directly with that server's own OAuth (RFC 9728 protected-resource discovery →
 * RFC 8414 authorization-server metadata → client identity via a client-ID
 * metadata document, dynamic registration, or a stored pre-registered client →
 * PKCE authorization-code), and Lattice stores the resulting token in the
 * machine-local encrypted credential store. Nothing is routed through a cloud
 * middleman; the token never enters the registry table, responses, or logs.
 *
 * Client identity: the SDK picks, in order, (1) a stored client (`mcp_client:`,
 * written by dynamic registration or by the user supplying a pre-registered
 * client id), (2) the hosted client-ID metadata document URL below when the
 * authorization server advertises `client_id_metadata_document_supported`, or
 * (3) dynamic registration. The metadata document is fully static app-identity
 * JSON — the same file for every install, no user data — and is fetched only by
 * the PROVIDER's authorization server, never by Lattice or the user's browser.
 *
 * Types are hand-written (not imported from `@modelcontextprotocol/sdk`) so
 * `latticesql` compiles without the optional dependency — mirroring how the Jira
 * connector hand-typed its `jira.js` seam. The provider is passed to the SDK's
 * transport at the dynamic-import boundary in `direct-transport.ts`.
 */

import { randomUUID } from 'node:crypto';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';
import { clearMcpSchemaDescriptor } from './schema-cache.js';

/** OAuth token set persisted per connection (the shape the SDK reads/writes). */
export interface McpOAuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Dynamic-client-registration result persisted per connection. */
export interface McpClientInformation {
  client_id: string;
  client_secret?: string;
  [k: string]: unknown;
}

/** The redirect_uris a stored/DCR client is bound to (empty when none recorded). */
export function clientRedirectUris(client: McpClientInformation): string[] {
  const r = (client as { redirect_uris?: unknown }).redirect_uris;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

/** Client metadata the provider advertises for DCR (public PKCE client). */
export interface McpClientMetadata {
  redirect_uris: string[];
  client_name: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

/** Pending OAuth state, keyed by the CSRF `state` token, spanning begin→callback. */
export interface McpPendingConnect {
  connectionId: string;
  connector: string;
  toolkit: string;
  serverUrl: string;
  /** The redirect uri used at begin — must be echoed identically at token exchange. */
  redirectUri: string;
  /** The HTTP transport used at begin — must match at token exchange. */
  transportKind: 'http' | 'sse';
  /** Set when this connect re-authorizes an existing registry row (reconnect). */
  targetConnectorId?: string;
}

/**
 * The hosted client-ID metadata document (CIMD). Authorization servers that
 * advertise `client_id_metadata_document_supported` fetch this URL to identify
 * the client instead of requiring dynamic registration — some (e.g. servers
 * with no `registration_endpoint`) support ONLY this mechanism.
 */
export const DEFAULT_CLIENT_METADATA_URL = 'https://latticedesktop.com/oauth/client-metadata.json';

/**
 * The effective client-ID metadata document URL. Overridable for self-hosters
 * and staging via `LATTICE_MCP_CLIENT_METADATA_URL`; an empty value disables
 * the mechanism entirely (falls back to dynamic registration / stored client).
 */
export function mcpClientMetadataUrl(): string | undefined {
  const env = process.env.LATTICE_MCP_CLIENT_METADATA_URL;
  if (env !== undefined) return env.trim() || undefined;
  return DEFAULT_CLIENT_METADATA_URL;
}

const tokKey = (id: string): string => `mcp_tokens:${id}`;
const cliKey = (id: string): string => `mcp_client:${id}`;
const verKey = (id: string): string => `mcp_verifier:${id}`;
const srvKey = (id: string): string => `mcp_server:${id}`;
const pendKey = (state: string): string => `mcp_pending:${state}`;

function readJson(kind: string): unknown {
  const raw = getAssistantCredential(kind);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // corrupt blob — treat as absent
  }
}

/** The stored OAuth token set for a connection, or null. */
export function getMcpTokens(connectionId: string): McpOAuthTokens | null {
  return readJson(tokKey(connectionId)) as McpOAuthTokens | null;
}

/** The stored server URL for a connection (for reconstructing the transport), or null. */
export function getMcpServerUrl(connectionId: string): string | null {
  return getAssistantCredential(srvKey(connectionId));
}

/** Persist the server URL for a connection. */
export function setMcpServerUrl(connectionId: string, url: string): void {
  setAssistantCredential(srvKey(connectionId), url);
}

/**
 * Store a pre-registered OAuth client (user-supplied client id + optional
 * secret) for a connection. The provider's `clientInformation()` then returns
 * it, which makes the SDK skip registration entirely — the path for
 * authorization servers that support neither a client-ID metadata document nor
 * dynamic registration.
 */
export function setMcpClientInformation(connectionId: string, info: McpClientInformation): void {
  setAssistantCredential(cliKey(connectionId), JSON.stringify(info));
}

/**
 * Revoke a connection's secrets (tokens, client registration, PKCE verifier)
 * but KEEP the stored server URL — it is not a secret, and retaining it is what
 * lets a disconnected connector be reconnected without re-entering the URL.
 */
export function revokeMcpSecrets(connectionId: string): void {
  deleteAssistantCredential(tokKey(connectionId));
  deleteAssistantCredential(cliKey(connectionId));
  deleteAssistantCredential(verKey(connectionId));
}

/** Remove every stored secret + metadata for a connection (hard teardown). */
export function clearMcpConnection(connectionId: string): void {
  revokeMcpSecrets(connectionId);
  deleteAssistantCredential(srvKey(connectionId));
  // Drop the introspected typed-schema descriptor too — otherwise a purge/reconnect/hard-teardown
  // leaves an orphaned `mcp_schema:<id>` in the encrypted store with nothing referencing it.
  clearMcpSchemaDescriptor(connectionId);
}

/** Record a pending OAuth connect (begin), keyed by the CSRF state token. */
export function putPendingConnect(state: string, pending: McpPendingConnect): void {
  setAssistantCredential(pendKey(state), JSON.stringify(pending));
}

/** Read a pending OAuth connect without consuming it (the callback route resolves the connector first). */
export function peekPendingConnect(state: string): McpPendingConnect | null {
  return readJson(pendKey(state)) as McpPendingConnect | null;
}

/** Resolve + consume a pending OAuth connect on callback (one-shot). */
export function takePendingConnect(state: string): McpPendingConnect | null {
  const p = readJson(pendKey(state)) as McpPendingConnect | null;
  if (p) deleteAssistantCredential(pendKey(state));
  return p;
}

/**
 * An `OAuthClientProvider` (structurally — see module doc) bound to one
 * connection. Persists tokens / DCR client info / PKCE verifier under the
 * connection id in the encrypted store, and captures the authorization URL the
 * SDK builds so the GUI can open it in the system browser.
 */
export class LatticeOAuthProvider {
  /** Set by {@link redirectToAuthorization} when the SDK needs the user to authorize. */
  capturedAuthorizationUrl: URL | undefined;

  constructor(
    private readonly connectionId: string,
    private readonly redirectUri: string,
    private readonly opts: { clientName?: string; scope?: string; state?: string } = {},
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  /**
   * The hosted client-ID metadata document URL (CIMD). When the authorization
   * server advertises support, the SDK uses this URL itself as the client_id —
   * no registration round-trip — which is the only workable path for servers
   * without a `registration_endpoint`. Static app identity; see module doc.
   */
  get clientMetadataUrl(): string | undefined {
    return mcpClientMetadataUrl();
  }

  get clientMetadata(): McpClientMetadata {
    const md: McpClientMetadata = {
      redirect_uris: [this.redirectUri],
      client_name: this.opts.clientName ?? 'Lattice',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public PKCE client (desktop / local app)
    };
    if (this.opts.scope !== undefined) md.scope = this.opts.scope;
    return md;
  }

  state(): string | undefined {
    return this.opts.state;
  }

  clientInformation(): McpClientInformation | undefined {
    const stored =
      (readJson(cliKey(this.connectionId)) as McpClientInformation | null) ?? undefined;
    if (!stored) return undefined;
    // A stored DCR client is bound to the redirect_uri it registered with. A
    // desktop app's loopback callback port is ephemeral (a new one each launch),
    // so a reused client registered with an OLD port is rejected by a strict
    // authorization server (invalid_grant / redirect mismatch) at token exchange.
    // If the recorded redirect_uri no longer matches the one we will present,
    // discard the client so the SDK re-registers with the CURRENT redirect_uri.
    // (A no-op when they match, or when no redirect_uri was recorded.)
    const registered = clientRedirectUris(stored);
    if (registered.length > 0 && !registered.includes(this.redirectUri)) return undefined;
    return stored;
  }

  saveClientInformation(info: McpClientInformation): void {
    // Record the redirect_uri this registration is bound to (the DCR response may
    // omit `redirect_uris`), so a later launch on a different loopback port knows
    // to re-register rather than reuse a client the server will reject.
    const withRedirect: McpClientInformation = clientRedirectUris(info).includes(this.redirectUri)
      ? info
      : { ...info, redirect_uris: [this.redirectUri] };
    setAssistantCredential(cliKey(this.connectionId), JSON.stringify(withRedirect));
  }

  tokens(): McpOAuthTokens | undefined {
    return getMcpTokens(this.connectionId) ?? undefined;
  }

  saveTokens(tokens: McpOAuthTokens): void {
    setAssistantCredential(tokKey(this.connectionId), JSON.stringify(tokens));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // We are a server, not a browser: capture the URL for the GUI to open rather
    // than navigating. beginConnect reads this after the connect attempt.
    this.capturedAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    setAssistantCredential(verKey(this.connectionId), codeVerifier);
  }

  codeVerifier(): string {
    const v = getAssistantCredential(verKey(this.connectionId));
    if (!v) throw new Error('missing PKCE code verifier for MCP connection');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') deleteAssistantCredential(tokKey(this.connectionId));
    if (scope === 'all' || scope === 'client') deleteAssistantCredential(cliKey(this.connectionId));
    if (scope === 'all' || scope === 'verifier')
      deleteAssistantCredential(verKey(this.connectionId));
  }
}

/** A fresh connection id (registry primary key + credential-store key). */
export function newConnectionId(): string {
  return randomUUID();
}

/** A fresh CSRF state token. */
export function newState(): string {
  return randomUUID().replace(/-/g, '');
}
