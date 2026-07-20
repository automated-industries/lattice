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
  CredentialConnector,
  CredentialField,
  ToolkitPresentation,
  ConnectedModelDef,
  ConnectedEdgeSpec,
  ExternalRecord,
  AuthorizeResult,
  ConnectionResult,
  ListChangesContext,
} from './types.js';
export { isCredentialConnector } from './types.js';

export { builtinConnectors } from './catalog.js';

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

export { ConnectorUnavailableError } from './errors.js';

// --- MCP-backed connectors ---------------------------------------------------
export type { McpConnector, McpServerSpec, McpBeginResult } from './types.js';
export { isMcpConnector } from './types.js';
export {
  McpConnectorBase,
  SimpleMcpConnector,
  type McpConnectorSpec,
  type McpConnectorDeps,
  type McpModelBinding,
  type McpOAuthDriver,
} from './mcp/connector-base.js';
export type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpTransportFactory,
  McpServerRef,
} from './mcp/transport.js';
export { connectDirect } from './mcp/direct-transport.js';
export { mcpModel } from './mcp/connected-model.js';
export { genericConnector, introspectiveConnector } from './generic/connector.js';
export type { IntrospectiveSpec } from './generic/connector.js';

export {
  DatabaseConnector,
  assembleConnectionString,
  getDbSourceCreds,
  setDbSourceCreds,
  clearDbSourceCreds,
} from './db-source/connector.js';
export { dialectFor, PostgresDialect } from './db-source/dialects.js';
export type { SqlDialect, PageOpts, SqlQuery } from './db-source/dialects.js';
export {
  getSchemaDescriptor,
  setSchemaDescriptor,
  clearSchemaDescriptor,
  buildModelDefs,
  latticeTableName,
  slugify as slugifyDbName,
} from './db-source/schema-cache.js';
export type { DbSchemaDescriptor, DbTableDesc, DbColumnDesc } from './db-source/schema-cache.js';

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

export { describeConnectedSources } from './describe-connected.js';
