export { Lattice } from './lattice.js';
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
  ReportSection,
  ReportConfig,
  ReportSectionResult,
  ReportResult,
  CleanupOptions,
  CleanupResult,
  ReconcileOptions,
  ReconcileResult,
} from './types.js';
export { readManifest, writeManifest, manifestPath } from './lifecycle/manifest.js';
export type { LatticeManifest, EntityContextManifestEntry } from './lifecycle/manifest.js';
// v0.6 additions — markdown render utilities
export { frontmatter, markdownTable, slugify, truncate } from './render/markdown.js';
export type { MarkdownTableColumn } from './render/markdown.js';
export { createSQLiteStateStore, InMemoryStateStore } from './writeback/state-store.js';
export type { WritebackStateStore } from './writeback/state-store.js';
export { parseSessionWrites, generateWriteEntryId } from './session/index.js';
export type { SessionWriteEntry, SessionWriteOp, SessionWriteParseResult } from './session/index.js';
export { parseSessionMD, parseMarkdownEntries, generateEntryId, validateEntryId, DEFAULT_ENTRY_TYPES, DEFAULT_TYPE_ALIASES, applyWriteEntry, READ_ONLY_HEADER, createReadOnlyHeader } from './session/index.js';
export type { SessionEntry, ParseResult, ParseError, SessionParseOptions, ApplyWriteResult, ReadOnlyHeaderOptions } from './session/index.js';
