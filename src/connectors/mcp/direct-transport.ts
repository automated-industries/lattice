/**
 * The direct MCP client transport — Lattice talks to an MCP server itself, on the
 * local machine, over Streamable HTTP (remote servers, per-server OAuth) or stdio
 * (a local server process, fully offline). This is the only production transport:
 * no data is routed through a cloud middleman.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL dependency, lazy-imported with
 * non-literal specifiers so `latticesql` compiles + installs without it (and so
 * it resolves under both Node and the desktop Deno runtime). The SDK surface is
 * hand-typed at the seam, mirroring the Jira `jira.js` seam.
 */

import { ConnectorUnavailableError } from '../errors.js';
import type { McpTransport, McpToolCall, McpToolInfo, McpServerRef } from './transport.js';
import {
  LatticeOAuthProvider,
  setMcpServerUrl,
  getMcpServerUrl,
  type McpClientMetadata,
} from './oauth.js';

// --- Hand-typed SDK seam -----------------------------------------------------

interface SdkTool {
  name: string;
  description?: string;
}
interface SdkContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}
interface SdkCallToolResult {
  content?: SdkContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}
interface SdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: SdkTool[] }>;
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<SdkCallToolResult>;
  close(): Promise<void>;
}
type SdkClientCtor = new (
  info: { name: string; version: string },
  options?: { capabilities?: Record<string, unknown> },
) => SdkClient;
interface SdkAuthTransport {
  finishAuth(authorizationCode: string): Promise<void>;
}
type SdkStreamableCtor = new (
  url: URL,
  opts?: { authProvider?: unknown; requestInit?: RequestInit },
) => SdkAuthTransport;
type SdkSseCtor = new (url: URL, opts?: { authProvider?: unknown }) => SdkAuthTransport;
type SdkStdioCtor = new (params: { command: string; args?: string[] }) => unknown;

interface LoadedSdk {
  Client: SdkClientCtor;
  StreamableHTTPClientTransport: SdkStreamableCtor;
  SSEClientTransport: SdkSseCtor;
  StdioClientTransport: SdkStdioCtor;
}

const CLIENT_INFO = { name: 'lattice', version: '5.0' } as const;

/**
 * Lazy-load the MCP SDK. Non-literal specifiers keep TypeScript from statically
 * resolving the optional dependency. Throws {@link ConnectorUnavailableError}
 * (mapped to a 422 by the routes) when it is not installed.
 */
async function loadSdk(): Promise<LoadedSdk> {
  try {
    const clientSpec = '@modelcontextprotocol/sdk/client/index.js';
    const httpSpec = '@modelcontextprotocol/sdk/client/streamableHttp.js';
    const sseSpec = '@modelcontextprotocol/sdk/client/sse.js';
    const stdioSpec = '@modelcontextprotocol/sdk/client/stdio.js';
    const clientMod = (await import(clientSpec as string)) as { Client: SdkClientCtor };
    const httpMod = (await import(httpSpec as string)) as {
      StreamableHTTPClientTransport: SdkStreamableCtor;
    };
    const sseMod = (await import(sseSpec as string)) as { SSEClientTransport: SdkSseCtor };
    const stdioMod = (await import(stdioSpec as string)) as { StdioClientTransport: SdkStdioCtor };
    return {
      Client: clientMod.Client,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
      SSEClientTransport: sseMod.SSEClientTransport,
      StdioClientTransport: stdioMod.StdioClientTransport,
    };
  } catch {
    throw new ConnectorUnavailableError(
      'MCP connectors require the optional dependency "@modelcontextprotocol/sdk". ' +
        'Install it with `npm install @modelcontextprotocol/sdk` to use connectors.',
    );
  }
}

/** Extract the JSON payload a read tool produced (structured content wins; else parse text). */
function extractToolResult(res: SdkCallToolResult): unknown {
  if (res.isError) {
    const msg = (res.content ?? [])
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
    throw new ConnectorUnavailableError(`MCP tool call failed: ${msg || 'unknown error'}`);
  }
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = (res.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON tool output — hand back the raw string
  }
}

/** A live {@link McpTransport} over a connected SDK client. */
class DirectMcpTransport implements McpTransport {
  constructor(private readonly client: SdkClient) {}

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.client.listTools();
    return (res.tools ?? []).map((t) => {
      const info: McpToolInfo = { name: t.name };
      if (t.description !== undefined) info.description = t.description;
      return info;
    });
  }

  async callTool(call: McpToolCall): Promise<unknown> {
    const res = await this.client.callTool({ name: call.tool, arguments: call.args });
    return extractToolResult(res);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Construct the right auth-bearing HTTP transport for a server (Streamable HTTP or SSE). */
function makeAuthTransport(
  sdk: LoadedSdk,
  url: URL,
  provider: LatticeOAuthProvider,
  kind: 'http' | 'sse',
): SdkAuthTransport {
  if (kind === 'sse') {
    return new sdk.SSEClientTransport(url, { authProvider: provider as unknown });
  }
  return new sdk.StreamableHTTPClientTransport(url, { authProvider: provider as unknown });
}

/** Build the SDK transport for a server ref (HTTP/SSE with the stored OAuth token, or stdio). */
function buildSdkTransport(sdk: LoadedSdk, ref: McpServerRef): unknown {
  if (ref.transport === 'stdio') {
    if (!ref.command) {
      throw new ConnectorUnavailableError(
        `stdio MCP server "${ref.name}" has no command configured.`,
      );
    }
    const args = ref.args ?? [];
    return new sdk.StdioClientTransport({ command: ref.command, args });
  }
  const url = ref.url ?? getMcpServerUrl(ref.connectionId);
  if (!url) {
    throw new ConnectorUnavailableError(`MCP server "${ref.name}" has no URL — reconnect.`);
  }
  const provider = new LatticeOAuthProvider(ref.connectionId, redirectUriPlaceholder());
  return makeAuthTransport(sdk, new URL(url), provider, ref.transport);
}

/**
 * The transport factory used at SYNC time — the connection is already authorized,
 * so the stored token is attached and no redirect is expected. Opens a client,
 * ready for `listChanges` to call read tools.
 */
export async function connectDirect(ref: McpServerRef): Promise<McpTransport> {
  const sdk = await loadSdk();
  const transport = buildSdkTransport(sdk, ref);
  const client = new sdk.Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  return new DirectMcpTransport(client);
}

// --- OAuth begin / complete --------------------------------------------------

/** The redirect uri is bound per begin/complete; sync-time transports never redirect. */
function redirectUriPlaceholder(): string {
  return 'http://127.0.0.1/mcp/oauth/callback';
}

export interface BeginOAuthArgs {
  connectionId: string;
  serverUrl: string;
  redirectUri: string;
  state: string;
  /** `'http'` (Streamable HTTP) or `'sse'`. */
  transportKind: 'http' | 'sse';
  clientName?: string;
  scope?: string;
}

/**
 * Begin an HTTP MCP server OAuth. Persists the server URL, attempts a connect,
 * and — if the server demands authorization — returns the authorization URL the
 * GUI opens in the system browser. If the server needs no auth (already
 * authorized / open server), returns `{ authorizationUrl: undefined }`.
 */
export async function beginOAuth(
  args: BeginOAuthArgs,
): Promise<{ authorizationUrl: string | undefined; toolNames: string[] }> {
  setMcpServerUrl(args.connectionId, args.serverUrl);
  const sdk = await loadSdk();
  const providerOpts: { clientName?: string; scope?: string; state?: string } = {
    state: args.state,
  };
  if (args.clientName !== undefined) providerOpts.clientName = args.clientName;
  if (args.scope !== undefined) providerOpts.scope = args.scope;
  const provider = new LatticeOAuthProvider(args.connectionId, args.redirectUri, providerOpts);
  const transport = makeAuthTransport(sdk, new URL(args.serverUrl), provider, args.transportKind);
  const client = new sdk.Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport);
    // Connected without a redirect — validate + close.
    const tools = await client.listTools();
    await client.close();
    return { authorizationUrl: undefined, toolNames: (tools.tools ?? []).map((t) => t.name) };
  } catch (err) {
    // The provider captured the authorization URL iff the SDK decided a redirect
    // is required — a reliable signal independent of the error class.
    if (provider.capturedAuthorizationUrl) {
      return { authorizationUrl: provider.capturedAuthorizationUrl.toString(), toolNames: [] };
    }
    throw err; // genuine connect failure — surface it loudly
  }
}

export interface CompleteOAuthArgs {
  connectionId: string;
  redirectUri: string;
  code: string;
  /** `'http'` (Streamable HTTP) or `'sse'` — must match the begin call. */
  transportKind: 'http' | 'sse';
  clientName?: string;
  scope?: string;
  state?: string;
}

/**
 * Complete an HTTP MCP server OAuth: exchange the authorization code (the SDK
 * stores the token via the provider), then validate by listing tools. Returns the
 * discovered tool names for the caller to sanity-check.
 */
export async function completeOAuth(args: CompleteOAuthArgs): Promise<{ toolNames: string[] }> {
  const serverUrl = getMcpServerUrl(args.connectionId);
  if (!serverUrl) {
    throw new ConnectorUnavailableError('No pending MCP connection — restart the connect flow.');
  }
  const sdk = await loadSdk();
  const providerOpts: { clientName?: string; scope?: string; state?: string } = {};
  if (args.clientName !== undefined) providerOpts.clientName = args.clientName;
  if (args.scope !== undefined) providerOpts.scope = args.scope;
  if (args.state !== undefined) providerOpts.state = args.state;
  const provider = new LatticeOAuthProvider(args.connectionId, args.redirectUri, providerOpts);
  const transport = makeAuthTransport(sdk, new URL(serverUrl), provider, args.transportKind);
  await transport.finishAuth(args.code);
  const client = new sdk.Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  return { toolNames: (tools.tools ?? []).map((t) => t.name) };
}

// Re-export for tests + connectors that build custom client metadata.
export type { McpClientMetadata };
