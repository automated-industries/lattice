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
  SelfSource,
  HasManySource,
  ManyToManySource,
  BelongsToSource,
  CustomSource,
  EntityFileSource,
  EntityFileSpec,
  EntityContextDefinition,
  CleanupOptions,
  CleanupResult,
  ReconcileOptions,
  ReconcileResult,
} from './types.js';
export { readManifest, writeManifest, manifestPath } from './lifecycle/manifest.js';
export type { LatticeManifest, EntityContextManifestEntry } from './lifecycle/manifest.js';
export { parseSessionWrites, generateWriteEntryId } from './session/index.js';
export type { SessionWriteEntry, SessionWriteOp, SessionWriteParseResult } from './session/index.js';
