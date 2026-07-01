/**
 * The MCP transport seam.
 *
 * An {@link McpConnector} calls a read tool by name and gets back the tool's raw
 * JSON result; *how* the call reaches the server is the transport's concern. This
 * keeps the connector modules (schema + mappers) and the sync engine completely
 * decoupled from the MCP SDK — and lets tests inject a fake transport with canned
 * tool JSON instead of standing up a real server.
 *
 * There is exactly one production implementation ({@link './direct-transport.ts'}):
 * Lattice as a local MCP client over Streamable HTTP (remote servers) or stdio
 * (local server processes). Nothing routes through a cloud middleman.
 */

/** One MCP read-tool invocation. */
export interface McpToolCall {
  /** Tool name (e.g. `'search_threads'`). */
  tool: string;
  /** Tool arguments (the tool's input schema). */
  args: Record<string, unknown>;
}

/** A tool discovered on the server (name + optional description), for connect-time validation. */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * A live connection to one MCP server. Implementations MUST NOT hold the
 * connection open across calls unless {@link close} is honored — connectors open
 * a transport, drain a model's pages, and close.
 */
export interface McpTransport {
  /** List the callable tools on the server (connect-time validation + discovery). */
  listTools(): Promise<McpToolInfo[]>;
  /** Call one read tool; returns the parsed JSON content the tool produced. */
  callTool(call: McpToolCall): Promise<unknown>;
  /** Close the underlying client/session. */
  close(): Promise<void>;
}

/**
 * Builds a transport for one connected MCP server. The connector base takes this
 * as a constructor seam so tests inject a fake and production injects the direct
 * client. `connectionId` keys the stored OAuth token for the server.
 */
export type McpTransportFactory = (server: McpServerRef) => Promise<McpTransport>;

/** The resolved server + connection a transport should attach to. */
export interface McpServerRef {
  /** Server name (for diagnostics). */
  name: string;
  /** Remote endpoint, or undefined for a stdio server. */
  url?: string;
  /** Local stdio command + args, or undefined for an HTTP/SSE server. */
  command?: string;
  args?: string[];
  /** `'http'` (Streamable HTTP), `'sse'`, or `'stdio'` — resolved by the connector. */
  transport: 'http' | 'sse' | 'stdio';
  /** The registry connection id — keys the stored OAuth token (HTTP/SSE servers). */
  connectionId: string;
}
