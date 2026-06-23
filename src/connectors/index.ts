/**
 * Connectors — sync external sources into Lattice as connected data types.
 *
 * Public surface: the SPI types, the connector registry, and the Composio
 * connector (which wraps the optional `@composio/core` dependency). Toolkit
 * specs (e.g. Jira) register themselves with the Composio connector; the sync
 * engine and teardown drive everything from the {@link ConnectedModelDef}s.
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
  CONNECTORS_TABLE,
} from './registry.js';
export type { ConnectorRecord, ConnectorStatus, CreateConnectorInput } from './registry.js';

export {
  ComposioConnector,
  registerToolkit,
  registeredToolkits,
  getToolkitSpec,
} from './composio/adapter.js';
export type { ToolkitSpec, ModelFetchSpec } from './composio/adapter.js';

export {
  getComposioApiKey,
  setComposioApiKey,
  clearComposioApiKey,
  loadComposioClient,
  ConnectorUnavailableError,
} from './composio/client.js';
export type { ComposioClient, ComposioActionResult } from './composio/client.js';
