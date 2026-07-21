/**
 * The connector catalog — the single place every built-in connector is wired.
 *
 * Routes, the sidebar, the settings panel, and sync-all all iterate this list via
 * the data-driven API ({@link Connector.presentation} / `mcpServers` / `models`).
 *
 * There is exactly ONE built-in connector: the generic MCP connector. Lattice is
 * a local MCP client — the user supplies any MCP server URL, authorizes it with
 * that server's own OAuth, and each added server is its own connection. Nothing
 * is routed through a cloud middleman, and no provider-specific connector code
 * exists; a provider is just another MCP server URL.
 *
 * Named `catalog.ts` (not `registry.ts`) to avoid confusion with the
 * `__lattice_connectors` DB table managed in `registry.ts`: this is the in-memory
 * set of connector *implementations*; that is the per-member *connection* records.
 */

import type { Connector } from './types.js';
import { genericConnector } from './generic/connector.js';
import { atlassianConnector } from './atlassian/connector.js';
import { DatabaseConnector } from './db-source/connector.js';

/**
 * The built-in connectors, fresh instances per call. The GUI server passes the
 * result to the connectors routes.
 *
 * The generic connector is the bring-your-own-MCP-URL path; the hand-authored
 * connectors (Atlassian first) model parameterized read tools the introspective
 * path can't (their tools need a `cloudId`), so their tables appear out of the box.
 */
export function builtinConnectors(): Connector[] {
  return [genericConnector(), atlassianConnector()];
}

/**
 * Connectors eligible for ON-ACCESS refresh ({@link import('./freshness.js').touchConnectorTable}).
 * A superset of {@link builtinConnectors}: it ALSO includes the external-DB (`db_source`)
 * connector, which is deliberately absent from the built-in list — it is surfaced through the
 * dedicated Inputs › Databases UI, not the generic Connectors grid — but its imported `db_…`
 * tables must still refresh on access. Without `db_source` here, touching an imported table would
 * resolve no connector implementation and silently never refresh.
 */
export function freshnessConnectors(): Connector[] {
  return [genericConnector(), new DatabaseConnector()];
}
