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
import { DatabaseConnector } from './db-source/connector.js';

/**
 * The built-in connectors, fresh instances per call. The GUI server passes the
 * result to the connectors routes.
 *
 * The generic connector is the bring-your-own-MCP-URL path. The hand-authored,
 * parameterized-tool connectors (Atlassian/Jira+Confluence, Gmail, Google Calendar,
 * Google Drive, Slack, Salesforce) live under `src/connectors/<name>/` and are fully
 * built + tested, but are HELD OUT of this list until each has a live-OAuth spike
 * confirming its real endpoint URL + result-shape mappers (only Atlassian's URL is a
 * real MCP endpoint today; the others are documented placeholders). To enable one,
 * import its factory and add it here — that is the only wiring needed.
 */
export function builtinConnectors(): Connector[] {
  return [genericConnector()];
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
  // Every built-in connector PLUS the external-DB (db_source) connector, which is
  // deliberately absent from builtinConnectors() (surfaced via Inputs › Databases, not
  // the Connectors grid) but whose imported db_… tables must still refresh on access.
  // Derived from builtinConnectors() rather than hardcoded, so whenever a hand-authored
  // connector is un-gated there its tables' on-access refresh works automatically
  // instead of silently no-oping. db_source is not in the built-in list, so no dedupe.
  return [...builtinConnectors(), new DatabaseConnector()];
}
