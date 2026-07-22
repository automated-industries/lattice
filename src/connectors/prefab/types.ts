/**
 * A prefab connector catalog entry — pure METADATA that pre-fills the generic connect flow. There
 * is no per-entry connector implementation: a card's Connect posts this entry's pinned URL (+ scope)
 * to the generic `mcp` toolkit, and the introspective engine does the schema→tables work. So the
 * catalog stays a data list (curated + registry-sourced), never bespoke code per service.
 */
export interface CatalogEntry {
  /** Stable slug (a curated id like `atlassian`, or a registry host-slug). */
  id: string;
  /** Display label, e.g. `'Jira & Confluence'`. */
  label: string;
  /** Icon: a `data:` monogram (curated / fallback) or a remote https logo URL (rendered client-side). */
  icon: string;
  /** The MCP endpoint the connect flow posts. */
  serverUrl: string;
  /** Transport, inferred from the URL when omitted. */
  transport?: 'http' | 'sse';
  /** OAuth scopes to request (threaded into the connect flow). */
  scope?: string;
  /** Short note shown on the card (e.g. `'Enterprise Edition or above'`, `'developer preview'`). */
  authHint?: string;
  /** The provider needs a pre-registered OAuth client → reveal client-id/secret fields on connect. */
  needsClientCreds?: boolean;
  /** True one-click (OAuth 2.1 + DCR / CIMD, no manual client) — only a few providers today. */
  oneClick?: boolean;
  /** Provider docs for obtaining credentials / enabling the MCP server. */
  helpUrl?: string;
  /** `'curated'` (authoritative, sorts first) or `'registry'` (broad "browse more"). */
  source: 'curated' | 'registry';
  /** Provenance of a registry entry (`'mcp-registry'` | `'smithery'`). */
  origin?: string;
}
