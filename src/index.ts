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
export { contentHash } from './render/writer.js';
export { estimateTokens, applyTokenBudget } from './render/token-budget.js';
export {
  readManifest,
  writeManifest,
  manifestPath,
  entityFileNames,
  normalizeEntityFiles,
  isV1EntityFiles,
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
export { PostgresAdapter } from './db/postgres.js';
export type { PostgresAdapterOptions } from './db/postgres.js';

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
  MEMBER_GROUP,
} from './cloud/rls.js';
export {
  provisionMemberRole,
  revokeMemberRole,
  generateMemberPassword,
  memberRoleName,
  setRowVisibility,
  grantCell,
  revokeCell,
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
