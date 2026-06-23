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
  FtsConfig,
  SearchOptions,
  SearchResult,
  QueryOptions,
  CountOptions,
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
export { deriveCanonicalContexts } from './framework/canonical-context.js';
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
export { probeCloud, cloudRlsInstalled, canManageRoles } from './framework/cloud-connect.js';
export type { CloudProbeResult } from './framework/cloud-connect.js';

export { isPostgresUrl } from './cloud/url.js';

// v3.0 — shared-cloud Row-Level Security. A cloud is a Postgres DB each user
// connects to directly as their own scoped role; these install RLS + provision
// members + share rows with plain SQL. No-ops / throws on SQLite (local only).
export {
  installCloudRls,
  enableRlsForTable,
  enableChangelogRls,
  backfillOwnership,
  memberGroupFor,
  LEGACY_MEMBER_GROUP,
} from './cloud/rls.js';
export {
  provisionMemberRole,
  revokeMemberRole,
  generateMemberPassword,
  memberRoleName,
  setRowVisibility,
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
export { secureCloud } from './cloud/setup.js';
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
