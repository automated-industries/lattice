/**
 * Connectors — sync external sources into Lattice as connected data types.
 *
 * Public surface: the SPI types, the connector registry, the sync engine,
 * teardown + ACL helpers, and the built-in Jira connector (which talks to Jira
 * Cloud directly via the optional `jira.js` dependency). Everything is driven
 * from the {@link ConnectedModelDef}s a connector exposes — adding another
 * source is a new {@link Connector} implementation, not changes here.
 */

export type {
  Connector,
  ConnectedModelDef,
  ConnectedEdgeSpec,
  ExternalRecord,
  AuthorizeResult,
  ConnectionResult,
  ListChangesContext,
} from './types.js';

export {
  ensureConnectorRegistry,
  createConnector,
  getConnector,
  getConnectorByToolkit,
  listConnectors,
  recordSync,
  setConnectorStatus,
  deleteConnectorRecord,
  updateConnectorConnection,
  resolveConnectorIdentity,
  CONNECTORS_TABLE,
} from './registry.js';
export type { ConnectorRecord, ConnectorStatus, CreateConnectorInput } from './registry.js';

export {
  JiraConnector,
  ConnectorUnavailableError,
  loadJiraClient,
  getJiraCreds,
  setJiraCreds,
  clearJiraCreds,
} from './jira/connector.js';
export type { JiraCreds, JiraClient } from './jira/connector.js';

export { JIRA_MODELS, defineJiraTables } from './jira/models.js';

export {
  syncConnector,
  syncIfStale,
  syncStaleConnectors,
  collectConnectorKeys,
  DEFAULT_STALE_MS,
} from './sync.js';
export type { SyncConnectorResult, SyncConnectorOptions } from './sync.js';

export { disconnectConnector } from './teardown.js';
export type { DisconnectOptions, DisconnectResult } from './teardown.js';

export { enableConnectorRls, secureConnectorTables } from './acl.js';
