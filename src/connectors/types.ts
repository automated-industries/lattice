/**
 * Connector SPI — the fetch/auth contract a connector implementation satisfies.
 *
 * A *connector* (e.g. the built-in Jira connector) handles authentication and
 * data fetching for an external product (*toolkit*, e.g. `jira`), and exposes
 * each external object type as a *connected data type* — a Lattice table whose
 * rows are synced from the source.
 *
 * The SPI is deliberately small: establish a connection, stream normalized
 * records for a model, and revoke. Everything Lattice-specific
 * (schema, ACL, graph edges, teardown) is driven from the {@link ConnectedModelDef}
 * descriptors and handled by the sync engine — a connector only fetches + maps.
 */

import type { TableDefinition } from '../types.js';

/**
 * A foreign-key relation on a connected model, used to auto-build graph edges
 * after a sync (via `extractEdgesFromColumn`) so connected rows are retrievable
 * as relationship-aware context.
 */
export interface ConnectedEdgeSpec {
  /** FK column on this model's table. */
  fkColumn: string;
  /** The table the FK points to. */
  dstTable: string;
  /** Edge type label (e.g. `'in_project'`). */
  type: string;
}

/**
 * One model a toolkit exposes as a connected data type. Carries the full Lattice
 * {@link TableDefinition} (with a `source` descriptor) plus the graph edges to
 * derive after each sync.
 */
export interface ConnectedModelDef {
  /** Model key within the toolkit (e.g. `'issue'`). */
  model: string;
  /** Lattice table name (e.g. `'jira_issues'`). */
  table: string;
  /** Natural-key column — also the table's primary key, for idempotent upsert. */
  naturalKey: string;
  /** The table definition registered with `db.define()` (must set `source`). */
  definition: TableDefinition;
  /** FK relations to materialize as graph edges after sync. */
  graphEdges?: ConnectedEdgeSpec[];
  /** Embedded text columns, so the sync engine can refresh embeddings. */
  embedded?: boolean;
  /**
   * Declares this model is fetched once *per parent row* rather than in one pass
   * (e.g. comments fetched per issue). The sync engine queries the parent table's
   * already-synced keys and calls {@link Connector.listChanges} with each as
   * `parentKey`. Omit for models fetched in a single paged pass.
   */
  parent?: {
    /** The parent connected table (must be synced earlier in the model order). */
    table: string;
    /** The parent's key column to iterate (its natural key / primary key). */
    keyColumn: string;
    /** The FK column on THIS table to stamp with each parent key during sync. */
    childColumn: string;
    /**
     * Optional parent timestamp column (e.g. `'updated'`). When set, after the
     * first sync only parents whose timestamp advanced since the connector's last
     * sync are re-fetched — bounding an O(parents) per-parent crawl on a large
     * source. (The pass is then incremental, so vanished children aren't pruned.)
     */
    incrementalColumn?: string;
  };
}

/**
 * A record fetched from the external source, normalized for upsert. `row` holds
 * the column→value map for the Lattice table (the connector lineage columns are
 * stamped by the sync engine, not here).
 */
export interface ExternalRecord {
  /** Natural-key value (the row's primary key). */
  id: string;
  /** Column→value map for the table row. */
  row: Record<string, unknown>;
}

/**
 * Sidebar/settings presentation metadata for one toolkit — the label and logo
 * the GUI renders. Driven entirely by the connector so adding a connector needs
 * no GUI code.
 */
export interface ToolkitPresentation {
  /** Human-readable name shown next to the logo (e.g. `'Jira'`). */
  label: string;
  /** Logo as a `data:` URI (e.g. `data:image/svg+xml;base64,…`), shown as an `<img src>`. */
  icon?: string;
}

/**
 * One credential input on a connector's connect form — METADATA describing the
 * field, never a value. The GUI renders one input per entry; the generic connect
 * handler reads the submitted values by `key`.
 */
export interface CredentialField {
  /** Body key the submitted value is sent under (e.g. `'token'`). */
  key: string;
  /** Field label shown to the user (e.g. `'API token'`). */
  label: string;
  /** Input type — `'password'` masks the value. */
  type: 'text' | 'password';
  /** Optional placeholder shown in the empty input. */
  placeholder?: string;
  /** Whether the value is required (default true at the route layer). */
  required?: boolean;
}

/** Result of beginning an OAuth authorization for a member. */
export interface AuthorizeResult {
  /** The URL the member must visit to grant access. */
  redirectUrl: string;
  /** Opaque handle to poll/finalize the pending connection. */
  pendingId?: string;
}

/** Result of finalizing a connection after the member completes OAuth. */
export interface ConnectionResult {
  /** The backend connected-account id, stored in the registry. */
  connectionId: string;
}

/** Context for a sync fetch — the member's connection + identity. */
export interface ListChangesContext {
  /** The connector backend's connected-account id. */
  connectionId: string;
  /** Per-member identity (the connector backend's user id). */
  userId: string;
  /** Cursor from a prior page, or null for a full pull. */
  cursor?: string | null;
  /** Parent row key for a per-parent model (e.g. an issue key when fetching its comments). */
  parentKey?: string;
}

/**
 * A connector implementation. Concrete connectors (e.g. the Jira connector)
 * implement this; the sync engine and GUI program against it.
 */
export interface Connector {
  /** Connector id (e.g. `'jira'`). */
  readonly connector: string;
  /** The toolkits this connector can serve (e.g. `['jira']`). */
  toolkits(): string[];
  /** The connected-data-type models for a toolkit. */
  models(toolkit: string): ConnectedModelDef[];
  /** Sidebar/settings presentation (label + logo) for a toolkit this connector serves. */
  presentation(toolkit: string): ToolkitPresentation;
  /** Begin OAuth for a member + toolkit; returns a redirect URL. */
  authorize(userId: string, toolkit: string): Promise<AuthorizeResult>;
  /** Finalize the connection once the member has completed OAuth. */
  completeAuth(userId: string, toolkit: string): Promise<ConnectionResult>;
  /**
   * Stream normalized records for a model, paginated and bounded. Implementations
   * MUST page rather than load everything at once (bounded reads).
   */
  listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord>;
  /**
   * Optional batch lifecycle. The sync engine calls `beginSyncSession` before a
   * connector's models are synced and `endSyncSession` after (even on error), so a
   * connector can open ONE shared resource (e.g. a single MCP transport) and reuse
   * it across every `listChanges` call instead of reconnecting per parent key.
   * Connectors that omit these fall back to per-call open (behavior unchanged).
   */
  beginSyncSession?(connectionId: string): Promise<void>;
  endSyncSession?(connectionId: string): Promise<void>;
  /** Revoke a connected account (teardown). May retain non-secret reconnect state. */
  disconnect(connectionId: string): Promise<void>;
  /**
   * Remove ALL local state for a connection, including anything `disconnect`
   * retained for reconnect (e.g. a stored server URL). Called on hard teardown,
   * after the registry row is deleted. Optional; omit when disconnect is total.
   */
  purgeConnection?(connectionId: string): Promise<void>;
}

/**
 * A connector that connects via direct credentials the member pastes in — an API
 * key, token, site URL, etc. — rather than an OAuth redirect. The GUI renders a
 * form from {@link CredentialConnector.credentialFields} and calls
 * {@link CredentialConnector.connect} with the collected values; the connector
 * validates them against the source and stores them encrypted.
 */
export interface CredentialConnector extends Connector {
  /** The credential inputs the connect form must render (metadata only). */
  credentialFields(): CredentialField[];
  /**
   * Validate the submitted credentials against the source and, on success, store
   * them encrypted under a fresh connection id. Returns the connection id (the
   * caller records it in the registry) and a validated display name for the UI.
   * Throws loudly on invalid credentials — never returns a silent default.
   */
  connect(creds: Record<string, string>): Promise<{
    connectionId: string;
    displayName: string | null;
  }>;
  /** Optional URL to docs for obtaining the credentials (shown as a help link). */
  helpUrl?(): string | undefined;
}

/**
 * True when `c` is a {@link CredentialConnector} — i.e. it connects via direct
 * credentials (both `connect` and `credentialFields` are functions). The route
 * layer uses this to decide whether to serve the credential connect form.
 */
export function isCredentialConnector(c: Connector): c is CredentialConnector {
  const cc = c as Partial<CredentialConnector>;
  return typeof cc.connect === 'function' && typeof cc.credentialFields === 'function';
}

// --- MCP-backed connectors ---------------------------------------------------

/**
 * How Lattice reaches one MCP server's tools. Everything runs on the local
 * machine — Lattice IS the MCP client. A remote server is reached over Streamable
 * HTTP (authorized with that server's own OAuth); a local server runs as a stdio
 * child process (fully offline, no OAuth). No data is routed through any cloud
 * middleman (no Lattice-cloud, no model inference).
 */
export interface McpServerSpec {
  /** Stable server name (e.g. `'atlassian'`, `'monday'`). */
  name: string;
  /** Remote Streamable-HTTP endpoint. Omit for a stdio server. */
  url?: string;
  /** Local stdio command (the server runs as a child process, fully offline). */
  command?: string;
  /** Args for the stdio command. */
  args?: string[];
  /**
   * Transport. Inferred when omitted: `command` → `'stdio'`, a `url` ending in
   * `/sse` → `'sse'` (the legacy Server-Sent-Events transport many hosted MCP
   * servers still use), otherwise `'http'` (Streamable HTTP).
   */
  transport?: 'http' | 'sse' | 'stdio';
  /** Whether the server requires OAuth. Defaults to true for HTTP/SSE, false for stdio. */
  oauth?: boolean;
}

/** Begin-connect result: either an OAuth redirect to complete, or an immediate connection. */
export type McpBeginResult =
  | { kind: 'redirect'; redirectUrl: string; pendingId: string }
  | { kind: 'connected'; connectionId: string; displayName: string | null };

/**
 * A connector whose data comes from an MCP server it reads over a local transport
 * (mechanism 2 — Lattice is the MCP client, per-server OAuth, tokens in the
 * machine-local encrypted store). Connecting means authorizing that server, not a
 * broker or a Claude subscription. The sync engine is unchanged — `listChanges`
 * calls MCP read tools instead of a bespoke REST client.
 */
export interface McpConnector extends Connector {
  /** The MCP server(s) this toolkit reads from. */
  mcpServers(toolkit: string): McpServerSpec[];
  /**
   * Begin connecting. For an OAuth server, run discovery + stash PKCE state and
   * return a redirect the GUI opens (system browser on desktop). For a local/open
   * server, validate via `tools/list` and return the connection immediately.
   * `redirectUri` is where the GUI receives the code; `serverUrl` overrides the
   * toolkit default (used by the generic bring-your-own-URL connector).
   * `clientInfo` is a pre-registered OAuth client (id + optional secret) for
   * authorization servers that support neither a client-ID metadata document nor
   * dynamic registration. `targetConnectorId` marks a reconnect of an existing
   * registry row rather than a new connection.
   */
  beginConnect(
    userId: string,
    toolkit: string,
    opts?: {
      redirectUri?: string;
      serverUrl?: string;
      clientInfo?: { client_id: string; client_secret?: string };
      targetConnectorId?: string;
    },
  ): Promise<McpBeginResult>;
  /**
   * Finish an OAuth connect: exchange the `code`, store the token under
   * `mcp_creds:<connectionId>`, and return the connection. `serverName` is the
   * server's self-reported name from the MCP handshake (display-name material);
   * `targetConnectorId` echoes the reconnect target recorded at begin. Throws
   * loudly on a mismatched state or a failed exchange — never a silent default.
   */
  completeConnect(
    pendingId: string,
    params: { code: string; state?: string },
  ): Promise<{
    connectionId: string;
    displayName: string | null;
    serverName?: string;
    targetConnectorId?: string;
  }>;
}

/** True when `c` is an {@link McpConnector} (connects via an MCP server, not credentials). */
export function isMcpConnector(c: Connector): c is McpConnector {
  const m = c as Partial<McpConnector>;
  return typeof m.beginConnect === 'function' && typeof m.mcpServers === 'function';
}
