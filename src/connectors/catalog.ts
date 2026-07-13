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

/**
 * The built-in connectors, fresh instances per call. The GUI server passes the
 * result to the connectors routes.
 */
export function builtinConnectors(): Connector[] {
  return [genericConnector()];
}
