/**
 * The connector catalog — the single place every built-in connector is wired.
 *
 * Routes, the sidebar, the settings panel, and sync-all all iterate this list via
 * the data-driven API ({@link Connector.presentation} / `credentialFields` /
 * `models`), so adding a connector is a new module under `src/connectors/<toolkit>/`
 * plus one line here — no route, GUI, or SPI changes.
 *
 * Named `catalog.ts` (not `registry.ts`) to avoid confusion with the
 * `__lattice_connectors` DB table managed in `registry.ts`: this is the in-memory
 * set of connector *implementations*; that is the per-member *connection* records.
 */

import type { Connector } from './types.js';
import { JiraConnector } from './jira/connector.js';
import { TrelloConnector } from './trello/connector.js';

/**
 * Every built-in connector, fresh instances per call. The GUI server passes the
 * result to the connectors routes; toolkit ids must be unique across the list.
 */
export function builtinConnectors(): Connector[] {
  return [new JiraConnector(), new TrelloConnector()];
}
