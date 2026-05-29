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
} from './framework/user-config.js';
export type { UserIdentity } from './framework/user-config.js';
export { TeamsClient, TeamsHttpError } from './teams/client.js';
export type {
  TeamSummary,
  RegisterResponse,
  RedeemResponse,
  MemberSummary,
  InviteResponse,
  TeamConnection,
} from './teams/client.js';

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
export { probeCloud } from './framework/cloud-connect.js';
export type { CloudProbeResult } from './framework/cloud-connect.js';

export { registerDirectViaPostgres, isPostgresUrl } from './teams/register-direct.js';
export type { DirectRegisterResult } from './teams/register-direct.js';
