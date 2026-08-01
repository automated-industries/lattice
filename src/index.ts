export { Lattice, SeedReconciliationError } from './lattice.js';
export type { PkLookup, LatticeConfigInput } from './lattice.js';
export { parseConfigFile, parseConfigString } from './config/parser.js';
export type { ParsedConfig } from './config/parser.js';
export type {
  LatticeFieldType,
  LatticeFieldDef,
  LatticeEntityDef,
  LatticeEntityRenderSpec,
  LatticeConfig,
  ComputedTableDef,
  ComputedFieldDef,
} from './config/types.js';
export type {
  Row,
  LatticeOptions,
  SecurityOptions,
  TableDefinition,
  MultiTableDefinition,
  WritebackDefinition,
  WritebackValidationResult,
  RewardScores,
  EmbeddingsConfig,
  VectorIndexOptions,
  FtsConfig,
  SearchOptions,
  SearchResult,
  QueryOptions,
  CountOptions,
  BoundedCountOptions,
  InitOptions,
  Migration,
  WatchOptions,
  RenderResult,
  SyncResult,
  StopFn,
  AuditEvent,
  // v0.2 additions
  PrimaryKey,
  BelongsToRelation,
  HasManyRelation,
  Relation,
  FilterOp,
  Filter,
  // v4.1 query primitives
  FilterExpr,
  FilterOr,
  FilterAnd,
  QueryProjection,
  AggregateFunction,
  AggregateSpec,
  AggregateHaving,
  AggregateOptions,
  AggregateResult,
  QueryPageOptions,
  QueryPageResult,
  // v0.3 additions
  BuiltinTemplateName,
  RenderHooks,
  TemplateRenderSpec,
  RenderSpec,
  // v0.5 additions
  SourceQueryOptions,
  OrderBySpec,
  SelfSource,
  HasManySource,
  ManyToManySource,
  BelongsToSource,
  CustomSource,
  EnrichmentLookup,
  EnrichedSource,
  EntityFileSource,
  EntityRenderSpec,
  EntityRenderTemplate,
  EntityTableTemplate,
  EntityTableColumn,
  EntityProfileTemplate,
  EntityProfileField,
  EntityProfileSection,
  EntitySectionsTemplate,
  EntitySectionPerRow,
  EntityFileSpec,
  EntityContextDefinition,
  WriteHook,
  WriteHookContext,
  UpsertByNaturalKeyOptions,
  LinkOptions,
  SeedConfig,
  SeedLinkSpec,
  SeedResult,
  UnresolvedLink,
  ReportSection,
  ReportConfig,
  ReportSectionResult,
  ReportResult,
  CleanupOptions,
  CleanupResult,
  ReverseSyncUpdate,
  ReverseSyncError,
  ReverseSyncResult,
  ReverseSeedDetection,
  ReverseSeedTableResult,
  ReverseSeedResult,
  ReconcileOptions,
  ReconcileResult,
  ChangelogOptions,
  ChangeEntry,
} from './types.js';
// v4.1 — bounded-read guard error (QueryOptions.maxRows / defaultMaxRows).
export { BoundedReadError } from './query/core.js';
export { contentHash } from './render/writer.js';
export { estimateTokens, applyTokenBudget } from './render/token-budget.js';
export {
  readManifest,
  writeManifest,
  manifestPath,
  entityFileNames,
} from './lifecycle/manifest.js';
export type {
  LatticeManifest,
  EntityContextManifestEntry,
  EntityFileManifestInfo,
} from './lifecycle/manifest.js';
// v0.18 additions — encryption utilities + pre-init helpers
export { fixSchemaConflicts } from './lifecycle/pre-init.js';

export { encrypt, decrypt, deriveKey, isEncrypted } from './security/encryption.js';
// v0.6 additions — markdown render utilities
export { frontmatter, markdownTable, slugify, truncate } from './render/markdown.js';
export type { MarkdownTableColumn } from './render/markdown.js';
export { createSQLiteStateStore, InMemoryStateStore } from './writeback/state-store.js';
export type { WritebackStateStore } from './writeback/state-store.js';
export { parseSessionWrites, generateWriteEntryId } from './session/index.js';
export type {
  SessionWriteEntry,
  SessionWriteOp,
  SessionWriteParseResult,
} from './session/index.js';
export {
  parseSessionMD,
  parseMarkdownEntries,
  generateEntryId,
  validateEntryId,
  DEFAULT_ENTRY_TYPES,
  DEFAULT_TYPE_ALIASES,
  applyWriteEntry,
  READ_ONLY_HEADER,
  createReadOnlyHeader,
} from './session/index.js';
export type {
  SessionEntry,
  ParseResult,
  ParseError,
  SessionParseOptions,
  ApplyWriteResult,
  ReadOnlyHeaderOptions,
} from './session/index.js';
export { autoUpdate } from './auto-update.js';
export type { AutoUpdateResult } from './auto-update.js';
// The read-only half of the same subject: whether a newer version is published,
// and what this copy could do about it. Separate from the installer on purpose —
// reporting has no consequence, so it is safe on a start-up path, a health check,
// or an inventory pass, and a registry it could not reach is reported as such
// rather than as "you are up to date".
export { checkForNewerVersion } from './ops/update.js';
export type { UpdateAvailability, UpdateCheckOptions } from './ops/update.js';

// v1.6 additions — pluggable storage adapters
export type { StorageAdapter, PreparedStatement } from './db/adapter.js';
export { SQLiteAdapter } from './db/sqlite.js';
export { DenoSqliteAdapter } from './db/sqlite-deno.js';
export { PostgresAdapter } from './db/postgres.js';
export type { PostgresAdapterOptions } from './db/postgres.js';

// v4.1 — declarative computed columns + materialized rollups.
export {
  computedColumnOrder,
  computeColumns,
  computedColumnDdl,
  rollupColumnDdl,
  allComputedDeps,
  ComputedColumnCycleError,
} from './schema/computed.js';
export type {
  ComputedColumnSpec,
  MaterializedRollupSpec,
  RollupFunction,
} from './schema/computed.js';

// Computed tables — config-defined, read-only SQL projections with optional
// AI-derived fields materialized once and joined deterministically.
export {
  compileComputedTable,
  computedTableOrder,
  registerComputedTables,
  ComputedTableCycleError,
} from './schema/computed-table.js';
export type {
  CompiledComputedTable,
  CompiledAiField,
  ComputedSchema,
  ComputedSchemaTable,
  ComputedTableHost,
  RegisterComputedTablesOptions,
  ComputedRegistrationResult,
} from './schema/computed-table.js';
export {
  ensureAiTables,
  runComputedFill,
  purgeAiField,
  readComputedState,
  AI_MAP_TABLE,
  AI_CELL_TABLE,
  COMPUTED_STATE_TABLE,
} from './schema/computed-fill.js';
export type {
  FillLlm,
  ComputedFillOptions,
  ComputedFillReport,
  FieldFillResult,
  ComputedFieldState,
} from './schema/computed-fill.js';
export { parseCalcExpr, emitCalcExpr, CalcExprError } from './schema/calc-expr.js';
export type { CalcExpr, CalcNode, CalcEmitContext, CalcRefResolver } from './schema/calc-expr.js';

// v4.1 — data governance: immutable provenance + trust/verification workflow.
export {
  ProvenanceImmutableError,
  provenanceColumns,
  resolveProvenanceFields,
  resolveTrustDefault,
  TRUST_COLUMNS,
  ALL_PROVENANCE_FIELDS,
} from './schema/governance.js';
export type {
  ProvenanceConfig,
  ProvenanceField,
  TrustConfig,
  TrustState,
} from './schema/governance.js';

// v4.3 — connected data types (tables backed by an external source/connector).
export {
  ConnectedSourceImmutableError,
  connectedColumns,
  CONNECTED_COLUMNS,
  IMMUTABLE_CONNECTED_FIELDS,
} from './schema/connected.js';
export type { ConnectorSource, ConnectedVisibility } from './schema/connected.js';

// v4.3 — connectors: SPI, registry, and the Jira connector (optional dep).
export * from './connectors/index.js';

// v4.1 — durable retry for transient DB failures (idempotent ops only).
export { withRetry, isRetryableDbError } from './db/retry.js';
export type { RetryOptions } from './db/retry.js';

// v4.1 — online, resumable chunked migrations (no long lock; resume after kill).
export {
  applyChunkedMigration,
  resumeMigration,
  revertMigration,
  listMigrationCheckpoints,
  getMigrationCheckpoint,
  ensureCheckpointTable,
} from './schema/chunked-migration.js';
export type {
  ChunkedMigrationOptions,
  ChunkedMigrationResult,
  MigrationCheckpoint,
  MigrationStatus,
} from './schema/chunked-migration.js';

// v1.12 additions — framework-shipped tables, machine-local user config,
// content-addressed blob store, ed25519-style team auth client.
export {
  NATIVE_ENTITY_DEFS,
  NATIVE_ENTITY_NAMES,
  isNativeEntity,
  registerNativeEntities,
  adoptNativeEntities,
  listNativeBindings,
  NATIVE_REGISTRY_TABLE,
} from './framework/native-entities.js';
export type { AdoptNativeOptions, AdoptResult } from './framework/native-entities.js';
export { attachBlob, hashFile } from './framework/blob-store.js';
export type { BlobMetadata } from './framework/blob-store.js';
export { createS3Store, s3Key, S3UnavailableError } from './framework/s3-store.js';
export type { RemoteBlobStore, S3StoreConfig } from './framework/s3-store.js';
export { resolveActiveS3Config, activeWorkspaceLabel } from './framework/s3-config.js';
export type { S3Config } from './framework/s3-config.js';
export {
  configDir,
  getOrCreateMasterKey,
  readIdentity,
  writeIdentity,
  listDbCredentials,
  getDbCredential,
  saveDbCredential,
  saveDbCredentialForTeam,
  deleteDbCredential,
  listTokens,
  readToken,
  writeToken,
  deleteToken,
  readPreferences,
  writePreferences,
  analyticsEnabled,
} from './framework/user-config.js';
export type { UserIdentity, UserPreferences } from './framework/user-config.js';

// v2.0 — the single `.lattice` root + first-class workspaces.
export {
  findLatticeRoot,
  resolveLatticeRoot,
  ensureLatticeRoot,
  // Which root a SESSION serves — the named root, then LATTICE_ROOT, then the
  // home root, never an upward search. This is what the CLI, the GUI and
  // `Lattice.openWorkspace` resolve with, so an embedder that wants to register
  // a workspace the app will actually see must resolve it the same way.
  resolveSessionRoot,
  rootConfigDir,
  workspacesDir,
  registryPath,
  workspaceDir,
  workspaceDataDir,
  workspaceContextDir,
  workspaceBlobsDir,
  workspaceConfigPath,
  ROOT_DIRNAME,
  CONFIG_SUBDIR,
  WORKSPACES_SUBDIR,
} from './framework/lattice-root.js';
export type { SessionRoot, SessionRootSource } from './framework/lattice-root.js';
export {
  addWorkspace,
  listWorkspaces,
  getWorkspace,
  getActiveWorkspace,
  setActiveWorkspace,
  readRegistry,
  writeRegistry,
  resolveWorkspacePaths,
  workspaceDbPath,
  defaultWorkspaceYaml,
  toSafeDirName,
  LOCAL_DB_RELPATH,
} from './framework/workspace.js';
export type {
  WorkspaceRecord,
  WorkspaceRegistry,
  WorkspacePaths,
  AddWorkspaceOptions,
} from './framework/workspace.js';
// Taking a workspace away, and managing the SET of databases inside one. Both
// existed only inside request handlers, which meant standing a machine up — or
// tearing down what a test made — needed a browser and somebody clicking. The
// delete is the whole removal, registry record and owned files together, because
// doing one without the other leaves either a record that opens into nothing or a
// database nobody lists; and for a shared workspace it takes the credentials this
// machine kept in order to reconnect, so "disconnected" means disconnected. The
// shared database itself is never touched. Deleting a database carries the two
// rules that make it safe with it: nothing outside the workspace's own set, and
// never the last one.
export { deleteWorkspace, cleanupWorkspaceFiles } from './ops/workspace-lifecycle.js';
export type {
  DeleteWorkspaceInput,
  WorkspaceRemoval,
  WorkspaceFileCleanup,
} from './ops/workspace-lifecycle.js';
export { createDatabase, deleteDatabase } from './ops/databases.js';
export type {
  CreateDatabaseInput,
  DatabaseCreation,
  DeleteDatabaseInput,
  DatabaseDeletion,
  RemainingDatabases,
} from './ops/databases.js';
export { workspaceError, workspaceErrorCode } from './ops/workspace-errors.js';
export type { WorkspaceError, WorkspaceErrorCode } from './ops/workspace-errors.js';
// What a workspace's own configuration says: its name, and whether a database it
// might point at is actually reachable. Renaming writes the configuration AND the
// registry that lists it, because a name that only half-changes reads as a rename
// that silently did not happen; the connection test answers rather than throws,
// since an unreachable host is the thing the caller asked about.
export {
  renameWorkspace,
  testDatabaseConnection,
  MAX_WORKSPACE_NAME_CHARS,
} from './ops/workspace-config.js';
export type {
  RenameWorkspaceInput,
  WorkspaceRename,
  DatabaseTarget,
  DatabaseConnectionTest,
  DatabaseConnectionResult,
} from './ops/workspace-config.js';
// A workspace is a config plus the store its `db:` line names, and moving it to
// another store is two writes that have to agree. Doing one without the other
// leaves a key nobody names or a name with nothing behind it — so the pair is one
// call, and it hands back the way back for a caller (a migration) that has more
// steps to take after it.
export {
  pointConfigAtDatabase,
  rewriteDbLine,
  readDbLine,
  normalizeLabel,
  isCredentialKey,
  credentialRef,
  portableDbPath,
  resolveRelativeToConfig,
} from './framework/db-pointer.js';
export type { DatabasePointer, PointConfigResult } from './framework/db-pointer.js';
export { deriveCanonicalContexts } from './framework/canonical-context.js';
// The whole schema an opened workspace has — the canonical layout plus the
// framework's own tables — in one call. Anything that opens a workspace by
// constructing a Lattice directly (rather than through `openWorkspace`) needs
// this to see the SAME workspace the library and the browser see; a smaller
// schema does not merely render less, it reconciles the difference away.
export { applyWorkspaceSchema } from './framework/workspace-schema.js';
export { importLegacyUserConfig } from './framework/migrate-to-root.js';
export type { MigrateResult } from './framework/migrate-to-root.js';

// v2.0 — a row can index data that lives elsewhere (local / cloud references).
export { resolveSource } from './sources/resolver.js';
export { assertSafeUrl, providerForUrl, isPrivateIp } from './sources/url-safety.js';

// Full-text search — indexed (opt-in FTS5/tsvector via `TableDefinition.fts`)
// with a LIKE fallback for unconfigured tables. Read-only at search time;
// complements the embeddings-based semantic `Lattice.search`.
export {
  fullTextSearch,
  ensureFtsIndex,
  hasFtsIndex,
  ftsTableName,
  autoFtsColumns,
} from './search/fts.js';
export type { FtsResult, FtsGroup, FtsHit, FtsOptions } from './search/fts.js';

// v4.1 — hybrid (vector + full-text) search via Reciprocal Rank Fusion, with
// deterministic ranking signals and an optional bring-your-own reranker.
export { hybridSearch } from './search/hybrid.js';
export type {
  HybridSearchOptions,
  HybridSearchResult,
  HybridScoreBreakdown,
} from './search/hybrid.js';
export { rankingBoost, recencyBoost, rewardBoost, backlinkBoost } from './search/ranking.js';
export type {
  RankingOptions,
  RecencySignal,
  RewardSignal,
  BacklinkSignal,
  CustomSignal,
} from './search/ranking.js';
export { applyReranker } from './search/rerank.js';
export type { RerankerFn, RerankCandidate, RerankScore } from './search/rerank.js';

// v4.1 — graph-augmented retrieval: typed-edge graph, bounded BFS, adjacency boost.
export {
  ensureEdgesTable,
  addEdge,
  addEdges,
  removeEdge,
  neighbors,
  traverse,
  extractEdgesFromColumn,
  graphAdjacencyBoost,
  MAX_TRAVERSAL_DEPTH,
  DEFAULT_MAX_NODES,
} from './search/graph.js';
export type {
  GraphNode,
  GraphEdge,
  TraversalDirection,
  TraversalOptions,
  TraversalNode,
  GraphTraversalResult,
  ExtractEdgesSpec,
  GraphBoostOptions,
  GraphBoostResult,
} from './search/graph.js';

// v4.1 — text chunking for higher-precision, lower-token embedding.
export { semanticChunker, chunkText } from './search/chunking.js';
export type { TextChunk, ChunkerFn, SemanticChunkerOptions } from './search/chunking.js';

// An embedding function built from an endpoint address instead of code — what a
// config file declares, and usable directly for any endpoint-backed model.
export { createHttpEmbedder } from './search/http-embedder.js';
export type { HttpEmbedderOptions } from './search/http-embedder.js';

// v4.1 — chunk-aware embedding store + incremental refresh + dim-mismatch guard.
export {
  ensureEmbeddingsTable,
  storeEmbedding,
  removeEmbedding,
  searchByEmbedding,
  refreshEmbeddings,
  concatRowText,
  cosineSimilarity,
  EmbeddingDimensionMismatchError,
  EmbeddingScanTooLargeError,
  EMBEDDINGS_TABLE,
} from './search/embeddings.js';
export type { RefreshEmbeddingsOptions, EmbeddingRefreshResult } from './search/embeddings.js';

// v4.1 — native indexed vector search (pgvector / sqlite-vec), opt-in accelerator
// over the portable JSON store.
export {
  buildVectorIndex,
  dropVectorIndex,
  hasVectorIndex,
  vectorIndexAvailable,
  vectorIndexName,
  searchVectorIndex,
} from './search/vector-index.js';
export type { VectorHit } from './search/vector-index.js';

// v4.1 — retrieval evaluation: standard IR metrics over any ranked retriever,
// plus a CI-friendly regression detector.
export { evaluateRetrieval, detectRetrievalRegressions } from './search/eval.js';
export type {
  EvalQuery,
  RelevanceLabel,
  Retriever,
  RetrievalEvalOptions,
  PerQueryEval,
  RetrievalEvalSummary,
  EvalRegression,
} from './search/eval.js';

// v4.1 — retrieval health diagnostics (read-only `doctor`).
export { diagnoseRetrieval, formatHealthReport } from './search/doctor.js';
export type {
  RetrievalHealthReport,
  RetrievalHealthIssue,
  RetrievalHealthSpec,
  TableHealth,
  ExtensionAvailability,
  HealthSeverity,
  HealthIssueKind,
  DiagnoseOptions,
} from './search/doctor.js';

// v4.1 — reproducible retrieval benchmark harness + SLO gate.
export { benchmarkRetrieval, latencyStats, percentile, checkSlos } from './search/benchmark.js';
export type {
  BenchmarkReport,
  BenchmarkOptions,
  BenchmarkScale,
  LatencyStats,
  RetrievalSlo,
  SloViolation,
} from './search/benchmark.js';
export { ReferenceUnavailableError } from './sources/types.js';
export type {
  RefKind,
  RefProvider,
  FilesRow,
  SourceHandle,
  SourceMetadata,
  ResolveOptions,
} from './sources/types.js';
export { referenceLocalFile, referenceUrl } from './framework/reference-store.js';
export type { ReferenceMetadata } from './framework/reference-store.js';

// v1.13 additions — local-to-cloud migration + cloud-connect probe.
export {
  migrateLatticeData,
  archiveLocalSqlite,
  openTargetLatticeForMigration,
} from './framework/cloud-migration.js';
export type {
  MigrationProgress,
  MigrationResult,
  MigrationOptions,
} from './framework/cloud-migration.js';
export {
  probeCloud,
  cloudRlsInstalled,
  canManageRoles,
  // The second half of redeeming an invite: connect as the new member role and
  // atomically mark the invite used. Without it on this surface, a caller could
  // read a token but never spend it, so joining had no library path at all.
  claimMemberInvite,
} from './framework/cloud-connect.js';
export type { CloudProbeResult } from './framework/cloud-connect.js';

export { isPostgresUrl, buildPostgresUrl, parsePostgresUrl } from './cloud/url.js';

// Managing a shared cloud without a browser: who is on it, adding and removing
// people, joining one, and sharing a row with them. Every one of these used to
// exist only inside a request handler, which made a headless machine reach for
// binding the browser app to a network address — a surface its own help text
// calls unauthenticated. Authorization is unchanged and still the database's:
// the owner checks read the connected Postgres role, and the mutating steps are
// definer functions that raise for a member on their own.
export { createCloudWorkspace } from './framework/cloud-workspace.js';
export type { CloudWorkspaceHandlers } from './framework/cloud-workspace.js';
// Where do I stand on this cloud, and is anything unprotected? The question every
// other cloud operation depends on the answer to — and the one the browser app
// could not answer for you, because the browser app is what stops working when
// the answer is bad. Strictly read-only, so a damaged cloud can be inspected
// without also being changed.
export { cloudStatus } from './cloud/status.js';
export type { CloudStatus, CloudStanding, CloudStatusWarning } from './cloud/status.js';
// Moving a local workspace onto a shared database, whole. `migrateLatticeData`
// above copies the rows; this is the MOVE — copy, secure, publish the layout,
// then repoint the config, update the registry, and retire the local file as one
// reversible sequence. That last mile existed only inside a request handler and
// had no unwind, which made a half-failed migration a data-integrity event;
// `cutOverWorkspaceToCloud` is that mile on its own, for a caller that copied the
// data some other way.
export { migrateWorkspaceToCloud, cutOverWorkspaceToCloud } from './cloud/migrate.js';
export type {
  MigrateWorkspaceInput,
  MigrateWorkspaceResult,
  CloudCutoverInput,
  CloudCutoverResult,
} from './cloud/migrate.js';
export { joinCloud, redeemCloudInvite } from './cloud/join.js';
export type {
  CloudJoinFields,
  CloudJoinOptions,
  CloudJoinResult,
  CloudWorkspaceCreator,
  RedeemInviteInput,
} from './cloud/join.js';
export { inviteMember, removeMember, cloudCoordsForConfig } from './cloud/membership.js';
export type {
  CloudCoords,
  InviteMemberOptions,
  InviteMemberResult,
  RemoveMemberOptions,
  RemoveMemberResult,
} from './cloud/membership.js';
export {
  listCloudMembers,
  latestInvitesByRole,
  recordMemberInvite,
  markInvitesRevoked,
  reclaimStaleInviteRoles,
  currentDatabaseRole,
} from './cloud/member-directory.js';
export type {
  CloudMember,
  InviteRecord,
  ListCloudMembersOptions,
} from './cloud/member-directory.js';
export { shareRow, grantRowAccess, batchRowAccess } from './cloud/sharing.js';
export type {
  ShareRowInput,
  ShareRowResult,
  GrantRowInput,
  GrantRowResult,
  BatchRowAccessInput,
  BatchRowAccessResult,
} from './cloud/sharing.js';
export { cloudError, cloudErrorCode } from './cloud/errors.js';
export type { CloudError, CloudErrorCode } from './cloud/errors.js';
export { mintInviteToken, redeemInviteToken, poolerAwareUser } from './cloud/invite.js';
export type { InvitePayload, InviteCoords, MintInput } from './cloud/invite.js';
// The owner-published layout a joined member hydrates its own config from. An
// owner running headlessly has to publish it after a migrate or a schema change,
// or every member renders an empty context tree against rows they can read.
export { publishSharedSchema } from './cloud/shared-schema.js';

// v3.0 — shared-cloud Row-Level Security. A cloud is a Postgres DB each user
// connects to directly as their own scoped role; these install RLS + provision
// members + share rows with plain SQL. No-ops / throws on SQLite (local only).
export {
  installCloudRls,
  enableRlsForTable,
  enableChangelogRls,
  memberGroupFor,
  LEGACY_MEMBER_GROUP,
} from './cloud/rls.js';
export {
  provisionMemberRole,
  revokeMemberRole,
  grantMemberAccess,
  generateMemberPassword,
  memberRoleName,
  // Refuses a role that is superuser / CREATEROLE / BYPASSRLS / the owner
  // itself. Run it before handing a provisioned role's credentials to anyone.
  assertScopedMemberRole,
  setRowVisibility,
  // Per-row sharing at the database level: each one calls a definer function
  // that raises for a caller who does not own the row, so exporting them moves
  // no authority — it only removes the requirement to be a browser.
  grantRow,
  revokeRow,
  batchRowGrants,
} from './cloud/members.js';
export { discoverCloudTables } from './cloud/discover.js';
export type { DiscoveredTable } from './cloud/discover.js';
export {
  audiencePredicate,
  audienceViewSql,
  enableAudienceView,
  tableNeedsAudienceView,
  isRowAudience,
  // WS2/WS3 — per-column audience spec stored canonically in Postgres
  loadColumnPolicy,
  seedColumnPolicyFromYaml,
  regenerateAudienceViewFromDb,
  regenerateMemberReadView,
  setColumnAudience,
} from './cloud/audience.js';
export type { AudienceRowCtx } from './cloud/audience.js';
export {
  getTablePolicy,
  setTableDefaultVisibility,
  setTableNeverShare,
} from './cloud/table-policy.js';
export type { TablePolicy, RowVisibilityDefault } from './cloud/table-policy.js';
export { foldEntity, observationVisible, observationsFromChange } from './cloud/fold.js';
export type { Observation, Viewer } from './cloud/fold.js';
export {
  InMemorySourceKeyStore,
  SourceShreddedError,
  sealUnderSource,
  openUnderSource,
  shredSource,
} from './cloud/shred.js';
export type { SourceKeyStore } from './cloud/shred.js';
export { FoldCache } from './cloud/fold-cache.js';
export {
  secureCloud,
  // Securing a cloud is not one-shot: `reconcileCloudMemberAccess` re-converges
  // the member grants a workspace's tables need, and `secureNewCloudTable` does
  // the same for a single table created after the fact. A table made outside the
  // browser and never passed through these has row security OFF.
  reconcileCloudMemberAccess,
  secureNewCloudTable,
} from './cloud/setup.js';
export type { CloudMemberAccessReport } from './cloud/setup.js';
// v4.1 — seamless cloud file-byte access: in-database SigV4 presigner so a keyless
// member fetches/uploads bytes with zero config (Postgres cloud only).
export {
  installFilePresigner,
  setCloudS3Secret,
  grantPresignerToMemberGroup,
  hasFilePresigner,
  filePresignSql,
  S3_SECRET_TABLE,
} from './cloud/file-presign.js';
export type { CloudS3Secret } from './cloud/file-presign.js';
export {
  installCloudSettings,
  getCloudSetting,
  setCloudSetting,
  CLOUD_SETTING_SYSTEM_PROMPT,
  CLOUD_SETTING_WORKSPACE_LOGO,
  CLOUD_SETTING_WORKSPACE_LOGO_ETAG,
} from './cloud/settings.js';
// Where a shared workspace keeps its file bytes. One call, because the owner
// gate, the merge that stops a partial update erasing the stored secret, and
// installing the in-database presigner are one operation: skip the last and every
// member without credentials of their own can open nothing, with no sign of why.
// The settings stay machine-local and encrypted; the reader never returns the
// secret, only whether one is held.
export { readCloudFileStorage, configureCloudFileStorage } from './ops/cloud-storage.js';
export type {
  CloudFileStorage,
  CloudFileStorageInput,
  CloudFileStorageResult,
} from './ops/cloud-storage.js';
// v3.1 — progress-bearing render API (background render + live per-table %)
export { ProgressThrottle } from './render/progress.js';
export type {
  RenderProgress,
  RenderProgressKind,
  RenderProgressCallback,
  RenderOptions,
} from './render/progress.js';

// v2.0 — AI library surface: the context organizer (summarize + classify a
// source into the user's own schema, creating new objects only when nothing
// fits), plus image vision and SSRF-guarded URL crawl. Inert without an LLM
// client; sharp / file-type are optional + lazily loaded.
export {
  organizeSource,
  summarizeText,
  classifyLinks,
  parseMatches,
  extractObjects,
  parseObjects,
  crawlUrl,
  enrichKnowledge,
  describeImage,
  describePdf,
} from './ai/index.js';
export type {
  VisionOptions,
  VisionSenderInput,
  PdfOptions,
  PdfSenderInput,
  SchemaEntity,
  ExtractedObject,
  EnrichOptions,
  EnrichResult,
  CrawlResult,
  CrawlOptions,
  OrganizeOptions,
  OrganizeResult,
  OrganizedLink,
  OrganizedCreation,
  CatalogEntity,
  CatalogRecord,
  ClassifyMatch,
  LlmClient,
  TurnParams,
  TurnResult,
  LlmMessage,
} from './ai/index.js';

// Embed the GUI server from a library consumer (no CLI shell-out needed).
export { startGuiServer } from './gui/server.js';
export type { StartGuiServerOptions, GuiServerHandle } from './gui/server.js';

// ── The mutating surface, without a browser ────────────────────────────────
//
// Everything below is the capability layer the browser client drives: row
// writes, undo/redo, schema edits, computed tables, and the data-model planner.
// The HTTP routes are ONE caller of these functions, never their owner — none
// of the modules re-exported here loads Node's HTTP server, so a program can
// automate a workspace end to end without a server listening anywhere. Exported
// so that anything the app can do is also doable from a script.

// A live workspace handle: the DB, its activity feed, the registered/computed
// table sets, and the render state. `openConfig` builds a fully-wired one from a
// config on disk (the same call the GUI makes); `disposeActive` tears it down.
export { openConfig, disposeActive } from './gui/lifecycle.js';
export type { ActiveDb, RenderStatusSnapshot } from './gui/active-db.js';

// Reversing a recorded SCHEMA change — a table, a column, a link, a rename.
//
// Separate from `revertEntry` below, and it has to be: reversing a schema entry
// rewrites the workspace file and can hand back a DIFFERENT live workspace,
// which a function returning "what happened to the rows" has no way to give you.
// So `revertEntry` refuses a schema entry unless its context carries a handler,
// and this IS that handler. Without it exported, every row change was reversible
// from a script and every schema change was reversible only from the browser —
// which is not "history works headlessly", it is half of it.
export { applySchemaConfig } from './gui/lifecycle.js';

// The in-process activity feed every audited mutation publishes to. A caller
// constructs one for its `MutationCtx`; subscribe to watch changes land.
export { FeedBus } from './gui/feed.js';
export type { FeedEvent, FeedEventInput, FeedHandler, FeedOp, FeedSource } from './gui/feed.js';

// Row CRUD + linking + the undo/redo stack. Every one of these appends the same
// audit entry and publishes the same feed event as a click in the browser, so
// scripted changes are reversible from the version history exactly like manual
// ones. `undoGroup` reverses every write sharing one `opGroup` as a single
// all-or-nothing action.
export {
  createRow,
  updateRow,
  deleteRow,
  linkRows,
  unlinkRows,
  undoLast,
  redoLast,
  revertEntry,
  undoGroup,
  parseAudit,
  GROUP_UNDO_MAX_ENTRIES,
  UNLINK_UNDO_MAX_EDGES,
} from './gui/mutations.js';
export type {
  MutationCtx,
  AuditOp,
  AuditEntry,
  RevertResult,
  GroupUndoResult,
  GroupUndoConflict,
} from './gui/mutations.js';

// Show what a write WOULD change before making it: resolve a bulk filter to the
// rows it selects (bounded), diff the proposed values against what is stored,
// and mask the fields the caller is not allowed to see.
export {
  previewRowChanges,
  bulkSelection,
  parseBulkFilters,
  rowFieldDeltas,
  maskPreviewFields,
  PREVIEW_DEFAULT_LIMIT,
} from './gui/change-preview.js';
export type {
  ChangePreview,
  ChangePreviewOptions,
  RowChangePreview,
  FieldDelta,
  BulkSelection,
  MaskedFieldDelta,
  MaskedRowPreview,
  PreviewField,
} from './gui/change-preview.js';

// Schema editing: create / rename / delete / purge a table, add / rename / drop
// a column, and create or remove the link tables that express relationships.
// Each goes through the audited primitives, so a schema change is as reversible
// as a row edit; the rename helpers carry column policy and cloud access rules
// across with the name.
export {
  createUserEntity,
  renameUserEntity,
  softDeleteUserEntity,
  aiDeleteEntity,
  purgeUserEntity,
  addUserColumn,
  renameUserColumn,
  dropColumnCarryingPolicy,
  renameTablesCarryingPolicy,
  renameColumnsCarryingPolicy,
  createUserRelation,
  createUserJunction,
  createFileJunction,
  materializeJunction,
  addUserLink,
  removeUserLink,
  setColumnMeta,
  inboundLinksTo,
  describeInboundLinks,
  removeInboundLinks,
  setTableRole,
  readTableRoles,
  ensureRoleColumns,
  setTableDefinition,
  applyShapeOp,
  normalizedEntityName,
  physicalTableExists,
  physicalColumnExists,
  RenameRefused,
  AI_DELETE_ROW_CAP,
} from './gui/schema-ops.js';
export type {
  UserJunction,
  AddLinkOutcome,
  RemoveLinkOutcome,
  ColumnMetaPatch,
  ColumnMetaOutcome,
  DeleteResolution,
  DeleteEntityOutcome,
  InboundLink,
  StoredTableRole,
  LinkTableRename,
  RenameCascade,
  RenameOutcome,
  TableNamePolicyMove,
  ColumnRenames,
} from './gui/schema-ops.js';

// What a table or a column MEANS, and how it is presented: the icon on a table,
// and the one-line definition shown to people and to the assistant. Presentation
// data, but a real write — a workspace stood up by a script or an embedder gets
// nothing described unless it can write these — and the resolvers are here too
// so a caller reads a definition the same way the interface does (an authored
// value wins, else the built-in default, else none).
export {
  upsertTableMeta,
  upsertColumnMeta,
  resolveTableDescription,
  resolveColumnDescription,
} from './gui/column-descriptions.js';

// The clarification queue. When an automated step is confident enough not to drop
// a guess but not confident enough to act on it, it asks instead — and a queue
// only a browser could drain would let one unanswered question stop everything
// behind it in a process nobody is watching. Answering runs the action the
// question was holding and keeps what the reply says, through the same audited
// paths any other write uses.
export {
  enqueueQuestion,
  listPendingQuestions,
  getQuestion,
  answerQuestion,
  dismissQuestion,
  parseQuestionContext,
  ensureQuestionsTable,
  QUESTIONS_TABLE,
} from './gui/questions.js';
export type {
  QuestionRow,
  QuestionsCtx,
  QuestionSource,
  QuestionContext,
  QuestionSubject,
  DeferredAction,
  EnrichTarget,
  EnqueueQuestionInput,
  AnswerOutcome,
} from './gui/questions.js';

// The analytical read surface, with its guardrails attached: one SELECT, no
// credential / conversation / bookkeeping tables, a read-only transaction where
// the dialect has one, and a server-side row cap. Exported as the guarded runner
// rather than as a query helper, so reaching it from a script is the same narrow
// surface the dashboards get and not a wider one that is merely easier to call.
export {
  runDashboardSql,
  validateDashboardSql,
  isSqlProtectedTable,
  DASHBOARD_SQL_CAP,
} from './gui/dashboard-sql.js';
export type { DashboardSqlResult } from './gui/dashboard-sql.js';

// Computed tables — live, read-only SQL projections. Create / update / delete
// one, preview its output before committing, refresh its model-filled fields,
// and list what is registered.
export {
  createComputedTable,
  updateComputedTable,
  deleteComputedTable,
  previewComputedTable,
  refreshComputedTable,
  listComputedTables,
  reachableFields,
  assertNotComputedSource,
  applyComputedSchemaOp,
  isComputedSchemaOp,
} from './gui/computed-ops.js';
export type {
  ComputedPreview,
  ComputedRefreshProgress,
  ComputedTableInfo,
  ReachableField,
} from './gui/computed-ops.js';

// Data-model planner: run a plan for a workspace (applying the reversible
// automatic fixes and returning the rest as proposals), apply a proposal, or
// dismiss one durably so it is never re-surfaced. Deterministic — no model
// provider is involved.
export { applyPlanOp, runAutoTier } from './gui/planner/apply.js';
export type { ApplyDeps } from './gui/planner/apply.js';
export {
  ensurePlan,
  previewPlan,
  applyDepsFor,
  invalidatePlanCache,
  MAX_PLANNER_TABLES,
} from './gui/planner/run.js';
export type {
  EnsurePlanOptions,
  PlannerWorkspace,
  PlanPreview,
  PlanPreviewItem,
} from './gui/planner/run.js';
export { recordDismissal, loadDismissed, PLAN_STATE_TABLE } from './gui/planner/plan-state.js';
export {
  applyRenameTable,
  applyExtractDimension,
  applyRetypeColumn,
} from './gui/planner/appliers.js';
export type { ApplyOutcome } from './gui/planner/appliers.js';
export type {
  DataModelPlan,
  PlanOp,
  PlanOpOf,
  PlanOpKind,
  ShapeOp,
  ShapeOpKind,
  AnyPlanOp,
  AnyPlanOpKind,
  AppliedOp,
  PlanClass,
  PlanTier,
  ModelProfile,
  TableProfile,
  TableTier,
  ColumnStat,
  NormalizedRelation,
} from './gui/planner/types.js';

// Durable file-backed SourceKeyStore for production crypto-shred deployments.
// The default InMemorySourceKeyStore is process-local — restart implicitly
// shreds every key. This implementation persists keys to a single JSON file
// (optionally AES-256-GCM encrypted at rest) so keys survive restarts but
// remain shred-durable on explicit destroy.
export { FileSourceKeyStore } from './cloud/file-source-key-store.js';
export type { FileSourceKeyStoreOptions } from './cloud/file-source-key-store.js';

// Structured-source importer: infer a proposed schema from a JSON/Excel source,
// then materialize it into a workspace (tables + rows + junctions), with as-of
// snapshots, per-row date columns, and match-to-existing re-import recognition.
export { inferSchema, inferFieldType, normalizeName, sourceRecords } from './import/infer.js';
export { materializeImport } from './import/materialize.js';
export { detectAsOf, detectAsOfCandidates, parseCellDate } from './import/asof.js';
export type { AsOfCandidate, AsOfInputs } from './import/asof.js';
export { detectAsOfColumns } from './import/asof-columns.js';
export type { AsOfColumnCandidate } from './import/asof-columns.js';
export { matchSchemaToExisting, renameEntities } from './import/match.js';
export type { SchemaMatch, EntityMatch, ExistingTable } from './import/match.js';
export { excelToRecords } from './import/excel.js';
export { dedupeAndDetectViews } from './import/dedupe-views.js';
export type {
  MaterializeCtx,
  MaterializeResult,
  MaterializeOptions,
  ImportMode,
  ImportProgress,
} from './import/materialize.js';
export type {
  ProposedSchema,
  InferredEntity,
  InferredColumn,
  InferredDimension,
  InferredLinkage,
  InferredType,
  DetectedView,
} from './import/types.js';

// The assistant, headless. `runAssistantTurn` runs ONE turn to completion against
// an open workspace — its tools, its writes, and its answer — with no browser and
// no server; `streamAssistantTurn` is the same turn with its events as they happen.
// Every write it makes goes through the audited mutation chokepoint under one
// operation-group id per tool call, so `undoGroup` reverses it as a single action.
export {
  runAssistantTurn,
  streamAssistantTurn,
  buildTurnDispatch,
  assistantTurnError,
  assistantTurnErrorCode,
  NO_MODEL_CONNECTED_MESSAGE,
} from './ops/assistant-turn.js';
export type {
  AssistantTurnWorkspace,
  AssistantTurnInput,
  AssistantTurnResult,
  AssistantTurnToolCall,
  AssistantTurnError,
  AssistantTurnErrorCode,
} from './ops/assistant-turn.js';

// Which model answers, headless. Pointing a machine at a model used to be a
// browser-only step — the FIRST step, and the one a server with no display could
// not take. These are the machine-local writes behind it: connect or forget an
// OpenAI-compatible endpoint, activate or drop the hosted account model, choose
// which configured backend is active, save or clear a speech key, disconnect a
// subscription, and check that the active backend actually answers. A refusal
// arrives as an Error carrying a `code` (see `modelErrorCode`) rather than a
// status, because the same call serves a request, a command, and a library.
export {
  readModelStatus,
  connectModelEndpoint,
  disconnectModelEndpoint,
  connectAccountModel,
  disconnectAccountModel,
  selectModelProvider,
  testModelProvider,
  setAssistantApiKey,
  clearAssistantApiKey,
  disconnectClaudeSubscription,
} from './ops/ai-config.js';
export type { ModelStatus, ModelEndpointInput, ModelEndpointResult } from './ops/ai-config.js';
// Connecting a Claude subscription, headless. Only ONE leg of it needs a person
// and a browser — approving the consent screen on the provider's own page, which
// they can open on any machine at all. Everything on either side is here: start a
// connection and get the URL to approve, then finish it with the one-time code
// that approval produced. The attempt's verifier is kept in the machine-local
// encrypted store rather than a browser session, so the two legs need not run in
// the same process.
export {
  startSubscriptionSignIn,
  completeSubscriptionSignIn,
  pendingSubscriptionSignIn,
  readPendingSubscription,
  clearPendingSubscription,
  PENDING_SUBSCRIPTION_TTL_MS,
} from './ops/subscription.js';
export type {
  StartedSubscriptionSignIn,
  StartSubscriptionSignInInput,
  PendingSubscription,
  PendingSubscriptionSignIn,
} from './ops/subscription.js';
export {
  modelError,
  modelErrorCode,
  MANAGED_MODEL_REFUSAL,
  MANAGED_CREDENTIAL_REFUSAL,
} from './ops/model-errors.js';
export type { ModelError, ModelErrorCode } from './ops/model-errors.js';
// The account, headless. Signing in looks like the one step that could never
// leave a browser — and only ONE leg of it needs one: approving the request on
// the account service's own page, which a person can open on any machine at all.
// Everything on either side of that leg is here: start a sign-in and get the URL
// to approve, finish it with the one-time code that approval produced, sign out
// (revoking this device's spendable model credential at the service, not just
// forgetting it locally), pull down the workspaces this account was invited to,
// and administer a hosted workspace through its manager. A refusal arrives as an
// Error carrying a `code` (see `accountErrorCode`) rather than a status, because
// the same call serves a request, a command, and a library.
export {
  readAccountStatus,
  pendingAccountSignIn,
  startAccountSignIn,
  completeAccountSignIn,
  signOutAccount,
  syncAccountMemberships,
  listManagedMembers,
  inviteToManagedWorkspace,
  revokeManagedMembership,
  createManagedWorkspace,
} from './ops/account.js';
export type {
  AccountStatus,
  PendingAccountSignIn,
  StartedAccountSignIn,
  StartAccountSignInInput,
  CompletedAccountSignIn,
  SyncAccountMembershipsInput,
  ManagedMember,
  ManagedMembers,
  ManagedResult,
  ModelAccessRevocation,
  MembershipSyncResult,
} from './ops/account.js';
export { accountError, accountErrorCode, NO_WORKSPACE_MANAGER } from './ops/account-errors.js';
export type { AccountError, AccountErrorCode } from './ops/account-errors.js';
// A recording becomes text from BYTES, so a folder of voice memos or a job with a
// call recording reaches the same speech credential the app uses.
export { transcribeRecording, filenameForMimeType } from './ops/voice.js';
export type { RecordingInput } from './ops/voice.js';
// Attaching an external source. Syncing one, refreshing it, and tearing it down
// were library calls already; CONNECTING one was not, so a machine could keep a
// database up to date forever and could not add one. These close that: attach an
// external database, edit its stored credentials, run the whole refresh pass, and
// finish an MCP authorization. The ONE leg that still needs a person — approving
// an MCP server's consent page — is not pretended away: `connectSource` hands
// back the URL to approve and stops, and `completeMcpConnection` takes it from
// there. A refusal arrives as an Error carrying a `code` (see
// `connectorErrorCode`) rather than a status, because the same call serves a
// request, a command, and a library.
export {
  connectSource,
  completeMcpConnection,
  mcpConnectionLabel,
  namedMcpServer,
  migrateLegacyMcpConnection,
  refreshStaleSources,
  connectDatabaseSource,
  reconnectDatabaseSource,
} from './ops/connect-source.js';
export type {
  SourceConnectRequest,
  SourceConnectResult,
  SourceConnected,
  SourceAuthorizationRequired,
  CompleteMcpConnectionInput,
  StaleRefreshResult,
  StaleRefreshFailure,
  DatabaseSourceInput,
  DatabaseSourceReconnectInput,
  DatabaseSourceConnected,
} from './ops/connect-source.js';
export { connectorError, connectorErrorCode } from './ops/connector-errors.js';
export type { ConnectorError, ConnectorErrorCode } from './ops/connector-errors.js';

// Bringing documents in, headless. Dropping a file into the app was the only
// door, which made the most scriptable thing this product does unscriptable: a
// folder of contracts, a nightly export, a pipeline handed a file by something
// else. These are the same pipeline that door runs — read it, extract it,
// describe it, import the data inside it, recognise a document already held, and
// link it to the records it is about — reachable from a path, from bytes the
// caller already holds, or from text (which may be a web address to read).
// Registering a folder as a standing source of the workspace, walking it, and
// forgetting it are here too: the one step that genuinely needs a person is
// CHOOSING the path, and a caller that already knows the path is not asking.
// A refusal arrives as an Error carrying a `code` (see `ingestErrorCode`) rather
// than a status, because the same call serves a request, a command, and a library.
export {
  ingestPath,
  ingestBytes,
  ingestText,
  ingestLocalFile,
  ingestMutationCtx,
  shouldRetainUploadBlob,
  mimeFor,
} from './ops/ingest-file.js';
export type {
  IngestContext,
  PathIngestResult,
  LocalFileIngestResult,
  UploadIngestInput,
  UploadIngestResult,
} from './ops/ingest-file.js';
export { ingestTextAsFile, looksLikeUrl } from './ops/ingest-text.js';
export type { TextIngestDeps } from './ops/ingest-text.js';
export {
  addSourceRoot,
  removeSourceRoot,
  ingestSourceFolder,
  listSourceRoots,
  listSourceFolder,
  resolveInsideRoots,
  ingestFolder,
  shouldPublishIngestProgress,
} from './ops/source-roots.js';
export type {
  SourceRoot,
  SourceRootDeps,
  AddSourceRootResult,
  IngestFolderResult,
  DirEntry,
} from './ops/source-roots.js';
export { ingestError, ingestErrorCode } from './ops/ingest-errors.js';
export type { IngestError, IngestErrorCode } from './ops/ingest-errors.js';

// Applying a structured import, headless. Reading a spreadsheet / CSV / JSON
// export / document-with-tables into records, and turning those records into
// tables, rows, and relationships — including the no-overwrite guarantee that
// files a dateless import under today's date, so re-running it next month
// appends a snapshot instead of clobbering the last one.
export { readImportSource, applyImport, existingDataTables } from './ops/import-apply.js';
export { countMarginalLinks, publishMarginalLinksNote } from './ops/import-apply.js';
export type {
  ImportSource,
  ImportApplyDeps,
  ImportApplyOptions,
  ImportApplyEvent,
  ComputedSelection,
} from './ops/import-apply.js';
