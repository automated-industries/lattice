import { v4 as uuidv4 } from 'uuid';
import type {
  Row,
  LatticeOptions,
  TableDefinition,
  MultiTableDefinition,
  WritebackDefinition,
  QueryOptions,
  CountOptions,
  BoundedCountOptions,
  AggregateOptions,
  AggregateResult,
  QueryPageOptions,
  QueryPageResult,
  InitOptions,
  Migration,
  WatchOptions,
  RenderResult,
  SyncResult,
  StopFn,
  AuditEvent,
  LatticeEvent,
  RenderSpec,
  BuiltinTemplateName,
  WriteHook,
  WriteHookContext,
  SeedConfig,
  SeedResult,
  ReportConfig,
  ReportResult,
  EntityContextDefinition,
  ReconcileOptions,
  ReconcileResult,
  ReverseSeedResult,
  SearchOptions,
  SearchResult,
  ChangelogOptions,
  ChangeEntry,
  ChangeProvenance,
  BelongsToRelation,
} from './types.js';
import { foldEntity, observationsFromChange, type Observation } from './cloud/fold.js';
import {
  sealUnderSource,
  openUnderSource,
  SourceShreddedError,
  type SourceKeyStore,
} from './cloud/shred.js';
import { isEncrypted } from './security/encryption.js';
import { manifestPath, readManifest, writeManifest } from './lifecycle/manifest.js';
import { computeRenderCursor, cursorIsFresh } from './lifecycle/render-cursor.js';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { StorageAdapter } from './db/adapter.js';
import {
  runAsyncOrSync,
  getAsyncOrSync,
  introspectColumnsAsyncOrSync,
  introspectAllColumnsAsyncOrSync,
  addColumnAsyncOrSync,
} from './db/adapter.js';
import { SQLiteAdapter } from './db/sqlite.js';
import { DenoSqliteAdapter } from './db/sqlite-deno.js';
import { PostgresAdapter } from './db/postgres.js';
import {
  serializeRowPk as _serializeRowPkCodec,
  serializePkLookup as _serializePkLookupCodec,
} from './db/pk.js';
import { SchemaManager } from './schema/manager.js';
import type { CompiledTableDef, PageOptions } from './schema/manager.js';
import { assertSafeIdentifier } from './schema/identifier.js';
import { ChangelogService } from './changelog/service.js';
import { ChangelogWriter } from './changelog/writer.js';
import { ReportBuilder } from './report/builder.js';
import { QueryCore } from './query/core.js';
import { SeedEngine } from './crud/seed-engine.js';
import { Sanitizer } from './security/sanitize.js';
import { RenderEngine, NOOP_RENDER } from './render/engine.js';
import type { RenderOptions } from './render/progress.js';
import { AutoRenderScheduler } from './render/auto-render.js';
import { ReverseSyncEngine } from './reverse-sync/engine.js';
import { ReverseSeedEngine } from './reverse-seed/engine.js';
import { SyncLoop } from './sync/loop.js';
import { WritebackPipeline } from './writeback/pipeline.js';
import { compileRender } from './render/templates.js';
import { parseConfigFile } from './config/parser.js';
import { resolveLatticeRoot } from './framework/lattice-root.js';
import {
  getActiveWorkspace,
  getWorkspace,
  resolveWorkspacePaths,
  type WorkspaceRecord,
} from './framework/workspace.js';
import { deriveCanonicalContexts } from './framework/canonical-context.js';
import { EncryptionLayer } from './security/encryption-layer.js';
import {
  ensureEmbeddingsTable,
  storeEmbedding,
  removeEmbedding,
  searchByEmbedding,
  refreshEmbeddings,
  concatRowText,
} from './search/embeddings.js';
import type { RefreshEmbeddingsOptions, EmbeddingRefreshResult } from './search/embeddings.js';
import {
  buildVectorIndex,
  mirrorVectorIndexRow,
  removeVectorIndexRow,
} from './search/vector-index.js';
import { ensureFtsIndex, autoFtsColumns } from './search/fts.js';
import { hybridSearch } from './search/hybrid.js';
import type { HybridSearchOptions, HybridSearchResult } from './search/hybrid.js';
import { applyReranker } from './search/rerank.js';
import {
  provenanceColumns,
  resolveTrustDefault,
  TRUST_COLUMNS,
  ProvenanceImmutableError,
} from './schema/governance.js';
import type { TrustState } from './schema/governance.js';
import {
  connectedColumns,
  IMMUTABLE_CONNECTED_FIELDS,
  ConnectedSourceImmutableError,
} from './schema/connected.js';
import type { ConnectorSource } from './schema/connected.js';
import {
  addEdge,
  addEdges,
  removeEdge,
  neighbors,
  traverse,
  extractEdgesFromColumn,
  graphAdjacencyBoost,
} from './search/graph.js';
import type {
  GraphEdge,
  GraphNode,
  TraversalOptions,
  GraphTraversalResult,
  ExtractEdgesSpec,
  TraversalDirection,
} from './search/graph.js';
import {
  computedColumnOrder,
  computeColumns,
  computedColumnDdl,
  rollupColumnDdl,
  allComputedDeps,
} from './schema/computed.js';
import type { ComputedColumnSpec, MaterializedRollupSpec } from './schema/computed.js';
import { compileComputedFields } from './schema/computed-field.js';
import type { CompiledComputedField, AiFieldPlan } from './schema/computed-field.js';
import { fillAiComputedFields } from './schema/computed-field-fill.js';
import type { FieldFillReport } from './schema/computed-field-fill.js';
import type { FillLlm } from './schema/computed-fill.js';
import { registerComputedTables } from './schema/computed-table.js';
import type {
  CloudCompileOptions,
  ComputedRegistrationResult,
  ComputedSchemaTable,
  ComputedTableHost,
} from './schema/computed-table.js';
import { loadAllColumnPolicy, tableNeedsAudienceView } from './cloud/audience.js';
import type { ComputedTableDef } from './config/types.js';
import {
  installFilePresigner,
  setCloudS3Secret,
  grantPresignerToMemberGroup,
} from './cloud/file-presign.js';
import type { CloudS3Secret } from './cloud/file-presign.js';
import { cloudSchema, memberGroupFor } from './cloud/rls.js';
import { evaluateRetrieval } from './search/eval.js';
import type {
  EvalQuery,
  Retriever,
  RetrievalEvalOptions,
  RetrievalEvalSummary,
} from './search/eval.js';
import { diagnoseRetrieval } from './search/doctor.js';
import type { RetrievalHealthReport, RetrievalHealthSpec } from './search/doctor.js';
import { benchmarkRetrieval } from './search/benchmark.js';
import type { BenchmarkOptions, BenchmarkReport } from './search/benchmark.js';

/**
 * Initialise Lattice from a YAML config file instead of an explicit path.
 *
 * @example
 * ```ts
 * const db = new Lattice({ config: './lattice.config.yml' });
 * await db.init();
 * ```
 */
export interface LatticeConfigInput {
  /** Path to `lattice.config.yml` (absolute or relative to `process.cwd()`) */
  config: string;
  /** Optional Lattice runtime options */
  options?: LatticeOptions;
}

type EventHandler<T> = (data: T) => void;

/**
 * A primary key lookup value.
 * - `string` — the value of the table's single PK column (backward compatible).
 * - `Record<string, unknown>` — column → value map for composite PKs.
 */
export type PkLookup = string | Record<string, unknown>;

/**
 * Pick the right adapter based on the connection string's scheme.
 *
 * Supported forms:
 * - `postgres://...`, `postgresql://...` → PostgresAdapter
 * - `file:...` → SQLiteAdapter (strips the `file:` prefix; useful for explicit disambiguation)
 * - `:memory:` → SQLiteAdapter (in-memory, current behavior)
 * - any other plain path → SQLiteAdapter (current default; preserves backward compat)
 *
 * Override via `options.adapter` to bring your own adapter or to inject a
 * pre-opened connection.
 */
function buildAdapter(dbPath: string, options: LatticeOptions): StorageAdapter {
  if (/^postgres(ql)?:\/\//i.test(dbPath)) {
    return new PostgresAdapter(dbPath);
  }
  const sqlitePath = dbPath.startsWith('file:') ? dbPath.slice('file:'.length) : dbPath;
  const adapterOpts: { wal?: boolean; busyTimeout?: number } = {};
  if (options.wal !== undefined) adapterOpts.wal = options.wal;
  if (options.busyTimeout !== undefined) adapterOpts.busyTimeout = options.busyTimeout;
  // Under a runtime that ships `node:sqlite` but can't load native addons
  // (the desktop build), use the node:sqlite-backed adapter instead of the
  // better-sqlite3 one. Node/npm consumers are unaffected — `Deno` is undefined
  // there, so this branch is never taken.
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') {
    return new DenoSqliteAdapter(sqlitePath, adapterOpts);
  }
  return new SQLiteAdapter(sqlitePath, adapterOpts);
}

/**
 * Soft-delete convention: a row is "live" only when `deleted_at IS NULL`, and that
 * exact predicate is written inline wherever a query must exclude soft-deleted rows
 * (no indirection — it is a self-documenting SQL fragment, used identically here, in
 * search/fts.ts, and in crud/seed-engine.ts).
 *
 * v4.0 BREAKING: the legacy empty-string branch (`OR deleted_at = ''`) was removed.
 * The library only ever writes a timestamp (on delete) or NULL (on insert/restore),
 * never `''`, so this is a no-op for any DB that has only used this library to
 * soft-delete. Consumers with legacy/externally-inserted rows MUST normalize every
 * `deleted_at = ''` row to NULL BEFORE upgrading (see MIGRATING-4.0.md) — otherwise
 * those live rows read as deleted, and a natural-key upsert against a hidden row can
 * insert a duplicate.
 */

/**
 * Cap on the changelog rows the render-time per-viewer fold ({@link Lattice.foldRenderRows})
 * reads in one pass. Deliberately large — a workspace is not expected to exceed it,
 * and the fold reverts cleanly to ground truth for any older change beyond the cap.
 * Named (rather than an inline literal) so the bound is explicit + tunable. (The
 * single-row fold, {@link Lattice.foldForViewer}, reads only ONE row's audit chain
 * and is naturally bounded by that row's history — it needs no separate cap.)
 */
const RENDER_FOLD_MAX_CHANGES = 100_000;

export class Lattice {
  private readonly _adapter: StorageAdapter;
  /**
   * Ambient transaction executor for {@link transaction}. When a store is set,
   * every write helper routes through it (via {@link _exec}) instead of the base
   * adapter, so the whole call chain lands on one transaction connection. Scoped
   * to the async context of the `transaction(fn)` callback, so concurrent callers
   * never share a transaction.
   */
  private readonly _txStore = new AsyncLocalStorage<StorageAdapter>();
  /**
   * Serializer for schema mutations (CREATE TABLE / ALTER … ADD COLUMN). See
   * {@link withSchemaLock}. The flag marks "already inside the lock" for reentrancy;
   * the chain is the FIFO queue that runs one locked section at a time.
   */
  private readonly _schemaLockFlag = new AsyncLocalStorage<true>();
  private _schemaLockChain: Promise<unknown> = Promise.resolve();
  private _changelogService?: ChangelogService;
  private _changelogWriterInstance?: ChangelogWriter;
  private _reportBuilder?: ReportBuilder;
  private _queryCoreInstance?: QueryCore;
  private _seedEngine?: SeedEngine;
  private readonly _schema: SchemaManager;
  private readonly _sanitizer: Sanitizer;
  private readonly _render: RenderEngine;
  private readonly _reverseSync: ReverseSyncEngine;
  private readonly _reverseSeedEngine: ReverseSeedEngine;
  private readonly _loop: SyncLoop;
  private readonly _writeback: WritebackPipeline;
  private _initialized = false;

  // --- Auto-render: keep the SQL→markdown bridge current automatically. ---
  /**
   * The debounce + single-flight auto-render scheduler (see
   * {@link AutoRenderScheduler}). Lazily constructed by the {@link _autoRender}
   * getter and configured by {@link enableAutoRender} / {@link Lattice.openWorkspace}.
   * Undefined = inert: a bare `new Lattice(dbPath)` never constructs the
   * scheduler and pays zero overhead, so its behavior is unchanged.
   */
  private _autoRenderScheduler?: AutoRenderScheduler;

  /** Cache of actual table columns (from PRAGMA), populated after init(). */
  private readonly _columnCache = new Map<string, Set<string>>();

  /** Raw encryption key passphrase from constructor options. */
  private readonly _encryptionKeyRaw?: string;
  /** Lazily-constructed column-encryption layer (see {@link _encryption}). */
  private _encryptionLayer?: EncryptionLayer;

  /** Changelog retention options. */
  private readonly _changelogOptions?: ChangelogOptions;
  /** Set of table names that have changelog: true. */
  private readonly _changelogTables = new Set<string>();

  /** Current task context string for relevance filtering. */
  private _taskContext = '';

  /**
   * True when this connection opened against an already-provisioned cloud as a
   * SCOPED MEMBER (no role-management privilege → no CREATE/ALTER on the schema).
   * Set during init() by the same probe that decides introspect-only. Drives
   * {@link addColumn} to route DDL through the owner-side `lattice_member_add_column`
   * SECURITY DEFINER helper instead of issuing a raw ALTER the member can't run.
   */
  private _cloudMemberOpen = false;

  private readonly _auditHandlers: EventHandler<AuditEvent>[] = [];
  private readonly _renderHandlers: EventHandler<RenderResult>[] = [];
  private readonly _writebackHandlers: EventHandler<{
    filePath: string;
    entriesProcessed: number;
  }>[] = [];
  private readonly _errorHandlers: EventHandler<Error>[] = [];
  private readonly _reverseSeedHandlers: EventHandler<{
    table: string;
    rowCount: number;
    source: 'files';
  }>[] = [];
  private readonly _writeHooks: WriteHook[] = [];
  /** Optional cap on per-row payload bytes; see LatticeOptions.maxRowBytes. */
  private _maxRowBytes: number | undefined;
  /** Optional default bounded-read cap; see LatticeOptions.defaultMaxRows. */
  private _defaultMaxRows: number | undefined;
  /** table → immutable provenance column names (governance: P-PROV). */
  private readonly _provenanceCols = new Map<string, string[]>();
  /** table → default trust state for new rows (governance: P-TRUST). */
  private readonly _trustDefault = new Map<string, TrustState>();
  /** table → connector source descriptor (connected data types, 4.3+). */
  private readonly _connectedSources = new Map<string, ConnectorSource>();
  /** table → computed-column specs + recompute order + dep set (P-VIEW). */
  private readonly _computed = new Map<
    string,
    { specs: Record<string, ComputedColumnSpec>; order: string[]; deps: Set<string> }
  >();
  /** table → materialized rollup specs (P-VIEW). */
  private readonly _rollups = new Map<string, Record<string, MaterializedRollupSpec>>();
  /** table → compiled DETERMINISTIC computed columns (same-row alias/calc, #10) for the
   *  bounded write-path recompute UPDATE. Deferred kinds (aggregate/AI/belongsTo-path)
   *  are produced by their own mechanisms and are NOT in this map. */
  private readonly _computedFieldSql = new Map<
    string,
    { column: string; sql: string; deps: Set<string> }[]
  >();
  /** All compiled computed fields per table (incl. deferred) — for introspection + fill. */
  private readonly _computedFieldPlans = new Map<string, CompiledComputedField[]>();
  /** table → its AI computed fields (column + input deps + plan) — the async-fill hot path. */
  private readonly _aiComputedFields = new Map<
    string,
    { column: string; deps: Set<string>; ai: AiFieldPlan }[]
  >();
  /** Computed-table (read-only view) definitions from the YAML config. */
  private readonly _configComputedTables: { name: string; definition: ComputedTableDef }[] = [];
  /**
   * Names of the computed tables registered by this instance — the single
   * source of truth the write-refusal guard and {@link isComputedTable} share.
   */
  private readonly _computedTables = new Set<string>();
  /** Outcome of the init-time computed-table registration (see accessor). */
  private _computedRegistration: ComputedRegistrationResult | null = null;
  /** source table → parents whose rollup it feeds (for incremental recompute). */
  private readonly _rollupSources = new Map<
    string,
    { parentTable: string; name: string; spec: MaterializedRollupSpec }[]
  >();

  /**
   * Reject the row if its payload exceeds `_maxRowBytes`. Cost is dominated
   * by Buffer.byteLength() on string columns; we skip numbers/booleans
   * (negligible contribution). Off when `_maxRowBytes` is unset.
   */
  private _assertRowSize(table: string, row: Row): void {
    if (this._maxRowBytes === undefined) return;
    let total = 0;
    for (const v of Object.values(row)) {
      if (typeof v === 'string') {
        total += Buffer.byteLength(v, 'utf8');
      } else if (Buffer.isBuffer(v)) {
        total += v.length;
      } else if (v != null && typeof v === 'object') {
        // Estimate JSON cost — JSONB/JSON columns serialize through here.
        total += Buffer.byteLength(JSON.stringify(v), 'utf8');
      }
      if (total > this._maxRowBytes) {
        throw new Error(
          `Lattice: row for "${table}" exceeds maxRowBytes (>${String(this._maxRowBytes)} bytes)`,
        );
      }
    }
  }

  constructor(pathOrConfig: string | LatticeConfigInput, options: LatticeOptions = {}) {
    // Resolve config-file form: read YAML, extract dbPath, collect table defs
    let dbPath: string;
    let configTables: { name: string; definition: TableDefinition }[] | undefined;
    let configEntityContexts: { table: string; definition: EntityContextDefinition }[] | undefined;

    if (typeof pathOrConfig === 'string') {
      dbPath = pathOrConfig;
    } else {
      const parsed = parseConfigFile(pathOrConfig.config);
      dbPath = parsed.dbPath;
      configTables = [...parsed.tables];
      configEntityContexts = [...parsed.entityContexts];
      // Computed tables register late (after schema application in init) —
      // their views are derived FROM the entity tables, so only the parsed
      // definitions are kept here.
      this._configComputedTables = [...parsed.computedTables];
      // Config-level options merge under any explicit options passed in
      if (pathOrConfig.options) {
        options = { ...pathOrConfig.options, ...options };
      }
    }

    this._adapter = options.adapter ?? buildAdapter(dbPath, options);
    this._schema = new SchemaManager();
    this._sanitizer = new Sanitizer(options.security);
    this._render = new RenderEngine(this._schema, this._adapter, () => this._taskContext, {
      skipEmpty: options.renderSkipsEmpty ?? false,
    });
    this._reverseSync = new ReverseSyncEngine(this._schema, this._adapter);
    this._reverseSeedEngine = new ReverseSeedEngine(this._schema, this._adapter);
    this._loop = new SyncLoop(this._render);
    this._writeback = new WritebackPipeline();

    if (options.encryptionKey) this._encryptionKeyRaw = options.encryptionKey;
    if (options.changelog) this._changelogOptions = options.changelog;
    if (options.maxRowBytes !== undefined) this._maxRowBytes = options.maxRowBytes;
    if (options.defaultMaxRows !== undefined) this._defaultMaxRows = options.defaultMaxRows;

    this._sanitizer.onAudit((event) => {
      for (const h of this._auditHandlers) h(event);
    });

    // Register all tables declared in the YAML config
    if (configTables) {
      for (const { name, definition } of configTables) {
        this.define(name, definition);
      }
    }

    // Register entity contexts declared in the YAML config
    if (configEntityContexts) {
      for (const { table, definition } of configEntityContexts) {
        this.defineEntityContext(table, definition);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Open a workspace under a `.lattice` root. Resolves the root (the
   * `LATTICE_ROOT` env override or a `.lattice/.config` found by walking up
   * from the cwd), looks up the active or named workspace, applies the
   * canonical DB-aligned `Context/` layout for any table lacking an explicit
   * entity context, runs `init()`, and — by default — enables auto-render and
   * renders once so the `Context/` tree exists immediately (no "run lattice
   * render" step). The returned Lattice is initialized and ready to use.
   */
  static async openWorkspace(
    opts: {
      root?: string;
      workspaceId?: string;
      options?: LatticeOptions;
      autoRender?: boolean;
    } = {},
  ): Promise<Lattice> {
    const root = opts.root ?? resolveLatticeRoot();
    const ws: WorkspaceRecord | null = opts.workspaceId
      ? getWorkspace(root, opts.workspaceId)
      : getActiveWorkspace(root);
    if (!ws) {
      throw new Error(
        `Lattice: no workspace found under ${root} — run \`lattice init\` to create one`,
      );
    }
    const paths = resolveWorkspacePaths(root, ws);
    const db = new Lattice({ config: paths.configPath }, opts.options ?? {});
    // Apply the canonical, DB-aligned Context/ layout for tables without one.
    const parsed = parseConfigFile(paths.configPath);
    const existing = db.entityContexts();
    for (const { table, definition } of deriveCanonicalContexts(parsed.tables)) {
      if (!existing.has(table)) db.defineEntityContext(table, definition);
    }
    await db.init();
    if (opts.autoRender !== false) {
      db.enableAutoRender(paths.contextDir);
      const prevManifest = readManifest(paths.contextDir);
      await db.render(paths.contextDir);
      // Open-time reconciliation: sweep files whose rows/layout changed while
      // the workspace was closed (same prev→render→cleanup the auto-render
      // does), instead of leaving them stale until the first mutation.
      const newManifest = readManifest(paths.contextDir);
      await db.reconcileRenderedTree(paths.contextDir, prevManifest, newManifest);
      // Guarantee a manifest exists even for an empty workspace, so there is
      // never a "no rendered context available" state.
      if (!existsSync(manifestPath(paths.contextDir))) {
        writeManifest(paths.contextDir, {
          version: 2,
          generated_at: new Date().toISOString(),
          entityContexts: {},
        });
      }
    }
    return db;
  }

  define(table: string, def: TableDefinition): this {
    this._assertNotInit('define');
    this._registerTable(table, def);
    return this;
  }

  /**
   * Register a table after `init()` has already run, and immediately apply
   * its DDL to the underlying database. The mirror image of `define()` for
   * post-init use cases — most notably the Lattice Teams feature, which
   * boots a server-mode lattice and then registers its internal tables
   * (users, tokens, etc.) once the main schema has been initialized.
   *
   * On Postgres, the DDL acquires `pg_advisory_xact_lock` so concurrent
   * defineLate calls serialize on the same lock the boot path uses (see
   * `SchemaManager.applySchemaForAsync`). On SQLite, CREATE TABLE IF NOT
   * EXISTS plus the single-writer guarantee covers the race.
   *
   * Idempotent: a second call for an already-registered table is a no-op
   * (the underlying CREATE TABLE IF NOT EXISTS is already idempotent at
   * the DB level; this skip avoids the SchemaManager.define throw on
   * re-registration). Useful for callers that may bootstrap their
   * internal tables on every session start.
   *
   * Throws if called before `init()` (use `define()` instead).
   */
  async defineLate(table: string, def: TableDefinition): Promise<this> {
    if (!this._initialized) {
      throw new Error(
        'Lattice: defineLate() must be called after init() — use define() during setup',
      );
    }
    if (this._schema.getTables().has(table)) {
      return this;
    }
    this._encryption.validateTable(table, def);
    this._registerTable(table, def);
    await this._schema.applySchemaForAsync(this._adapter, table);
    const cols = await introspectColumnsAsyncOrSync(this._adapter, table);
    this._columnCache.set(table, new Set(cols));
    if (def.encrypted) {
      await this._encryption.registerColumns(table, def.encrypted);
    }
    return this;
  }

  /**
   * Remove a runtime-registered table from the live schema registry — the
   * inverse of {@link defineLate}. The table stops being listed/queryable
   * WITHOUT a full reopen (which would dispose this instance and invalidate any
   * captured `db`/feed references mid-operation — see the GUI's soft table
   * delete). Does NOT drop the physical SQL table or its rows; the caller keeps
   * them so the delete remains revertible. A no-op if the table isn't
   * registered.
   */
  unregisterTable(table: string): this {
    this._schema.undefine(table);
    this._columnCache.delete(table);
    this._changelogTables.delete(table);
    return this;
  }

  private _registerTable(table: string, def: TableDefinition): void {
    // Auto-inject reward tracking + governance (provenance / trust) columns.
    let columns = def.rewardTracking
      ? { ...def.columns, _reward_total: 'REAL DEFAULT 0', _reward_count: 'INTEGER DEFAULT 0' }
      : def.columns;
    if (def.provenance) {
      const provCols = provenanceColumns(def.provenance);
      columns = { ...columns, ...provCols };
      this._provenanceCols.set(table, Object.keys(provCols));
    }
    if (def.trust) {
      columns = { ...columns, ...TRUST_COLUMNS };
      this._trustDefault.set(table, resolveTrustDefault(def.trust) ?? 'unverified');
    }
    if (def.source) {
      columns = { ...columns, ...connectedColumns(def.source) };
      this._connectedSources.set(table, def.source);
    }
    if (def.computed) {
      // Validate dependency order (throws on a cycle) before adding columns.
      const order = computedColumnOrder(table, def.computed);
      columns = { ...columns, ...computedColumnDdl(def.computed) };
      this._computed.set(table, {
        specs: def.computed,
        order,
        deps: allComputedDeps(def.computed),
      });
    }
    if (def.materializedRollups) {
      columns = { ...columns, ...rollupColumnDdl(def.materializedRollups) };
      this._rollups.set(table, def.materializedRollups);
      for (const [name, spec] of Object.entries(def.materializedRollups)) {
        const arr = this._rollupSources.get(spec.sourceTable) ?? [];
        arr.push({ parentTable: table, name, spec });
        this._rollupSources.set(spec.sourceTable, arr);
      }
    }
    if (def.computedFields) {
      // #10 computed columns: the physical column already exists (a computed field is a
      // declared field with a `type:`); only its DERIVATION is registered here. Compile
      // the DETERMINISTIC same-row kinds (alias/calc) into recompute SQL; a field may
      // reference only the entity's PLAIN columns (not other computed fields), so pass
      // those as the resolution set. Deferred kinds (aggregate/AI/belongsTo-path) are
      // handled by later mechanisms and simply aren't registered for the same-row path.
      const computedNames = new Set(Object.keys(def.computedFields));
      const plainCols = new Set(Object.keys(columns).filter((c) => !computedNames.has(c)));
      const compiled = compileComputedFields(
        table,
        def.computedFields,
        plainCols,
        this.getDialect(),
      );
      this._computedFieldPlans.set(table, compiled);
      const deterministic = compiled
        .filter((c) => !c.deferred)
        .map((c) => ({ column: c.column, sql: c.sql, deps: new Set(c.deps) }));
      if (deterministic.length > 0) this._computedFieldSql.set(table, deterministic);
      // AI fields (ai_classify/ai_transform): a real column filled asynchronously. Registered
      // here so the write path can NULL a stale cell when an input changes; the fill itself is
      // triggered by an injected FillLlm (out of the core DB layer) via fillComputedFields().
      const ai = compiled.flatMap((c) =>
        c.deferred === 'ai' && c.ai ? [{ column: c.column, deps: new Set(c.deps), ai: c.ai }] : [],
      );
      if (ai.length > 0) this._aiComputedFields.set(table, ai);
    }

    // Resolve the built-in template name (if any) for reverse-seed parsing
    const renderTemplateName = _resolveTemplateName(def.render);

    const compiledDef: CompiledTableDef = {
      ...def,
      columns,
      // Identity-preserve NOOP_RENDER so the engine can detect spec-less
      // tables (def.render === NOOP_RENDER) and skip their full-table read.
      render:
        def.render && def.render !== NOOP_RENDER
          ? compileRender(
              def as TableDefinition & { render: RenderSpec },
              table,
              this._schema,
              this._adapter,
            )
          : NOOP_RENDER,
      outputFile: def.outputFile ?? `.schema-only/${table}.md`,
      ...(renderTemplateName ? { _renderTemplateName: renderTemplateName } : {}),
    };
    this._schema.define(table, compiledDef);
    if (def.changelog) this._changelogTables.add(table);
  }

  defineMulti(name: string, def: MultiTableDefinition): this {
    this._assertNotInit('defineMulti');
    this._schema.defineMulti(name, def);
    return this;
  }

  defineEntityContext(table: string, def: EntityContextDefinition): this {
    // No init guard — entity contexts only affect the render pipeline,
    // not schema creation. Safe to register before or after init().
    this._schema.defineEntityContext(table, def);
    return this;
  }

  /**
   * Register or REPLACE an entity context (overwrites instead of throwing on a
   * redefine — see {@link SchemaManager.redefineEntityContext}). Used to refresh
   * a canonical context at runtime after a related schema change.
   */
  redefineEntityContext(table: string, def: EntityContextDefinition): this {
    this._schema.redefineEntityContext(table, def);
    return this;
  }

  /**
   * All entity contexts currently registered on this Lattice — both those
   * declared in `lattice.config.yml` and those added programmatically via
   * `defineEntityContext()`.
   *
   * Returns a defensive copy so callers can't mutate the schema.
   */
  entityContexts(): Map<string, EntityContextDefinition> {
    return new Map(this._schema.getEntityContexts());
  }

  /**
   * Register a write hook that fires after insert/update/delete operations.
   * Hooks run synchronously after the DB write and audit emit.
   */
  defineWriteHook(hook: WriteHook): this {
    this._writeHooks.push(hook);
    return this;
  }

  defineWriteback(def: WritebackDefinition): this {
    this._writeback.define(def);
    return this;
  }

  init(options: InitOptions = {}): Promise<void> {
    // Synchronous validation phase — anything that should fail loudly with
    // a thrown Error (rather than a rejected Promise) goes here. Existing
    // callers do `expect(() => db.init()).toThrow(...)` to assert config
    // misuse, so the throw must originate from a non-async function.
    if (this._initialized) {
      return Promise.reject(new Error('Lattice: init() has already been called'));
    }
    this._adapter.open();
    // Throw-only encryption-key validation. Resolving encrypted columns moves
    // into the async tail (needs the schema to exist first).
    this._encryption.validateConfig();
    return this._initAsync(options);
  }

  /** Async tail of init(). See {@link init} for the sync-validation phase. */
  private async _initAsync(options: InitOptions): Promise<void> {
    // Auto-detect a scoped cloud member on an already-provisioned cloud and skip
    // schema DDL even when the caller didn't pass `introspectOnly` (the CLI
    // `render`/`reconcile`/`watch` and library callers don't). A member role has
    // no CREATE on schema public, and Postgres checks that privilege BEFORE the
    // `IF NOT EXISTS` short-circuit — so applySchema's `CREATE TABLE IF NOT
    // EXISTS` / `CREATE OR REPLACE VIEW` / `CREATE INDEX` fail with "permission
    // denied for schema public" even though every object already exists. Detected
    // with two privilege-safe reads: the cloud marker table exists, and the
    // connected role cannot create roles (an owner/DBA can → normal DDL path).
    // Any failure falls through to applySchema so a genuine misconfiguration
    // still surfaces loudly — never a silent success. Inlined rather than calling
    // framework/cloud-connect to avoid a core↔framework import cycle.
    let introspectOnly = options.introspectOnly === true;
    if (this.getDialect() === 'postgres') {
      try {
        const [marker, role] = await Promise.all([
          getAsyncOrSync(this._exec(), `SELECT to_regclass('__lattice_owners') AS reg`),
          getAsyncOrSync(
            this._exec(),
            `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user`,
          ),
        ]);
        const provisioned = !!marker && (marker as { reg?: unknown }).reg != null;
        const canCreateRoles =
          !!role && (role as { rolcreaterole?: unknown }).rolcreaterole === true;
        const memberOpen = provisioned && !canCreateRoles;
        // Auto-detect a scoped member even when the caller didn't ask for
        // introspectOnly (CLI render/reconcile/watch + library callers don't), so
        // DDL is skipped against an already-provisioned cloud this role can't ALTER.
        introspectOnly = introspectOnly || memberOpen;
        // Record the member case so addColumn routes a runtime ALTER through the
        // owner-side SECURITY DEFINER helper (a member can't ALTER the schema
        // directly). The probe runs even when introspectOnly was passed explicitly
        // (e.g. the GUI member open), so the flag is set on that path too.
        this._cloudMemberOpen = memberOpen;
      } catch {
        // Detection unavailable (transient / permission) — fall through to the
        // normal applySchema path, which fails loudly if the role truly can't DDL.
      }
    }
    if (introspectOnly) {
      // Scoped cloud member: the owner already installed every table, migration,
      // and RLS policy. This role can't DDL, so issue none — just introspect the
      // declared tables to seed the column cache (skip any this member can't see)
      // and finalize encryption. No migrations, FTS, changelog, or embeddings.
      // One whole-schema introspection instead of a round-trip per table; a
      // table absent from the map is one the member can't see, so it stays
      // uncached — same semantics as the prior per-table try/catch-skip.
      const declared = [...this._schema.getTables().keys()];
      const preMap = await introspectAllColumnsAsyncOrSync(this._adapter, declared);
      for (const tableName of declared) {
        const cols = preMap.get(tableName);
        if (cols) this._columnCache.set(tableName, cols);
      }
      await this._encryption.finalizeSetup();
      this._initialized = true;
      // Computed tables: the owner already created the views; this role can't
      // DDL, so register purely by introspection (invisible views are skipped).
      await this._registerConfigComputedTables(true);
      return;
    }
    // One whole-schema introspection up front (one query on Postgres vs. a
    // round-trip per declared table) feeds applySchema's create-only-missing
    // diff so a converged DB issues no per-table DDL or introspection.
    const declared = [...this._schema.getTables().keys()];
    const preMap = await introspectAllColumnsAsyncOrSync(this._adapter, declared);
    const mutated = await this._schema.applySchema(this._adapter, preMap);
    if (options.migrations?.length) {
      // applyMigrationsAsync uses adapter.withClient when available
      // (Postgres path acquires pg_advisory_xact_lock for concurrent-boot
      // serialization; SQLite path is a plain BEGIN/COMMIT). Falls back to
      // the sync runner when an older adapter doesn't implement withClient.
      await this._schema.applyMigrationsAsync(this._adapter, options.migrations);
    }
    // Snapshot actual columns post-migration: schema state only includes declared
    // columns, so migration-added columns would be stripped by _filterToSchemaColumns
    // without this introspection-based cache. When applySchema changed nothing AND
    // no migrations ran, the DB is exactly what preMap already described — reuse it
    // instead of paying the introspection again. Otherwise re-fetch the true state.
    if (!mutated && !options.migrations?.length) {
      for (const tableName of declared) {
        const cols = preMap.get(tableName);
        if (cols) this._columnCache.set(tableName, cols);
      }
    } else {
      const postMap = await introspectAllColumnsAsyncOrSync(this._adapter, declared);
      for (const tableName of declared) {
        const cols = postMap.get(tableName);
        if (cols) this._columnCache.set(tableName, cols);
      }
    }

    // Resolve encrypted columns (needs introspectColumns to see post-migration schema)
    await this._encryption.finalizeSetup();

    // Create embeddings table if any table uses embeddings
    const hasEmbeddings = [...this._schema.getTables().values()].some((d) => d.embeddings);
    if (hasEmbeddings) {
      await ensureEmbeddingsTable(this._adapter);
    }

    // Build full-text-search indexes (FTS5 / tsvector) for opt-in tables only.
    // Tables without `fts` are untouched — no index, no triggers, no overhead.
    await this._buildFtsIndexes();

    // Create changelog table if any table uses changelog tracking
    if (this._changelogTables.size > 0) {
      await this._ensureChangelogTable();
      await this._pruneChangelog();
    }

    this._initialized = true;

    // Computed tables register LAST — their views are projections of the
    // entity tables the schema application above just converged.
    await this._registerConfigComputedTables(false);
  }

  /**
   * Register the config-declared computed tables (read-only SQL views) in
   * topological order: compile, execute the view DDL (SQLite drops +
   * recreates unconditionally; Postgres guards the DDL behind a content-hash
   * migration version so a converged open issues none), introspect, and
   * register each view as a queryable table. A definition that fails to
   * compile never bricks the open — it is recorded under field `'*'` in
   * `__lattice_computed_state`, surfaced via {@link getComputedRegistration},
   * and the remaining tables continue.
   */
  private async _registerConfigComputedTables(introspectOnly: boolean): Promise<void> {
    if (this._configComputedTables.length === 0) return;
    const defs: Record<string, ComputedTableDef> = {};
    for (const { name, definition } of this._configComputedTables) defs[name] = definition;

    const cloud = await this.computedCloudOption({ introspectOnly });
    const result = await registerComputedTables(this._computedTableHost(), defs, {
      schema: this.computedSchemaLookup(),
      dialect: this.getDialect(),
      ...(introspectOnly ? { introspectOnly } : {}),
      ...(cloud ? { cloud } : {}),
    });

    for (const table of result.registered) this._computedTables.add(table);
    this._computedRegistration = result;
  }

  /**
   * The registration host over THIS instance — shared by the init-time
   * registration and {@link registerComputedTablesLive} so both register
   * through the identical seam.
   */
  private _computedTableHost(): ComputedTableHost {
    return {
      adapter: this._adapter,
      // Direct migration application — Lattice.migrate() would re-introspect
      // every registered table per computed table, which the post-registration
      // column-cache write below already covers for the only table that changed.
      migrate: (migrations) => this._schema.applyMigrationsAsync(this._adapter, migrations),
      introspectColumns: (table) => introspectColumnsAsyncOrSync(this._adapter, table),
      // Batch the post-create column introspection of all computed views into one
      // information_schema round-trip (a per-table serial cost on a pooled cloud).
      introspectAllColumns: (tables) => introspectAllColumnsAsyncOrSync(this._adapter, tables),
      register: (table, def, columns) => {
        if (!this._schema.getTables().has(table)) this._registerTable(table, def);
        this._columnCache.set(table, new Set(columns));
      },
    };
  }

  /**
   * On a secured team cloud, computed views must compile with per-relation
   * `lattice_row_visible(...)` predicates: a Postgres view executes with its
   * OWNER's rights, so without the predicates a member granted SELECT on the
   * view would read every base row, bypassing RLS. The predicate helper only
   * exists once the cloud RLS bootstrap has run — detected by its
   * `__lattice_owners` bookkeeping table (same tell `probeCloud` uses). A probe
   * failure propagates: silently compiling without the predicates on a cloud
   * would be a row-visibility hole, and a connection broken enough to fail this
   * one SELECT fails the open anyway.
   */
  async computedCloudOption(
    opts: { introspectOnly?: boolean } = {},
  ): Promise<CloudCompileOptions | undefined> {
    if (this.getDialect() !== 'postgres') return undefined;
    const row = (await getAsyncOrSync(
      this._adapter,
      `SELECT to_regclass('__lattice_owners') AS reg`,
    )) as { reg?: string | null } | undefined;
    if (row?.reg == null) return undefined;
    // An introspect-only (scoped member) open compiles NO view DDL — it registers
    // the owner-created views by introspection — so it needs no masked-tables set;
    // and a member has no grant on the owner-only `__lattice_column_policy`, so
    // reading it here would fail. Return just the row-visibility flag.
    if (opts.introspectOnly) return { rowVisible: true };
    // Tables with a cell-masking `<t>_v` view (some column carries a non-default
    // audience in the canonical `__lattice_column_policy` store). A computed view
    // reads such a table's columns THROUGH its masking view, so a member never
    // sees the raw value of a column the owner masked from their role. Read the
    // policy from the DB (canonical), NOT the config-derived in-memory audience —
    // the latter never reflects a column masked at runtime (GUI "mark secret").
    // One bounded query over a small, owner-managed table.
    const policy = await loadAllColumnPolicy(this);
    const maskedTables = new Set<string>();
    for (const [table, cols] of policy) {
      if (tableNeedsAudienceView(cols)) maskedTables.add(table);
    }
    return maskedTables.size > 0 ? { rowVisible: true, maskedTables } : { rowVisible: true };
  }

  /**
   * Table lookup for the computed-table compiler: every registered table's
   * declared + introspected columns, belongsTo relations, and normalized
   * primary key. Shared by the init-time registration and the runtime ops
   * layer (create/preview/field pickers), so the two can never disagree about
   * what a definition may reference.
   */
  computedSchemaLookup(): Map<string, ComputedSchemaTable> {
    const schema = new Map<string, ComputedSchemaTable>();
    for (const [table, def] of this._schema.getTables()) {
      const columns = new Set<string>(Object.keys(def.columns));
      for (const c of this._columnCache.get(table) ?? []) columns.add(c);
      const relations: Record<string, BelongsToRelation> = {};
      for (const [relName, rel] of Object.entries(def.relations ?? {})) {
        if (rel.type === 'belongsTo') relations[relName] = rel;
      }
      schema.set(table, {
        columns,
        relations,
        primaryKey: this._schema.getPrimaryKey(table),
        hasDeletedAt: columns.has('deleted_at'),
        ...(def.fieldTypes ? { fieldTypes: def.fieldTypes } : {}),
      });
    }
    return schema;
  }

  /**
   * Register computed-table definitions at RUNTIME — the live counterpart of
   * the init-time registration, used by the GUI ops layer (create/update). It
   * runs the SAME registration path as the open (compile in topological order,
   * bookkeeping-table ensure, view DDL, introspect, live-register) with one
   * deliberate difference: the view DDL executes directly (drop + recreate)
   * rather than through the open path's content-hash migration, because a
   * runtime edit can be reverted to a PRIOR definition whose hash was already
   * applied once — a version-guarded migration would skip that DDL. Successful
   * registrations join {@link isComputedTable} / {@link getComputedTableNames}
   * (so the write-refusal guard covers them immediately) and their compiled
   * artifacts merge into {@link getComputedRegistration}. Per-definition
   * failures are RETURNED in `errors`, never thrown — the caller decides
   * whether a failure aborts its operation.
   */
  async registerComputedTablesLive(
    defs: Record<string, ComputedTableDef>,
  ): Promise<ComputedRegistrationResult> {
    if (!this._initialized) {
      throw new Error('Lattice: not initialized — call init() first');
    }
    const cloud = await this.computedCloudOption();
    const result = await registerComputedTables(this._computedTableHost(), defs, {
      schema: this.computedSchemaLookup(),
      dialect: this.getDialect(),
      directDdl: true,
      ...(cloud ? { cloud } : {}),
    });
    this._computedRegistration ??= {
      registered: [],
      skipped: [],
      errors: [],
      compiled: new Map(),
    };
    for (const table of result.registered) {
      this._computedTables.add(table);
      if (!this._computedRegistration.registered.includes(table)) {
        this._computedRegistration.registered.push(table);
      }
    }
    for (const [table, compiled] of result.compiled) {
      this._computedRegistration.compiled.set(table, compiled);
    }
    return result;
  }

  /**
   * Remove a computed table from the live registry — the inverse of
   * {@link registerComputedTablesLive} for one table. Unregisters the view
   * from the schema registry (it stops being listed/queryable) and from the
   * computed-table set (the write-refusal guard no longer names it). Issues NO
   * DDL — the caller owns dropping the view. Throws for a name that is not a
   * registered computed table, so a plain entity can never be unregistered
   * through this path.
   */
  unregisterComputedTable(name: string): void {
    if (!this._computedTables.has(name)) {
      throw new Error(`Lattice: "${name}" is not a registered computed table`);
    }
    this.unregisterTable(name);
    this._computedTables.delete(name);
    if (this._computedRegistration) {
      this._computedRegistration.compiled.delete(name);
      this._computedRegistration.registered = this._computedRegistration.registered.filter(
        (t) => t !== name,
      );
    }
  }

  /**
   * True when `name` is a computed table registered by this instance —
   * a read-only projection that refuses direct writes.
   */
  isComputedTable(name: string): boolean {
    return this._computedTables.has(name);
  }

  /** Names of the computed tables registered by this instance. */
  getComputedTableNames(): string[] {
    return [...this._computedTables];
  }

  /**
   * Outcome of the init-time computed-table registration: what registered,
   * what was skipped (introspect-only member opens), per-table errors, and
   * the compiled artifacts (view SQL + AI fill queries) for downstream
   * consumers such as the fill engine. Null when the config declares no
   * computed tables or init has not run.
   */
  getComputedRegistration(): ComputedRegistrationResult | null {
    return this._computedRegistration;
  }

  /** Refuse writes against a computed table — it is a read-only projection. */
  private _assertNotComputedTable(table: string, op: string): void {
    if (this._computedTables.has(table)) {
      throw new Error(
        `Lattice: ${op}() on "${table}" — a computed table is a read-only projection; ` +
          `edit its source tables or its definition`,
      );
    }
  }

  /**
   * Run additional migrations after init(). Useful for package-level schema
   * changes applied at runtime (e.g. update hooks that add columns).
   *
   * @since 0.17.0
   */
  async migrate(migrations: Migration[]): Promise<void> {
    if (!this._initialized) {
      throw new Error('Lattice: not initialized — call init() first');
    }
    await this._schema.applyMigrationsAsync(this._adapter, migrations);
    // Refresh column cache for any tables affected by migrations
    for (const tableName of this._schema.getTables().keys()) {
      const cols = await introspectColumnsAsyncOrSync(this._adapter, tableName);
      this._columnCache.set(tableName, new Set(cols));
    }
  }

  close(): void {
    this._autoRenderScheduler?.dispose();
    this._adapter.close();
    this._columnCache.clear();
    this._encryptionLayer?.clear();
    this._initialized = false;
  }

  /**
   * Return the actual columns currently present in the underlying table,
   * as reported by the adapter's introspection. Bypasses Lattice's
   * declared schema — useful for callers (e.g. the Lattice Teams schema
   * sync) that need to diff what's on disk against an external spec.
   *
   * Throws if the table doesn't exist or the adapter can't introspect.
   */
  async introspectColumns(table: string): Promise<string[]> {
    if (!this._initialized) {
      throw new Error('Lattice: not initialized — call init() first');
    }
    return introspectColumnsAsyncOrSync(this._adapter, table);
  }

  /**
   * Return the adapter dialect ('sqlite' | 'postgres'). Useful for
   * callers that need to render dialect-specific SQL (e.g. the Lattice
   * Teams schema spec → DDL translation).
   */
  getDialect(): 'sqlite' | 'postgres' {
    return this._adapter.dialect;
  }

  /**
   * The adapter that write/read SQL should execute against: the ambient
   * transaction connection when inside {@link transaction}, otherwise the base
   * adapter. Only the row `run`/`get` execution helpers consult this — schema,
   * introspection, search, and graph helpers keep the base adapter, since those
   * are structural and should not be scoped to a data transaction.
   */
  private _exec(): StorageAdapter {
    return this._txStore.getStore() ?? this._adapter;
  }

  /**
   * Run `fn` inside a single database transaction. Every write `fn` performs
   * through this Lattice (insert / update / delete and their audit + changelog
   * writes) executes on one connection and commits together, or rolls back
   * together if `fn` throws. Reads inside `fn` see its own uncommitted writes.
   *
   * The transaction is scoped to the async context of `fn` (via
   * `AsyncLocalStorage`), so two concurrent callers on the same Lattice never
   * accidentally share a transaction. A nested `transaction` call reuses the
   * outer transaction rather than opening a second one. When the adapter cannot
   * open a transaction (`withClient` unavailable), `fn` runs WITHOUT one — the
   * caller's own validation still applies; this mirrors the hard-delete fallback.
   *
   * @since 5.0.0
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const withClient = this._adapter.withClient?.bind(this._adapter);
    if (!withClient || this._txStore.getStore()) {
      // No transaction support, or already inside one → run inline.
      return fn();
    }
    const real = this._adapter;
    return withClient((tx) => {
      const unavailable = (op: string) => (): never => {
        throw new Error(
          `Lattice.transaction: synchronous ${op}() is unavailable inside a transaction`,
        );
      };
      const txAdapter: StorageAdapter = {
        dialect: real.dialect,
        run: unavailable('run'),
        get: unavailable('get'),
        all: unavailable('all'),
        prepare: (sql) => real.prepare(sql),
        open: () => {
          real.open();
        },
        close: () => {
          real.close();
        },
        introspectColumns: (table) => real.introspectColumns(table),
        addColumn: (table, column, typeSpec) => {
          real.addColumn(table, column, typeSpec);
        },
        runAsync: async (sql, params) => {
          await tx.run(sql, params);
        },
        getAsync: (sql, params) => tx.get(sql, params),
        allAsync: (sql, params) => tx.all(sql, params),
      };
      return this._txStore.run(txAdapter, fn);
    });
  }

  /**
   * Run `fn` with exclusive access to schema mutation. Serializes CREATE TABLE /
   * ALTER … ADD COLUMN so concurrent callers can't interleave a check-then-DDL
   * across an `await` and collide. This matters because the SQLite adapter is one
   * synchronous connection: when a parallel folder ingest has two files that both
   * extract a new "Invoices" entity, or both add an "amount" column, the un-serialized
   * loser hits `CREATE TABLE`/`ADD COLUMN` after the winner already ran it and throws
   * "table already exists" / "duplicate column name". Row INSERTs are deliberately NOT
   * serialized — they're atomic auto-commit statements with uuid keys and no
   * read-modify-write, so they stay fully concurrent.
   *
   * Reentrant via `AsyncLocalStorage`: a locked section that itself triggers more
   * DDL (e.g. `createUserEntity` → `addColumn` when securing a cloud table) runs the
   * nested call inline instead of deadlocking on the queue it already holds — the same
   * ambient-context pattern as {@link transaction}. A rejected `fn` never poisons the
   * queue: the chain advances on settle either way, and the caller still sees the
   * rejection through the returned promise.
   *
   * @since 5.0.0
   */
  async withSchemaLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this._schemaLockFlag.getStore()) return fn(); // already holding it → inline
    const run = this._schemaLockChain.then(() => this._schemaLockFlag.run(true, fn));
    this._schemaLockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * True when a table opts into the observation/changelog substrate
   * (`def.changelog`). Callers that want to bypass the high-level {@link delete}
   * with a transaction-scoped raw delete use this to know whether the table also
   * needs the changelog / write-hook / embedding side effects that only
   * `delete()` performs — so they can keep the high-level path for such tables.
   */
  isChangelogTracked(table: string): boolean {
    return this._changelogTables.has(table);
  }

  /**
   * True when this connection opened as a scoped cloud MEMBER (see
   * {@link _cloudMemberOpen}). Callers use it to route DDL-bearing work through
   * the owner-side SECURITY DEFINER helpers rather than issuing DDL the member's
   * role can't run (e.g. {@link addColumn} regenerates the masking view inside
   * `lattice_member_add_column`, so the caller must not also try to regenerate it).
   */
  isCloudMemberOpen(): boolean {
    return this._cloudMemberOpen;
  }

  /**
   * Return the normalised primary-key column list for a registered
   * table. Falls back to `['id']` for tables registered via raw DDL
   * (without a corresponding `define()` call) — same as the
   * SchemaManager default.
   */
  getPrimaryKey(table: string): string[] {
    return this._schema.getPrimaryKey(table);
  }

  /**
   * Per-column audience for a table (per-viewer enrichment) — column name →
   * audience identifier. A column absent from the map has `row-audience`
   * (visible to whoever can see the row). Empty until a column declares
   * `audience:`. Drives the generated cell-masking view.
   */
  getColumnAudience(table: string): Record<string, string> {
    return this._schema.getColumnAudience(table);
  }

  /**
   * Return the raw column declarations for a registered table, as
   * passed to `define()` / `defineLate()`. Returns null for tables
   * that exist in the DB but were never registered with Lattice (e.g.
   * created by user DDL outside the lattice config).
   *
   * Used by the Lattice Teams `share` command to serialise a local
   * TableDefinition into the dialect-neutral SchemaSpec format.
   */
  getRegisteredColumns(table: string): Record<string, string> | null {
    const def = this._schema.getTables().get(table);
    return def ? { ...def.columns } : null;
  }

  /**
   * Return the canonical Lattice field types (`text`/`integer`/`real`/
   * `boolean`/`uuid`/`datetime`/`date`) for a table's config-declared columns,
   * or `null` if the table is unknown or was defined in code without declared
   * field types. The GUI prefers this over `getRegisteredColumns` for display
   * because the SQL spec returned by the latter is lossy and noisy.
   */
  getRegisteredFieldTypes(table: string): Record<string, string> | null {
    const def = this._schema.getTables().get(table);
    return def?.fieldTypes ? { ...def.fieldTypes } : null;
  }

  /**
   * Return every table currently registered via `define()` or
   * `defineLate()`. Includes tables added at runtime by the Lattice
   * Teams schema-propagation flow, so GUI consumers can refresh their
   * own "valid tables" set after a sync.
   */
  getRegisteredTableNames(): string[] {
    return Array.from(this._schema.getTables().keys());
  }

  /**
   * Add a single column to an existing table at runtime. Wraps the
   * adapter's `addColumnAsync` (which handles dialect-specific quirks —
   * SQLite non-constant default workarounds, Postgres native syntax,
   * PK skip, etc.) and refreshes the column cache so subsequent
   * `query`/`insert`/`update` calls are aware of the new column.
   *
   * Also mirrors the new column into the SchemaManager's stored
   * TableDefinition, so `getRegisteredColumns()` reflects the post-ALTER
   * schema. This matters because the Teams `share` flow serializes that def
   * to propagate the schema to teammates — without the mirror, a
   * runtime-added column was silently dropped from the shared spec. The
   * runtime column cache remains what insert/update/query consult.
   *
   * Idempotent: if the column already exists on the table, this is a
   * no-op (introspect-first; skip the ALTER).
   */
  async addColumn(table: string, column: string, typeSpec: string): Promise<void> {
    if (!this._initialized) {
      throw new Error('Lattice: not initialized — call init() first');
    }
    // Both names reach an ALTER TABLE string; reject anything that could break
    // out of the identifier quoting (see src/schema/identifier.ts).
    assertSafeIdentifier(table, 'table');
    assertSafeIdentifier(column, 'column');
    // The introspect (does the column exist?) and the ALTER straddle an await, so
    // two concurrent adds of the same column would both read it absent and both
    // ALTER — the second throwing "duplicate column name". Serialize the whole
    // check-then-act behind the schema lock so it's atomic. Reentrant, so a caller
    // already inside the lock (e.g. createUserEntity securing a cloud table) doesn't
    // deadlock. See withSchemaLock.
    await this.withSchemaLock(async () => {
      const existing = await introspectColumnsAsyncOrSync(this._adapter, table);
      if (!existing.includes(column)) {
        if (this._cloudMemberOpen) {
          // Scoped cloud member: no CREATE/ALTER on the schema, so a raw ALTER would
          // fail with "permission denied for schema public". Route the column add
          // (and the masking-view regen) through the owner-side SECURITY DEFINER
          // helper, which runs as the owner. A real error (bad type, missing table,
          // helper absent on an older cloud) propagates — never silently swallowed.
          await runAsyncOrSync(this._exec(), `SELECT lattice_member_add_column(?, ?, ?)`, [
            table,
            column,
            typeSpec,
          ]);
        } else {
          await addColumnAsyncOrSync(this._adapter, table, column, typeSpec);
        }
      }
      const cols = await introspectColumnsAsyncOrSync(this._adapter, table);
      this._columnCache.set(table, new Set(cols));
      // Mirror the new column into the registered def so getRegisteredColumns()
      // (which the Teams `share` serialization reads) reflects the post-ALTER
      // state. No-op for an unregistered table (def stays null).
      const def = this._schema.getTables().get(table);
      if (def && !(column in def.columns)) def.columns[column] = typeSpec;
    });
  }

  // -------------------------------------------------------------------------
  // Task context (for relevance filtering)
  // -------------------------------------------------------------------------

  /**
   * Set the current task context string. Tables with a `relevanceFilter`
   * will use this value to filter rows before rendering.
   */
  setTaskContext(context: string): this {
    this._taskContext = context;
    return this;
  }

  /** Return the current task context string. */
  getTaskContext(): string {
    return this._taskContext;
  }

  // -------------------------------------------------------------------------
  // Encryption helpers
  // -------------------------------------------------------------------------

  /**
   * Lazily-constructed column-encryption layer. Field-backed `??= new` getter
   * mirrors `_report`/`_changelog`; the layer defers its scrypt key derivation
   * to the first column registration, so merely touching this getter is cheap.
   */
  private get _encryption(): EncryptionLayer {
    this._encryptionLayer ??= new EncryptionLayer({
      encryptionKeyRaw: this._encryptionKeyRaw,
      getEntityContexts: () => this._schema.getEntityContexts(),
      getTables: () => this._schema.getTables(),
      introspectColumns: (table) => introspectColumnsAsyncOrSync(this._adapter, table),
    });
    return this._encryptionLayer;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Defense-in-depth: validate a table (and any dynamic column) identifier
   * before it is interpolated into a SQL string. The library's threat model is
   * trusted callers, but this guard means a stray/hostile table or column name
   * can never break out of the `"…"` quoting on any CRUD path. Accepts every
   * legitimate identifier (including unregistered/dynamic tables); rejects only
   * names containing quotes, semicolons, whitespace, etc.
   */
  private _assertIdent(table: string, ...cols: string[]): void {
    assertSafeIdentifier(table, 'table');
    for (const c of cols) assertSafeIdentifier(c, 'column');
  }

  async insert(table: string, row: Row, provenance?: ChangeProvenance): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    this._assertRowSize(table, row);
    const { sql, values, pkValue, rowWithPk } = this._prepareInsert(table, row);
    await runAsyncOrSync(this._exec(), sql, values);
    await this._afterInsert(table, pkValue, rowWithPk, provenance);
    return pkValue;
  }

  /**
   * Insert a row while atomically forcing its cloud row-visibility, regardless of
   * the table's `default_row_visibility`. The per-table insert trigger reads a
   * transaction-local GUC (`lattice.force_row_visibility`); we set it and run the
   * INSERT inside a single transaction, so the row is stamped at `visibility` the
   * instant it exists — it is never momentarily visible at the table default, and
   * the change-feed `NOTIFY` (delivered only at COMMIT) fires when the row already
   * carries this visibility. This closes the create-then-demote window that a
   * plain `insert()` + `setRowVisibility()` would leave open.
   *
   * Postgres-only: SQLite is single-user (no cross-viewer leak) and has no trigger
   * to read the GUC, so it degrades to a plain {@link insert}. A `never_share`
   * table still wins — its rows are forced private even if `visibility` is
   * `'everyone'` (the trigger enforces that precedence).
   *
   * @since 3.1.0
   */
  async insertForcingVisibility(
    table: string,
    row: Row,
    visibility: 'private' | 'everyone',
    provenance?: ChangeProvenance,
  ): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    // Defensive against untyped JS callers — the value is parameterized into
    // set_config below, so a bad one can't inject, but reject it explicitly.
    const vis: string = visibility;
    if (vis !== 'private' && vis !== 'everyone') {
      throw new Error(`lattice: invalid forced visibility "${vis}"`);
    }
    const withClient = this._adapter.withClient?.bind(this._adapter);
    if (this.getDialect() !== 'postgres' || !withClient) {
      return this.insert(table, row, provenance);
    }
    const { sql, values, pkValue, rowWithPk } = this._prepareInsert(table, row);
    await withClient(async (tx) => {
      // Transaction-local (third arg = is_local) so it never leaks to another
      // statement on this pooled connection; the trigger that fires for the very
      // next INSERT reads it via current_setting('…', true).
      await tx.run(`SELECT set_config('lattice.force_row_visibility', ?, true)`, [visibility]);
      await tx.run(sql, values);
    });
    await this._afterInsert(table, pkValue, rowWithPk, provenance);
    return pkValue;
  }

  /**
   * Build the INSERT statement + canonical pk for a row (sanitize → schema-filter →
   * auto-pk → encrypt). Shared by {@link insert} and {@link insertForcingVisibility}
   * so both produce byte-identical writes; the latter only differs in running it
   * inside a GUC-scoped transaction.
   */
  private _prepareInsert(
    table: string,
    row: Row,
  ): { sql: string; values: unknown[]; pkValue: string; rowWithPk: Row } {
    this._assertIdent(table);
    this._assertNotComputedTable(table, 'insert');
    const sanitized = this._applyComputedColumns(
      table,
      this._applyConnectedDefaults(
        table,
        this._applyGovernanceDefaults(
          table,
          this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row)),
        ),
      ),
    );
    const pkCols = this._schema.getPrimaryKey(table);
    const isDefaultPk = pkCols.length === 1 && pkCols[0] === 'id';
    // Auto-generate UUID only for the default 'id' PK when the field is absent.
    let rowWithPk: Row;
    if (isDefaultPk) {
      const id = (sanitized.id as string | undefined) ?? uuidv4();
      rowWithPk = { ...sanitized, id };
    } else {
      rowWithPk = sanitized;
    }
    const encrypted = this._encryption.encryptRow(table, rowWithPk);
    const cols = Object.keys(encrypted)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(encrypted)
      .map(() => '?')
      .join(', ');
    const values = Object.values(encrypted);
    // Canonical pk: the full (possibly composite) primary key, so the change-log +
    // row ACL key the row unambiguously. Single-column keys serialize to the bare
    // value (unchanged from prior behaviour).
    const pkValue = this._serializeRowPk(table, rowWithPk);
    return {
      sql: `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`,
      values,
      pkValue,
      rowWithPk,
    };
  }

  /**
   * Stamp governance defaults at insert time: auto-set `ingested_at` for a
   * provenance table (when not supplied) and the default `_trust_state` for a
   * trust table. Returns a shallow copy; a no-op for tables without governance.
   */
  private _applyGovernanceDefaults(table: string, row: Row): Row {
    const provCols = this._provenanceCols.get(table);
    const trustDefault = this._trustDefault.get(table);
    if (!provCols && trustDefault === undefined) return row;
    const out = { ...row };
    if (provCols?.includes('ingested_at') && out.ingested_at == null) {
      out.ingested_at = new Date().toISOString();
    }
    if (trustDefault !== undefined && out._trust_state == null) {
      out._trust_state = trustDefault;
    }
    return out;
  }

  /**
   * Stamp connector defaults at insert time for a connected data type: default
   * `_source_model` from the table's source descriptor and `_source_synced_at`
   * to now, when not already supplied. A no-op for tables without a `source`.
   * The connector sync engine normally sets these explicitly; this is the
   * safety net for a direct insert into a connected table.
   */
  private _applyConnectedDefaults(table: string, row: Row): Row {
    const source = this._connectedSources.get(table);
    if (!source) return row;
    const out = { ...row };
    out._source_model ??= source.model;
    out._source_synced_at ??= new Date().toISOString();
    return out;
  }

  /** The connector source descriptor for a connected data type, or undefined. */
  getConnectedSource(table: string): ConnectorSource | undefined {
    return this._connectedSources.get(table);
  }

  /** Names of all registered connected data types (tables with a `source`). */
  connectedTables(): string[] {
    return [...this._connectedSources.keys()];
  }

  /** Post-insert side effects (changelog, audit, write hooks, embedding sync),
   *  identical for the plain and force-visibility insert paths. */
  private async _afterInsert(
    table: string,
    pkValue: string,
    rowWithPk: Row,
    provenance?: ChangeProvenance,
  ): Promise<void> {
    await this._appendChangelog(
      table,
      pkValue,
      'insert',
      rowWithPk,
      null,
      undefined,
      undefined,
      provenance,
    );
    this._sanitizer.emitAudit(table, 'insert', pkValue);
    await this._fireWriteHooks(table, 'insert', rowWithPk, pkValue);
    this._syncEmbedding(table, 'insert', rowWithPk, pkValue);
    // Derive this row's deterministic computed columns (#10) from its just-written values.
    if (this._computedFieldSql.has(table)) {
      await this._recomputeComputedFieldColumns(table, pkValue, null);
    }
    // If this table feeds a parent rollup, recompute the affected parent.
    if (this._rollupSources.has(table)) await this._propagateRollupsFromRow(table, rowWithPk);
  }

  /**
   * Insert a row and return the full inserted row (including auto-generated
   * fields and defaults). Equivalent to `insert()` followed by `get()`.
   *
   * @since 0.17.0
   */
  insertReturning(table: string, row: Row): Promise<Row> {
    return this.insert(table, row).then((pk) =>
      this.get(table, pk).then((result) => result ?? { ...row, id: pk }),
    );
  }

  async upsert(table: string, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    this._assertIdent(table);
    this._assertNotComputedTable(table, 'upsert');
    this._assertRowSize(table, row);

    // Apply governance + connector-lineage defaults so a direct upsert into a
    // connected/provenance table stamps the same defaults an insert() would
    // (no-op for plain tables).
    const sanitized = this._applyConnectedDefaults(
      table,
      this._applyGovernanceDefaults(
        table,
        this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row)),
      ),
    );
    const pkCols = this._schema.getPrimaryKey(table);
    const isDefaultPk = pkCols.length === 1 && pkCols[0] === 'id';

    let rowWithPk: Row;
    if (isDefaultPk) {
      const id = (sanitized.id as string | undefined) ?? uuidv4();
      rowWithPk = { ...sanitized, id };
    } else {
      rowWithPk = sanitized;
    }

    const encrypted = this._encryption.encryptRow(table, rowWithPk);

    const cols = Object.keys(encrypted)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(encrypted)
      .map(() => '?')
      .join(', ');
    // Conflict target uses all PK columns
    const conflictCols = pkCols.map((c) => `"${c}"`).join(', ');
    // Exclude PK columns AND immutable provenance columns from the UPDATE SET: an
    // upsert against an existing row must NOT rewrite its lineage (P-PROV), just as
    // a plain update() rejects a provenance change — the first-insert provenance is
    // preserved on conflict.
    const keepOnConflict = new Set([
      ...pkCols,
      ...(this._provenanceCols.get(table) ?? []),
      ...(this._connectedSources.has(table) ? IMMUTABLE_CONNECTED_FIELDS : []),
    ]);
    const updateCols = Object.keys(encrypted)
      .filter((c) => !keepOnConflict.has(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ');
    const values = Object.values(encrypted);

    // If every non-PK column is provenance (nothing left to update), the conflict
    // is a no-op rather than an invalid empty SET.
    const onConflict = updateCols
      ? `ON CONFLICT(${conflictCols}) DO UPDATE SET ${updateCols}`
      : `ON CONFLICT(${conflictCols}) DO NOTHING`;
    await runAsyncOrSync(
      this._exec(),
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ${onConflict}`,
      values,
    );

    // Canonical pk (full composite key); single-column keys are the bare value.
    const pkValue = this._serializeRowPk(table, rowWithPk);
    this._sanitizer.emitAudit(table, 'update', pkValue);
    // Fire write hooks so sync / outbox / cache-invalidation subscribers see the
    // upsert (it previously only scheduled an auto-render and silently skipped
    // them). _fireWriteHooks self-schedules the auto-render, so this replaces the
    // explicit call above rather than adding to it.
    await this._fireWriteHooks(table, 'update', rowWithPk, pkValue, Object.keys(sanitized));
    // Derive computed columns. The connector sync + seed bulk-write paths reach the DB
    // through upsert (not insert()/update()), so without this a computed field on a
    // synced/enriched table would never populate. upsert is a full-row write → recompute all.
    await this._deriveComputedAfterWrite(table, pkValue, null);
    return pkValue;
  }

  async upsertBy(table: string, col: string, val: unknown, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    this._assertIdent(table, col);
    this._assertNotComputedTable(table, 'upsertBy');

    const existing = await getAsyncOrSync(
      this._exec(),
      `SELECT * FROM "${table}" WHERE "${col}" = ?`,
      [val],
    );
    if (existing) {
      const pkCols = this._schema.getPrimaryKey(table);
      // pkCols[0] is always defined — validated non-empty in SchemaManager.define()
      const pkLookup: PkLookup =
        pkCols.length === 1
          ? String(existing[pkCols[0] ?? 'id'] as string | number)
          : Object.fromEntries(pkCols.map((c) => [c, existing[c]]));
      await this.update(table, pkLookup, row);
      return typeof pkLookup === 'string' ? pkLookup : JSON.stringify(pkLookup);
    }
    return this.insert(table, { ...row, [col]: val });
  }

  async update(
    table: string,
    id: PkLookup,
    row: Partial<Row>,
    provenance?: ChangeProvenance,
  ): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertIdent(table);
    this._assertNotComputedTable(table, 'update');
    this._assertRowSize(table, row as Row);

    const baseSanitized = this._filterToSchemaColumns(
      table,
      this._sanitizer.sanitizeRow(row as Row),
    );
    // Provenance columns are immutable — reject any update that touches them.
    const provCols = this._provenanceCols.get(table);
    if (provCols) {
      for (const c of provCols) {
        if (c in baseSanitized) throw new ProvenanceImmutableError(table, c);
      }
    }
    // Connector lineage columns are immutable too — a row can't be relabeled to a
    // different connector/model by update() (a re-sync preserves them via upsert).
    if (this._connectedSources.has(table)) {
      for (const c of IMMUTABLE_CONNECTED_FIELDS) {
        if (c in baseSanitized) throw new ConnectedSourceImmutableError(table, c);
      }
    }
    // Recompute any computed columns whose dependencies changed (merges the
    // current row with the changes, then derives the computed values).
    const sanitized = await this._recomputeComputedOnUpdate(table, id, baseSanitized);
    const encrypted = this._encryption.encryptRow(table, sanitized);
    const setCols = Object.keys(encrypted)
      .map((c) => `"${c}" = ?`)
      .join(', ');
    // Every requested column was filtered out as non-schema → nothing to update.
    // A bare `UPDATE "t" SET  WHERE …` is invalid SQL; no-op instead of crashing.
    // (The GUI mutation layer auto-creates unknown columns before calling update,
    // so an assistant's intended data lands; this guards any caller that doesn't.)
    if (setCols === '') return;

    const { clause, params: pkParams } = this._pkWhere(table, id);

    // Capture previous values before the write for changelog
    let previousValues: Record<string, unknown> | null = null;
    if (this._changelogTables.has(table)) {
      const current = await getAsyncOrSync(
        this._exec(),
        `SELECT * FROM "${table}" WHERE ${clause}`,
        pkParams,
      );
      if (current) {
        previousValues = {};
        for (const col of Object.keys(sanitized)) {
          previousValues[col] = current[col];
        }
      }
    }

    const values = [...Object.values(encrypted), ...pkParams];

    await runAsyncOrSync(this._exec(), `UPDATE "${table}" SET ${setCols} WHERE ${clause}`, values);

    // Canonical pk so a row addressed by composite lookup keys its
    // change-log entry the same way insert() keyed it.
    const auditId = this._serializePkLookup(table, id);
    await this._appendChangelog(
      table,
      auditId,
      'update',
      sanitized,
      previousValues,
      undefined,
      undefined,
      provenance,
    );
    this._sanitizer.emitAudit(table, 'update', auditId);
    await this._fireWriteHooks(table, 'update', sanitized, auditId, Object.keys(sanitized));
    // Re-fetch full row for embedding recomputation
    const def = this._schema.getTables().get(table);
    if (def?.embeddings) {
      const fullRow = await getAsyncOrSync(
        this._exec(),
        `SELECT * FROM "${table}" WHERE ${clause}`,
        pkParams,
      );
      if (fullRow) this._syncEmbedding(table, 'update', fullRow, auditId);
    }
    // Re-derive deterministic computed columns (#10) whose dependencies just changed.
    if (this._computedFieldSql.has(table)) {
      await this._recomputeComputedFieldColumns(table, id, new Set(Object.keys(baseSanitized)));
    }
    // Invalidate AI computed cells whose input just changed (NULL now, refill later) — the
    // "never serve stale" contract. The refill is triggered out-of-band by fillComputedFields().
    if (this._aiComputedFields.has(table)) {
      await this._nullStaleAiColumns(table, id, new Set(Object.keys(baseSanitized)));
    }
    // If this table feeds a parent rollup, recompute the affected parent.
    if (this._rollupSources.has(table)) await this._propagateRollups(table, id);
  }

  // -------------------------------------------------------------------------
  // Computed columns + materialized rollups (P-VIEW)
  // -------------------------------------------------------------------------

  /** Compute a table's computed columns from a (full) row, returning the merged row. */
  private _applyComputedColumns(table: string, row: Row): Row {
    const c = this._computed.get(table);
    if (!c) return row;
    return { ...row, ...computeColumns(c.specs, c.order, row) };
  }

  /**
   * On update, if the changed columns include any computed-column dependency,
   * fetch + decrypt the current row, merge the changes, recompute the computed
   * columns, and fold them into the update payload. No-op otherwise.
   */
  private async _recomputeComputedOnUpdate(
    table: string,
    id: PkLookup,
    sanitized: Row,
  ): Promise<Row> {
    const c = this._computed.get(table);
    if (!c) return sanitized;
    const touchesDep = Object.keys(sanitized).some((k) => c.deps.has(k));
    if (!touchesDep) return sanitized;
    const { clause, params } = this._pkWhere(table, id);
    const current = await getAsyncOrSync(
      this._exec(),
      `SELECT * FROM "${table}" WHERE ${clause}`,
      params,
    );
    const merged: Row = {
      ...(current ? this._encryption.decryptRow(table, current) : {}),
      ...sanitized,
    };
    return { ...sanitized, ...computeColumns(c.specs, c.order, merged) };
  }

  /**
   * Recompute the DETERMINISTIC same-row computed columns (#10 alias/calc) for ONE row via
   * a single bounded `UPDATE … WHERE pk` (one row, no scan). Runs AFTER the row
   * is written, so the compiler-emitted SQL expressions read the row's own just-written
   * columns. `changedCols` = the update payload keys (dep-gated recompute); pass `null` for
   * an insert (recompute every computed column on the new row). The SET right-hand sides
   * are compiler-generated SQL over validated, quoted column names — never user input.
   */
  private async _recomputeComputedFieldColumns(
    table: string,
    id: PkLookup,
    changedCols: Set<string> | null,
  ): Promise<void> {
    const fields = this._computedFieldSql.get(table);
    if (!fields || fields.length === 0) return;
    const affected =
      changedCols === null
        ? fields
        : fields.filter((f) => [...f.deps].some((d) => changedCols.has(d)));
    if (affected.length === 0) return;
    const setClause = affected.map((f) => `"${f.column}" = ${f.sql}`).join(', ');
    const { clause, params } = this._pkWhere(table, id);
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${table}" SET ${setClause} WHERE ${clause}`,
      params,
    );
  }

  /**
   * Derive computed columns after a row is written: recompute the deterministic same-row
   * columns and NULL any AI cells whose inputs changed. Called by every write path (insert,
   * update, upsert, the natural-key upsert/enrich the sync + seed engines use) so a computed
   * field is never left unpopulated or stale regardless of HOW the row was written.
   * `changedCols === null` = a full-row write (recompute all + null every AI cell).
   */
  private async _deriveComputedAfterWrite(
    table: string,
    id: PkLookup,
    changedCols: Set<string> | null,
  ): Promise<void> {
    if (this._computedFieldSql.has(table)) {
      await this._recomputeComputedFieldColumns(table, id, changedCols);
    }
    if (this._aiComputedFields.has(table)) {
      await this._nullStaleAiColumns(table, id, changedCols);
    }
  }

  /**
   * NULL the AI computed cells on ONE row whose input columns just changed (one bounded
   * row update, no scan). The "never serve stale" contract: a changed input clears the derived value
   * immediately; {@link fillComputedFields} repopulates it out-of-band. `changedCols === null`
   * NULLs every AI cell on the row (a full-row write, where any input may have changed).
   */
  private async _nullStaleAiColumns(
    table: string,
    id: PkLookup,
    changedCols: Set<string> | null,
  ): Promise<void> {
    const fields = this._aiComputedFields.get(table);
    if (!fields || fields.length === 0) return;
    const stale =
      changedCols === null
        ? fields
        : fields.filter((f) => [...f.deps].some((d) => changedCols.has(d)));
    if (stale.length === 0) return;
    const setClause = stale.map((f) => `"${f.column}" = NULL`).join(', ');
    const { clause, params } = this._pkWhere(table, id);
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${table}" SET ${setClause} WHERE ${clause}`,
      params,
    );
  }

  /**
   * The compiled computed-field plans for a table (all kinds, incl. deferred AI/aggregate) —
   * for the GUI field editor + the fill/refresh machinery. Empty when the table has none.
   */
  getComputedFieldPlans(table: string): CompiledComputedField[] {
    return this._computedFieldPlans.get(table) ?? [];
  }

  /** Whether a table has any AI computed fields awaiting fill. */
  hasAiComputedFields(table: string): boolean {
    return this._aiComputedFields.has(table);
  }

  /**
   * Populate the un-filled (NULL) cells of a table's AI computed fields using the injected
   * {@link FillLlm}. Kept OUT of the write path (no model calls in the core DB layer) — the GUI
   * calls this fire-and-forget after a write and on open (backfill), a test injects a fake LLM.
   * Bounded (scans `WHERE col IS NULL LIMIT n`, skips tombstones). Returns a report;
   * never throws for a per-cell model failure (those are counted + surfaced in the report).
   */
  async fillComputedFields(
    table: string,
    llm: FillLlm,
    opts?: { batchSize?: number; maxRows?: number },
  ): Promise<FieldFillReport> {
    const fields = this._aiComputedFields.get(table);
    if (!fields || fields.length === 0) return { filled: 0, failed: 0, errors: [] };
    const pkCol = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const hasDeletedAt = (this._columnCache.get(table) ?? new Set()).has('deleted_at');
    return fillAiComputedFields(
      this._exec(),
      llm,
      table,
      pkCol,
      fields.map((f) => ({ column: f.column, ai: f.ai })),
      { ...opts, ...(hasDeletedAt ? { liveFilter: '"deleted_at" IS NULL' } : {}) },
    );
  }

  /** Every table that has AI computed fields (for open-time backfill). */
  aiComputedFieldTables(): string[] {
    return [...this._aiComputedFields.keys()];
  }

  /** Recompute parent rollup(s) for the FK values carried on a source row. */
  private async _propagateRollupsFromRow(sourceTable: string, sourceRow: Row): Promise<void> {
    const feeds = this._rollupSources.get(sourceTable);
    if (!feeds) return;
    for (const feed of feeds) {
      const parentId = sourceRow[feed.spec.foreignKey];
      if (typeof parentId !== 'string' && typeof parentId !== 'number') continue;
      await this._recomputeRollupCell(feed.parentTable, feed.name, feed.spec, String(parentId));
    }
  }

  /** Recompute the parent rollup(s) fed by a changed source row (fetched by id). */
  private async _propagateRollups(sourceTable: string, sourceId: PkLookup): Promise<void> {
    if (!this._rollupSources.has(sourceTable)) return;
    const { clause, params } = this._pkWhere(sourceTable, sourceId);
    const src = await getAsyncOrSync(
      this._exec(),
      `SELECT * FROM "${sourceTable}" WHERE ${clause}`,
      params,
    );
    if (src) await this._propagateRollupsFromRow(sourceTable, src);
  }

  /** Recompute a single rollup cell for one parent row. */
  private async _recomputeRollupCell(
    parentTable: string,
    name: string,
    spec: MaterializedRollupSpec,
    parentId: string,
  ): Promise<void> {
    const parentPk = this._schema.getPrimaryKey(parentTable)[0] ?? 'id';
    const cols = await introspectColumnsAsyncOrSync(this._adapter, spec.sourceTable).catch(
      () => [] as string[],
    );
    const srcDeleted = cols.includes('deleted_at') ? ` AND "deleted_at" IS NULL` : '';
    const inner =
      spec.fn === 'count'
        ? 'COUNT(*)'
        : `${spec.fn.toUpperCase()}("${spec.column ?? spec.foreignKey}")`;
    const fallback = spec.fn === 'count' ? '0' : 'NULL';
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${parentTable}" SET "${name}" = COALESCE(
         (SELECT ${inner} FROM "${spec.sourceTable}" WHERE "${spec.foreignKey}" = ?${srcDeleted}), ${fallback})
       WHERE "${parentPk}" = ?`,
      [parentId, parentId],
    );
  }

  /**
   * Recompute all computed columns for every row of a table (a full pass). Use
   * after a bulk import that bypassed the per-row recompute, or after changing a
   * computed definition. Requires `computed` config.
   */
  async refreshComputedColumns(table: string): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    const c = this._computed.get(table);
    if (!c) throw new Error(`Table "${table}" has no computed columns`);
    const pk = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const rows = await this._queryCore.query(table, {});
    let updated = 0;
    for (const row of rows) {
      const values = computeColumns(c.specs, c.order, row);
      const setCols = Object.keys(values)
        .map((col) => `"${col}" = ?`)
        .join(', ');
      if (setCols === '') continue;
      await runAsyncOrSync(this._exec(), `UPDATE "${table}" SET ${setCols} WHERE "${pk}" = ?`, [
        ...Object.values(values),
        row[pk],
      ]);
      updated++;
    }
    return updated;
  }

  /**
   * Recompute all materialized rollups for every row of a table (a full,
   * authoritative pass). Requires `materializedRollups` config.
   */
  async refreshMaterializedRollups(table: string): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    const rollups = this._rollups.get(table);
    if (!rollups) throw new Error(`Table "${table}" has no materialized rollups`);
    const pk = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const parents = await this._queryCore.query(table, { projection: [pk] });
    let updated = 0;
    for (const parent of parents) {
      const parentId = parent[pk];
      if (typeof parentId !== 'string' && typeof parentId !== 'number') continue;
      for (const [name, spec] of Object.entries(rollups)) {
        await this._recomputeRollupCell(table, name, spec, String(parentId));
      }
      updated++;
    }
    return updated;
  }

  /**
   * Update a row and return the full updated row. Equivalent to `update()`
   * followed by `get()`.
   *
   * @since 0.17.0
   */
  updateReturning(table: string, id: PkLookup, row: Partial<Row>): Promise<Row> {
    return this.update(table, id, row).then(() =>
      this.get(table, id).then((result) => result ?? (row as Row)),
    );
  }

  /**
   * Permanently delete a row via `DELETE FROM`. This is a **hard delete** —
   * the row is removed from the table, not soft-deleted via a `deleted_at` column.
   *
   * On tables with `changelog: true`, the full previous row is captured and
   * appended to the changelog before removal, making the delete auditable and
   * recoverable via {@link rollback}. On tables without a changelog, the row
   * is gone permanently.
   *
   * Side effects:
   * - If the table has materialized rollups fed by child rows, a deleted child
   *   is removed from its parent's rollup aggregates.
   * - Write hooks and audit events are fired.
   * - Embeddings are synced (if the table has embedding definitions).
   */
  async delete(table: string, id: PkLookup, provenance?: ChangeProvenance): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertIdent(table);
    this._assertNotComputedTable(table, 'delete');

    const { clause, params } = this._pkWhere(table, id);

    // Capture full row before deletion for changelog and/or rollup propagation
    // (a deleted child must be removed from its parent's rollup, which needs the
    // child's FK that's about to be gone).
    let previousRow: Row | null = null;
    if (this._changelogTables.has(table) || this._rollupSources.has(table)) {
      previousRow =
        (await getAsyncOrSync(this._exec(), `SELECT * FROM "${table}" WHERE ${clause}`, params)) ??
        null;
    }

    await runAsyncOrSync(this._exec(), `DELETE FROM "${table}" WHERE ${clause}`, params);
    if (previousRow && this._rollupSources.has(table)) {
      await this._propagateRollupsFromRow(table, previousRow);
    }

    // Canonical pk so a row addressed by composite lookup keys its
    // change-log entry the same way insert() keyed it.
    const auditId = this._serializePkLookup(table, id);
    await this._appendChangelog(
      table,
      auditId,
      'delete',
      null,
      previousRow as Record<string, unknown> | null,
      undefined,
      undefined,
      provenance,
    );
    this._sanitizer.emitAudit(table, 'delete', auditId);
    await this._fireWriteHooks(table, 'delete', { id: auditId }, auditId);
    this._syncEmbedding(table, 'delete', {}, auditId);
  }

  /**
   * Record a DERIVED observation about a row WITHOUT mutating the canonical row.
   * The canonical row stays broadly-visible ground truth; the observation carries
   * its provenance (the source-set it was derived from) and is folded into a
   * per-viewer entity at read time by {@link foldForViewer} — visible only to a
   * viewer who can reach every one of its sources. This is how an AI enrichment
   * lands a per-viewer value without leaking it into the shared row, and without
   * moving the row's `updated_at` (so a viewer who can't see the source can't even
   * detect that the enrichment exists). `changes` maps column → derived value.
   */
  /** Ensure the observation substrate (`__lattice_changelog`) exists. Cloud setup
   *  calls this before `enableChangelogRls` so the table is present to secure
   *  even if nothing has written an observation yet. Idempotent. */
  async ensureObservationSubstrate(): Promise<void> {
    await this._ensureChangelogTable();
  }

  async observe(
    table: string,
    id: PkLookup,
    changes: Record<string, unknown>,
    provenance?: ChangeProvenance,
    opts?: { keyStore?: SourceKeyStore },
  ): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertIdent(table);
    await this._ensureChangelogTable();
    const prov: ChangeProvenance = { changeKind: 'derived', ...provenance };
    // Crypto-shred: when the observation is derived from a source flagged
    // sensitive and a key store is provided, SEAL each string value under that
    // single source's key. The change-log then holds only ciphertext; destroying
    // the source's key (shredSource) makes the value unrecoverable everywhere the
    // ciphertext exists — the durable, backup-proof half of "forget this source".
    let toWrite = changes;
    const keyStore = opts?.keyStore;
    const sources = prov.sourceRef == null ? [] : ([] as string[]).concat(prov.sourceRef);
    const sealSource = sources.length === 1 ? sources[0] : undefined;
    if (keyStore && prov.sourceSensitive && sealSource !== undefined) {
      toWrite = Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [
          k,
          typeof v === 'string' ? sealUnderSource(v, sealSource, keyStore) : v,
        ]),
      );
    }
    const auditId = this._serializePkLookup(table, id);
    await this._writeChangelogRow(
      table,
      auditId,
      'update',
      toWrite,
      null,
      'observation',
      undefined,
      prov,
    );
  }

  /**
   * Compile the per-viewer view of a row: the ground-truth canonical row with the
   * DERIVED observations the viewer is allowed to see folded on top (latest
   * audience-visible observation per attribute wins). A derived value is visible
   * only when the viewer can reach every source it came from, so un-sharing a
   * source reverts the value with no residue. `visibleSources` is the set of
   * source ids the viewer can see; omit it (or pass `'all'`) for the local
   * single-user case where you see everything. Returns null if the row is absent.
   */
  async foldForViewer(
    table: string,
    id: PkLookup,
    opts?: { visibleSources?: Iterable<string> | 'all'; keyStore?: SourceKeyStore },
  ): Promise<Row | null> {
    const ground = await this.get(table, id);
    if (!ground) return null;
    const auditId = this._serializePkLookup(table, id);
    // Do NOT create the substrate here: a scoped cloud member (who has no DDL
    // right) must be able to fold. If the change-log doesn't exist yet there are
    // simply no observations, so return ground truth.
    if (!(await this._changelogTableExists())) return ground;
    const history = await this.history(table, auditId);
    const observations: Observation[] = [];
    for (const h of history) {
      if (h.changeKind !== 'derived') continue;
      const sources = h.sourceRef ?? null;
      const opened = this._openSealedObservation(h.changes, sources, opts?.keyStore);
      // A null result means a sealed value could not be opened — its source was
      // crypto-shredded — so the observation is dropped and the attribute reverts
      // to ground truth (or the prior visible observation), with no residue.
      if (opened === null) continue;
      observations.push(
        ...observationsFromChange({
          changes: opened,
          createdAt: h.createdAt,
          changeKind: 'derived',
          sourceRef: sources,
        }),
      );
    }
    const vs = opts?.visibleSources;
    const visibleSources =
      vs === undefined || vs === 'all'
        ? new Set(observations.flatMap((o) => [...(o.sourceRef ?? [])]))
        : new Set(vs);
    return foldEntity(ground, observations, { visibleSources });
  }

  /** Open any crypto-sealed values in a derived observation's `changes`. Returns
   *  the plaintext changes, or `null` if a sealed value can't be opened because
   *  its source's key was shredded (the value is gone for good). Values that
   *  aren't sealed pass through; with no key store, sealed values can't be read,
   *  so the observation is dropped (returns null). */
  private _openSealedObservation(
    changes: Record<string, unknown> | null,
    sources: readonly string[] | null,
    keyStore?: SourceKeyStore,
  ): Record<string, unknown> | null {
    if (!changes) return changes;
    const sealed = Object.values(changes).some((v) => typeof v === 'string' && isEncrypted(v));
    if (!sealed) return changes;
    let sourceId: string | undefined;
    if (sources?.length === 1) sourceId = sources[0];
    if (!keyStore || sourceId === undefined) return null;
    try {
      return Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [
          k,
          typeof v === 'string' && isEncrypted(v) ? openUnderSource(v, sourceId, keyStore) : v,
        ]),
      );
    } catch (e) {
      if (e instanceof SourceShreddedError) return null; // shredded → unrecoverable → revert
      throw e;
    }
  }

  async get(table: string, id: PkLookup): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;
    return this._queryCore.get(table, id);
  }

  // -------------------------------------------------------------------------
  // Generic CRUD — works on ANY table (v0.11+)
  // -------------------------------------------------------------------------

  /**
   * Upsert a record by natural key. If a non-deleted record with the given
   * natural key exists, update it. Otherwise insert with a new UUID.
   * Auto-handles `org_id`, `updated_at`, `deleted_at`, `source_file`, `source_hash`.
   */
  async upsertByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
    data: Row,
    opts?: import('./types.js').UpsertByNaturalKeyOptions,
  ): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    this._assertIdent(table, naturalKeyCol);
    this._assertNotComputedTable(table, 'upsertByNaturalKey');

    const cols = this._ensureColumnCache(table);
    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(data));

    // Auto-set convention columns
    const withConventions = { ...sanitized };
    if (cols.has('updated_at')) withConventions.updated_at = new Date().toISOString();
    if (opts?.sourceFile && cols.has('source_file')) withConventions.source_file = opts.sourceFile;
    if (opts?.sourceHash && cols.has('source_hash')) withConventions.source_hash = opts.sourceHash;

    // Check if record exists
    const existing = await getAsyncOrSync(
      this._exec(),
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND deleted_at IS NULL`,
      [naturalKeyVal],
    );

    if (existing) {
      // Update existing
      const encUpdated = this._encryption.encryptRow(table, withConventions);
      const entries = Object.entries(encUpdated).filter(([k]) => k !== 'id');
      if (entries.length === 0) return existing.id as string;
      const setCols = entries.map(([k]) => `"${k}" = ?`).join(', ');
      await runAsyncOrSync(this._exec(), `UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
        ...entries.map(([, v]) => v),
        existing.id,
      ]);
      await this._fireWriteHooks(
        table,
        'update',
        withConventions,
        existing.id as string,
        Object.keys(sanitized),
      );
      await this._deriveComputedAfterWrite(
        table,
        existing.id as string,
        new Set(Object.keys(sanitized)),
      );
      return existing.id as string;
    }

    // Insert new
    const id = (sanitized.id as string | undefined) ?? uuidv4();
    const insertData: Row = { ...withConventions, id, [naturalKeyCol]: naturalKeyVal };
    if (opts?.orgId && cols.has('org_id') && !insertData.org_id) insertData.org_id = opts.orgId;
    if (cols.has('deleted_at')) insertData.deleted_at = null;
    if (cols.has('created_at') && !insertData.created_at)
      insertData.created_at = new Date().toISOString();

    const filtered = this._filterToSchemaColumns(table, insertData);
    const encInserted = this._encryption.encryptRow(table, filtered);
    const colNames = Object.keys(encInserted)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(encInserted)
      .map(() => '?')
      .join(', ');
    await runAsyncOrSync(
      this._exec(),
      `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
      Object.values(encInserted),
    );
    await this._fireWriteHooks(table, 'insert', filtered, id);
    await this._deriveComputedAfterWrite(table, id, null); // full-row insert → recompute all
    return id;
  }

  /**
   * Sparse update by natural key — only writes non-null fields on an existing record.
   * Returns true if a row was found and updated.
   */
  async enrichByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
    data: Row,
  ): Promise<boolean> {
    const notInit = this._notInitError<boolean>();
    if (notInit) return notInit;
    this._assertIdent(table, naturalKeyCol);
    this._assertNotComputedTable(table, 'enrichByNaturalKey');

    const existing = await getAsyncOrSync(
      this._exec(),
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND deleted_at IS NULL`,
      [naturalKeyVal],
    );
    if (!existing) return false;

    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(data));
    const entries = Object.entries(sanitized).filter(
      ([k, v]) => v !== null && v !== undefined && k !== 'id',
    );
    if (entries.length === 0) return true;

    const cols = this._ensureColumnCache(table);
    const withTs = [...entries];
    if (cols.has('updated_at')) withTs.push(['updated_at', new Date().toISOString()]);

    const setCols = withTs.map(([k]) => `"${k}" = ?`).join(', ');
    await runAsyncOrSync(this._exec(), `UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
      ...withTs.map(([, v]) => v),
      existing.id,
    ]);
    await this._fireWriteHooks(
      table,
      'update',
      Object.fromEntries(entries),
      existing.id as string,
      entries.map(([k]) => k),
    );
    await this._deriveComputedAfterWrite(
      table,
      existing.id as string,
      new Set(entries.map(([k]) => k)),
    );
    return true;
  }

  /**
   * Soft-delete records from a source file whose natural key is NOT in the given set.
   * Returns count of rows soft-deleted.
   */
  async softDeleteMissing(
    table: string,
    naturalKeyCol: string,
    sourceFile: string,
    currentKeys: string[],
  ): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    this._assertIdent(table, naturalKeyCol);
    this._assertNotComputedTable(table, 'softDeleteMissing');

    if (currentKeys.length === 0) return 0;

    // Count rows that will be soft-deleted
    const placeholders = currentKeys.map(() => '?').join(', ');
    const countRow = await getAsyncOrSync(
      this._exec(),
      `SELECT COUNT(*) as cnt FROM "${table}"
       WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
       AND deleted_at IS NULL`,
      [sourceFile, ...currentKeys],
    );
    // Postgres returns COUNT(*) as a string; SQLite returns a number. Coerce
    // so the public Promise<number> contract holds across dialects.
    const count = Number(countRow?.cnt ?? 0);

    if (count > 0) {
      await runAsyncOrSync(
        this._exec(),
        `UPDATE "${table}" SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
         AND deleted_at IS NULL`,
        [sourceFile, ...currentKeys],
      );
    }
    return count;
  }

  /**
   * Get all non-deleted rows from a table, ordered by the given column.
   * Works on any table, not just defined ones.
   */
  async getActive(table: string, orderBy = 'name', opts: PageOptions = {}): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;
    return this._queryCore.getActive(table, orderBy, opts);
  }

  /**
   * Count non-deleted rows in a table.
   */
  async countActive(table: string): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    return this._queryCore.countActive(table);
  }

  /**
   * Lookup a single row by natural key (non-deleted).
   */
  async getByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
  ): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;
    return this._queryCore.getByNaturalKey(table, naturalKeyCol, naturalKeyVal);
  }

  /**
   * Insert a row into a junction table. Uses INSERT OR IGNORE by default
   * (idempotent). Pass `{ upsert: true }` for INSERT OR REPLACE.
   */
  async link(
    junctionTable: string,
    data: Row,
    opts?: import('./types.js').LinkOptions,
  ): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;
    this._assertNotComputedTable(junctionTable, 'link');

    const filtered = this._filterToSchemaColumns(junctionTable, data);
    const colNames = Object.keys(filtered)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(filtered)
      .map(() => '?')
      .join(', ');
    const verb = opts?.upsert ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
    await runAsyncOrSync(
      this._exec(),
      `${verb} INTO "${junctionTable}" (${colNames}) VALUES (${placeholders})`,
      Object.values(filtered),
    );
    // Relation rollups (e.g. PROJECTS.md / FILES.md) are link-driven — refresh
    // every entity context that sources THROUGH this junction (manyToMany).
    this._autoRender.schedule(junctionTable);
  }

  /**
   * Delete rows from a junction table matching all given conditions.
   */
  async unlink(junctionTable: string, conditions: Row): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;
    this._assertNotComputedTable(junctionTable, 'unlink');

    const entries = Object.entries(conditions);
    if (entries.length === 0) return;
    const where = entries.map(([k]) => `"${k}" = ?`).join(' AND ');
    await runAsyncOrSync(
      this._exec(),
      `DELETE FROM "${junctionTable}" WHERE ${where}`,
      entries.map(([, v]) => v),
    );
    this._autoRender.schedule(junctionTable);
  }

  // -------------------------------------------------------------------------
  // Seeding DSL (v0.13+)
  // -------------------------------------------------------------------------

  /**
   * Seed records from structured data (e.g., loaded from YAML/JSON).
   * Upserts each record by natural key, links to entities via junction tables,
   * and optionally soft-deletes records no longer in the data set.
   */
  async seed(config: SeedConfig): Promise<SeedResult> {
    const notInit = this._notInitError<SeedResult>();
    if (notInit) return notInit;

    return this._seed.seed(config);
  }

  /** Lazily-constructed seeding collaborator (see src/crud/seed-engine.ts). */
  private get _seed(): SeedEngine {
    this._seedEngine ??= new SeedEngine({
      adapter: this._adapter,
      upsertByNaturalKey: (t, c, v, d, o) => this.upsertByNaturalKey(t, c, v, d, o),
      link: (j, d, o) => this.link(j, d, o),
      softDeleteMissing: (t, c, f, k) => this.softDeleteMissing(t, c, f, k),
      inferFk: (t) => this._inferFk(t),
    });
    return this._seedEngine;
  }

  /** Infer FK column name from table name (e.g., 'rule' → 'rule_id'). */
  private _inferFk(table: string): string {
    return `${table}_id`;
  }

  // -------------------------------------------------------------------------
  // Report framework (v0.14+)
  // -------------------------------------------------------------------------

  /**
   * Build a report by querying data from tables within a time window.
   * Each section runs a filtered query and formats the results.
   */
  async buildReport(config: ReportConfig): Promise<ReportResult> {
    const notInit = this._notInitError<ReportResult>();
    if (notInit) return notInit;

    return this._report.buildReport(config);
  }

  /** Lazily-constructed report-generation collaborator (see src/report/builder.ts). */
  private get _report(): ReportBuilder {
    this._reportBuilder ??= new ReportBuilder({
      adapter: this._adapter,
      ensureColumnCache: (table) => this._ensureColumnCache(table),
    });
    return this._reportBuilder;
  }

  /** Lazily-constructed generic-read collaborator (see src/query/core.ts). The
   *  decrypt deps are wired through `_encryption`, so the query/get decryption
   *  asymmetry is preserved: only query/get invoke them. */
  private get _queryCore(): QueryCore {
    this._queryCoreInstance ??= new QueryCore({
      // Resolve the adapter per-access so reads honor the ambient transaction:
      // inside `transaction(fn)`, `_exec()` is the tx connection (read-your-writes
      // — e.g. createRow re-reads the row it just inserted for its audit snapshot);
      // outside one it is the base adapter, so this forwards transparently. Methods
      // are bound to the resolved adapter so their internal `this` stays correct.
      adapter: new Proxy({} as StorageAdapter, {
        get: (_t, prop): unknown => {
          const real = this._exec();
          const val: unknown = Reflect.get(real, prop, real);
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(real) : val;
        },
      }),
      assertIdent: (table, ...cols) => {
        this._assertIdent(table, ...cols);
      },
      ensureColumnCache: (table) => this._ensureColumnCache(table),
      pkWhere: (table, id) => this._pkWhere(table, id),
      invalidColumnError: <T>(table: string, cols: string[]) =>
        this._invalidColumnError<T>(table, cols),
      decryptRow: (table, row) => this._encryption.decryptRow(table, row),
      decryptRows: (table, rows) => this._encryption.decryptRows(table, rows),
      defaultMaxRows: this._defaultMaxRows,
    });
    return this._queryCoreInstance;
  }

  /** Optional host-supplied replacement for the pre-render reverse-sync drain. */
  private _autoRenderDrainOverride: ((outputDir: string) => Promise<void>) | null = null;

  /**
   * Route non-error render notices (e.g. an edited generated rollup being
   * restored) somewhere visible. Default: console.warn. The GUI wires its
   * activity feed here.
   */
  setRenderNoticeHandler(handler: ((message: string) => void) | null): void {
    this._render.setNoticeHandler(handler);
  }

  /**
   * Replace the pre-render manual-edit drain (see the auto-render scheduler's
   * drain dep). The GUI wires its file-loopback watcher here so drained edits go
   * through the full mutation path (changelog + activity feed + undo) instead of
   * the core changelog-only apply.
   */
  setAutoRenderDrain(drain: ((outputDir: string) => Promise<void>) | null): void {
    this._autoRenderDrainOverride = drain;
  }

  /** Lazily-constructed auto-render scheduler (see src/render/auto-render.ts). */
  private get _autoRender(): AutoRenderScheduler {
    this._autoRenderScheduler ??= new AutoRenderScheduler({
      render: (dir, opts) => this._render.render(dir, opts),
      cleanup: (dir, prev, opts, next) => this._render.cleanup(dir, prev, opts, next),
      readManifest,
      emitRender: (r) => {
        for (const h of this._renderHandlers) h(r);
      },
      emitError: (e) => {
        for (const h of this._errorHandlers) h(e);
      },
      isInitialized: () => this._initialized,
      // Drain manual file edits into the DB (changelog-versioned, marked
      // file-edit) before every auto/background render — see the dep's doc. A
      // host can override with a richer pass (the GUI wires its file-loopback
      // watcher here so drained edits also carry the feed + undo trail).
      drain: async (dir) => {
        if (this._autoRenderDrainOverride) {
          await this._autoRenderDrainOverride(dir);
          return;
        }
        await this.reverseSyncFromFiles(dir, {
          useDefault: true,
          apply: async (u) => {
            await this.update(u.table, u.pk, u.set, { reason: 'file-edit' });
          },
        });
      },
    });
    return this._autoRenderScheduler;
  }

  // -------------------------------------------------------------------------
  // Reward tracking
  // -------------------------------------------------------------------------

  /**
   * Update reward scores for a row. The total reward is recalculated as
   * the running average across all reward calls. Requires `rewardTracking`
   * on the table definition.
   */
  async reward(
    table: string,
    id: PkLookup,
    scores: import('./types.js').RewardScores,
  ): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;

    const def = this._schema.getTables().get(table);
    if (!def?.rewardTracking) {
      throw new Error(`Table "${table}" does not have rewardTracking enabled`);
    }

    // Compute the average of provided dimension scores
    const vals = Object.values(scores);
    if (vals.length === 0) return;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

    const { clause, params: pkParams } = this._pkWhere(table, id);
    // Incremental running average: new_total = (old_total * old_count + avg) / (old_count + 1)
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${table}" SET "_reward_total" = ("_reward_total" * "_reward_count" + ?) / ("_reward_count" + 1), "_reward_count" = "_reward_count" + 1 WHERE ${clause}`,
      [avg, ...pkParams],
    );
  }

  // -------------------------------------------------------------------------
  // Semantic search
  // -------------------------------------------------------------------------

  /**
   * Search for rows by semantic similarity. Requires `embeddings` config
   * on the table definition.
   *
   * @param table  - Table to search
   * @param query  - Natural-language query text
   * @param opts   - Search options (topK, minScore)
   * @returns Matching rows with similarity scores, sorted best-first.
   */
  async search(table: string, query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const notInit = this._notInitError<SearchResult[]>();
    if (notInit) return notInit;

    const def = this._schema.getTables().get(table);
    if (!def?.embeddings) {
      return Promise.reject(new Error(`Table "${table}" does not have embeddings configured`));
    }

    const pkCol = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const topK = opts.topK ?? 10;
    const embCfg = def.embeddings;
    // With a reranker, retrieve a larger pool, rerank it, then slice to topK.
    const pool = opts.reranker ? (opts.rerankPoolSize ?? Math.max(topK * 4, 20)) : topK;
    const results = await searchByEmbedding(
      this._adapter,
      table,
      query,
      embCfg,
      pool,
      opts.minScore ?? 0,
      pkCol,
      this.isCloudMemberOpen(),
      opts.efSearch,
    );
    if (!opts.reranker) return results;

    const candidates = results.map((r) => ({
      id: String(r.row[pkCol]),
      content: r.matchedContent ?? concatRowText(r.row, embCfg.fields),
      result: r,
    }));
    const { order, applied } = await applyReranker(query, candidates, opts.reranker);
    const ordered = applied ? order.map((c) => c.result) : results;
    return ordered.slice(0, topK);
  }

  /**
   * Hybrid search — fuse semantic (vector) and full-text retrieval with
   * Reciprocal Rank Fusion, with optional deterministic ranking signals
   * (recency / reward / custom) and an optional reranker. Returns fused results
   * with a per-result score breakdown (`explain`). The vector arm is enabled
   * when the table has `embeddings` config; otherwise it is full-text only.
   */
  async hybridSearch(
    table: string,
    query: string,
    opts: Omit<HybridSearchOptions, 'embeddingsConfig' | 'pkColumn'> = {},
  ): Promise<HybridSearchResult[]> {
    const notInit = this._notInitError<HybridSearchResult[]>();
    if (notInit) return notInit;
    const def = this._schema.getTables().get(table);
    const pkCol = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const merged: HybridSearchOptions = { ...opts, pkColumn: pkCol };
    if (def?.embeddings) merged.embeddingsConfig = def.embeddings;
    merged.isCloudMember = this.isCloudMemberOpen();
    return hybridSearch(this._adapter, table, query, merged);
  }

  /**
   * Backfill / re-embed a table's vectors incrementally — embed only rows that
   * are missing, model-stale, or changed since a timestamp, sweeping embeddings
   * whose source row is gone. Honors `deleted_at`. Requires `embeddings` config.
   */
  async refreshEmbeddings(
    table: string,
    opts: RefreshEmbeddingsOptions = {},
  ): Promise<EmbeddingRefreshResult> {
    const notInit = this._notInitError<EmbeddingRefreshResult>();
    if (notInit) return notInit;
    const def = this._schema.getTables().get(table);
    if (!def?.embeddings) {
      return Promise.reject(new Error(`Table "${table}" does not have embeddings configured`));
    }
    const pkCol = this._schema.getPrimaryKey(table)[0] ?? 'id';
    return refreshEmbeddings(this._adapter, table, def.embeddings, pkCol, opts);
  }

  /**
   * Build (or rebuild) a native vector index (pgvector / sqlite-vec) for `table`
   * from the stored embeddings, so semantic search uses an indexed
   * approximate-nearest-neighbor lookup instead of an in-process scan. Returns
   * the number of vectors indexed; a no-op (returns 0) when no native vector
   * extension is available, unless `requireExtension` is set. Requires
   * `embeddings` config (to determine the vector dimension).
   */
  async buildVectorIndex(table: string, requireExtension = false): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    const def = this._schema.getTables().get(table);
    if (!def?.embeddings) {
      return Promise.reject(new Error(`Table "${table}" does not have embeddings configured`));
    }
    // Determine the dimension from a stored vector.
    const sample = await getAsyncOrSync(
      this._exec(),
      `SELECT "vec_dim" AS d FROM "_lattice_embeddings" WHERE "table_name" = ? AND "vec_dim" IS NOT NULL LIMIT 1`,
      [table],
    );
    const dim = Number(sample?.d ?? 0);
    if (dim <= 0) {
      return Promise.reject(
        new Error(
          `buildVectorIndex: no embeddings stored for "${table}" — embed rows first (insert or refreshEmbeddings).`,
        ),
      );
    }
    return buildVectorIndex(this._adapter, table, dim, requireExtension, def.embeddings.index);
  }

  // -------------------------------------------------------------------------
  // Retrieval evaluation + health (measurable, monitorable retrieval quality)
  // -------------------------------------------------------------------------

  /**
   * Evaluate a retriever against a labeled query set, returning the standard IR
   * metrics (P@k / Recall@k / MRR / nDCG@k / MAP). The retriever is any
   * `(query) => rankedRowIds` function, so this grades semantic search,
   * full-text search, a hybrid fusion, or an external service — and can gate
   * retrieval-quality regressions in CI.
   */
  async evaluateRetrieval(
    queries: EvalQuery[],
    retriever: Retriever,
    opts: RetrievalEvalOptions = {},
  ): Promise<RetrievalEvalSummary> {
    const notInit = this._notInitError<RetrievalEvalSummary>();
    if (notInit) return notInit;
    return evaluateRetrieval(queries, retriever, opts);
  }

  /**
   * Diagnose the database's retrieval health: extension availability plus
   * per-table full-text and embedding coverage, with gaps/staleness surfaced as
   * severity-ranked issues. Read-only. When `tables` is omitted, the expectations
   * are derived from each registered table's `fts` / `embeddings` config.
   */
  async diagnoseRetrieval(
    opts: { tables?: RetrievalHealthSpec[] } = {},
  ): Promise<RetrievalHealthReport> {
    const notInit = this._notInitError<RetrievalHealthReport>();
    if (notInit) return notInit;
    const specs =
      opts.tables ??
      [...this._schema.getTables().entries()]
        .filter(([, def]) => Boolean(def.fts) || Boolean(def.embeddings))
        .map(([table, def]) => ({
          table,
          expectFts: !!def.fts,
          expectEmbeddings: !!def.embeddings,
        }));
    return diagnoseRetrieval(this._adapter, { tables: specs });
  }

  /**
   * Run the reproducible retrieval benchmark against this connection and return
   * latency percentiles + ingest throughput. Default scale is small (CI-fast);
   * pass `scale` (or set LATTICE_BENCH_* env vars) to reproduce large-n numbers.
   */
  async benchmarkRetrieval(opts: BenchmarkOptions = {}): Promise<BenchmarkReport> {
    const notInit = this._notInitError<BenchmarkReport>();
    if (notInit) return notInit;
    return benchmarkRetrieval(this._adapter, opts);
  }

  async query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;
    const rows = await this._queryCore.query(table, opts);
    if (opts.include && opts.include.length > 0) {
      await this._expandRelations(table, rows, opts.include);
    }
    return rows;
  }

  /**
   * Keyset (cursor) pagination — stable, index-friendly paging that stays fast
   * arbitrarily deep into a result set (unlike OFFSET, which scans-and-discards).
   * Returns a page plus an opaque `nextCursor` (null on the last page).
   */
  async queryPage(table: string, opts: QueryPageOptions = {}): Promise<QueryPageResult> {
    const notInit = this._notInitError<QueryPageResult>();
    if (notInit) return notInit;
    const pkCols = this._schema.getPrimaryKey(table);
    return this._queryCore.queryPage(table, opts, pkCols.length > 0 ? pkCols : ['id']);
  }

  /**
   * Attach declared relations to each row in `rows` (mutates in place). Each
   * relation is fetched in ONE batched `IN (...)` query — no N+1. `belongsTo`
   * attaches a single row (or null); `hasMany` attaches an array.
   */
  private async _expandRelations(table: string, rows: Row[], includes: string[]): Promise<void> {
    if (rows.length === 0) return;
    const def = this._schema.getTables().get(table);
    const relations = def?.relations;
    for (const name of includes) {
      const rel = relations?.[name];
      if (!rel) {
        throw new Error(`include: "${name}" is not a declared relation on "${table}"`);
      }
      if (rel.type === 'belongsTo') {
        const fkCol = rel.foreignKey;
        const refCol = rel.references ?? this._schema.getPrimaryKey(rel.table)[0] ?? 'id';
        const fks = [...new Set(rows.map((r) => r[fkCol]).filter((v) => v != null))];
        if (fks.length === 0) {
          for (const r of rows) r[name] = null;
          continue;
        }
        const related = await this._queryCore.query(rel.table, {
          filters: [{ col: refCol, op: 'in', val: fks }],
        });
        const byKey = new Map(related.map((r) => [String(r[refCol]), r]));
        for (const r of rows) r[name] = byKey.get(String(r[fkCol])) ?? null;
      } else {
        // hasMany: the related table holds the FK back to this table.
        const fkCol = rel.foreignKey;
        const refCol = rel.references ?? this._schema.getPrimaryKey(table)[0] ?? 'id';
        const keys = [...new Set(rows.map((r) => r[refCol]).filter((v) => v != null))];
        if (keys.length === 0) {
          for (const r of rows) r[name] = [];
          continue;
        }
        const related = await this._queryCore.query(rel.table, {
          filters: [{ col: fkCol, op: 'in', val: keys }],
        });
        const grouped = new Map<string, Row[]>();
        for (const rr of related) {
          const k = String(rr[fkCol]);
          const arr = grouped.get(k);
          if (arr) arr.push(rr);
          else grouped.set(k, [rr]);
        }
        for (const r of rows) r[name] = grouped.get(String(r[refCol])) ?? [];
      }
    }
  }

  async count(table: string, opts: CountOptions = {}): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    return this._queryCore.count(table, opts);
  }

  /**
   * Bounded variant of {@link count}: stops after `opts.cap + 1` matching rows
   * (default cap 1000) so it stays cheap on large tables. Returns the exact count
   * when `<= cap`, else `cap + 1` to signal "more than cap" (render as "cap+").
   */
  async boundedCount(table: string, opts: BoundedCountOptions = {}): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    return this._queryCore.boundedCount(table, opts);
  }

  /**
   * SQL-side aggregation — `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` with optional
   * `GROUP BY` and `HAVING`, computed in the database so only the grouped result
   * rows transfer (never the underlying rows). Returns one object per group with
   * the groupBy columns and each aggregate under its `as` key.
   *
   * @example
   * ```ts
   * await db.aggregate('orders', {
   *   groupBy: ['status'],
   *   aggregates: [{ fn: 'count', as: 'n' }, { fn: 'sum', col: 'total', as: 'revenue' }],
   *   having: [{ aggregate: 'n', op: 'gt', val: 10 }],
   *   orderBy: 'revenue', orderDir: 'desc',
   * });
   * ```
   */
  async aggregate(table: string, opts: AggregateOptions): Promise<AggregateResult[]> {
    const notInit = this._notInitError<AggregateResult[]>();
    if (notInit) return notInit;
    return this._queryCore.aggregate(table, opts);
  }

  // -------------------------------------------------------------------------
  // Trust / verification workflow (governance: P-TRUST)
  // -------------------------------------------------------------------------

  private _assertTrust(table: string): void {
    if (!this._trustDefault.has(table)) {
      throw new Error(`Table "${table}" does not have trust configured`);
    }
  }

  /**
   * Mark a row `verified` — sets `_trust_state='verified'`, `_verified_by`, and
   * `_verified_at` (now). Requires `trust` config on the table.
   */
  async verifyRow(table: string, id: PkLookup, verifiedBy?: string): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertTrust(table);
    const { clause, params } = this._pkWhere(table, id);
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${table}" SET "_trust_state" = 'verified', "_verified_by" = ?, "_verified_at" = ?, "_review_reason" = NULL WHERE ${clause}`,
      [verifiedBy ?? null, new Date().toISOString(), ...params],
    );
  }

  /**
   * Flag a row for human review — sets `_trust_state='needs_review'` and an
   * optional `_review_reason`. Requires `trust` config on the table.
   */
  async markRowForReview(table: string, id: PkLookup, reason?: string): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertTrust(table);
    const { clause, params } = this._pkWhere(table, id);
    await runAsyncOrSync(
      this._exec(),
      `UPDATE "${table}" SET "_trust_state" = 'needs_review', "_review_reason" = ? WHERE ${clause}`,
      [reason ?? null, ...params],
    );
  }

  /** Rows currently in `needs_review` state (non-deleted). Requires `trust` config. */
  async rowsNeedingReview(table: string): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;
    this._assertTrust(table);
    return this._queryCore.query(table, {
      filters: [{ col: '_trust_state', op: 'eq', val: 'needs_review' }],
    });
  }

  /** Rows currently in `verified` state (non-deleted). Requires `trust` config. */
  async verifiedRows(table: string): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;
    this._assertTrust(table);
    return this._queryCore.query(table, {
      filters: [{ col: '_trust_state', op: 'eq', val: 'verified' }],
    });
  }

  // -------------------------------------------------------------------------
  // Graph-augmented retrieval (P-GRAPH)
  // -------------------------------------------------------------------------

  /** Add (upsert) a typed edge between two rows. */
  async addEdge(edge: GraphEdge): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    return addEdge(this._adapter, edge);
  }

  /** Add (upsert) many typed edges. */
  async addEdges(edges: GraphEdge[]): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    return addEdges(this._adapter, edges);
  }

  /** Remove an edge (all types between the pair when `type` omitted). */
  async removeEdge(edge: Omit<GraphEdge, 'weight' | 'type'> & { type?: string }): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    return removeEdge(this._adapter, edge);
  }

  /** Direct neighbors (one hop) of a node. */
  async neighbors(
    node: GraphNode,
    opts: { direction?: TraversalDirection; edgeTypes?: string[] } = {},
  ): Promise<GraphEdge[]> {
    const notInit = this._notInitError<GraphEdge[]>();
    if (notInit) return notInit;
    return neighbors(this._adapter, node, opts);
  }

  /** Bounded BFS from a node (depth ≤ 5, node-count capped). */
  async traverseGraph(
    start: GraphNode,
    opts: TraversalOptions = {},
  ): Promise<GraphTraversalResult> {
    const notInit = this._notInitError<GraphTraversalResult>();
    if (notInit) return notInit;
    return traverse(this._adapter, start, opts);
  }

  /** Zero-LLM edge extraction from a foreign-key column. Returns the edge count. */
  async extractEdges(spec: ExtractEdgesSpec): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    return extractEdgesFromColumn(this._adapter, spec);
  }

  /**
   * Graph-augmented hybrid search: run {@link hybridSearch}, then boost results
   * that are graph-adjacent to the `anchors` (e.g. the user's current-context
   * entities), so relationship-relevant rows rank higher. Returns the reranked
   * hybrid results (the graph boost is folded into each score).
   */
  async graphSearch(
    table: string,
    query: string,
    opts: Omit<HybridSearchOptions, 'embeddingsConfig' | 'pkColumn'> & {
      anchors: GraphNode[];
      graphWeight?: number;
      graphDepth?: number;
      graphDirection?: TraversalDirection;
      graphEdgeTypes?: string[];
    },
  ): Promise<HybridSearchResult[]> {
    const notInit = this._notInitError<HybridSearchResult[]>();
    if (notInit) return notInit;
    const pkCol = this._schema.getPrimaryKey(table)[0] ?? 'id';
    const hybrid = await this.hybridSearch(table, query, opts);
    if (opts.anchors.length === 0) return hybrid;
    const scored = hybrid.map((r) => ({ id: String(r.row[pkCol]), score: r.score, _r: r }));
    const boosted = await graphAdjacencyBoost(this._adapter, scored, {
      anchors: opts.anchors,
      resultTable: table,
      ...(opts.graphWeight !== undefined ? { weight: opts.graphWeight } : {}),
      ...(opts.graphDepth !== undefined ? { maxDepth: opts.graphDepth } : {}),
      ...(opts.graphDirection ? { direction: opts.graphDirection } : {}),
      ...(opts.graphEdgeTypes ? { edgeTypes: opts.graphEdgeTypes } : {}),
    });
    return boosted.map((b) => {
      const r = b.item._r;
      r.score = b.boostedScore;
      r.explain.final = b.boostedScore;
      return r;
    });
  }

  // -------------------------------------------------------------------------
  // Seamless cloud file-byte access (P-CLOUDFILES) — Postgres cloud only
  // -------------------------------------------------------------------------

  /**
   * Enable keyless cloud file-byte access cloud-wide (Postgres cloud only).
   * Installs the in-database SigV4 presigner + `pgcrypto`, stores the owner's
   * least-privilege S3 key in an **owner-only, member-unreadable** table, and
   * grants the cloud's member group EXECUTE on `lattice_presign_file` — so every
   * current + future member can presign GET/PUT URLs for the `files` rows they're
   * allowed to see, holding no key themselves. One owner action turns it on for
   * the whole cloud.
   */
  async enableCloudFilePresigning(
    secret: CloudS3Secret,
    opts: { memberGroup?: string } = {},
  ): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    if (this._adapter.dialect !== 'postgres') {
      throw new Error('enableCloudFilePresigning: requires a Postgres cloud (no-op on SQLite)');
    }
    const schema = await cloudSchema(this);
    await installFilePresigner(this._adapter, schema);
    await setCloudS3Secret(this._adapter, secret);
    const group = opts.memberGroup ?? (await memberGroupFor(this));
    await grantPresignerToMemberGroup(this._adapter, group);
  }

  /**
   * Presign a GET/PUT URL for a `files` row, computed inside Postgres and gated
   * on the caller's row-visibility (the keyless-member path). Requires the
   * presigner to be installed + an S3 secret configured
   * ({@link enableCloudFilePresigning}). TTL is capped at 60s server-side.
   */
  async presignFile(fileId: string, method: 'GET' | 'PUT', ttlSeconds = 60): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    const row = await getAsyncOrSync(this._exec(), `SELECT lattice_presign_file(?, ?, ?) AS url`, [
      fileId,
      method,
      ttlSeconds,
    ]);
    const url = row?.url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`presignFile: no presigned URL returned for "${fileId}"`);
    }
    return url;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async render(outputDir: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const notInit = this._notInitError<RenderResult>();
    if (notInit) return notInit;

    const result = await this._render.render(outputDir, opts);
    for (const h of this._renderHandlers) h(result);
    return result;
  }

  /**
   * Render into `outputDir` through the shared single-flight guard, intended to
   * be called fire-and-forget (e.g. the GUI's instant-open background render).
   *
   * The guard ({@link AutoRenderScheduler.runGuarded}) holds the scheduler's
   * in-flight flag for the render's duration, so a data mutation that lands while
   * this render is in flight is deferred by the debounced auto-render path and
   * coalesced — when this render settles, `finally` clears the flag and re-arms
   * exactly one follow-up render. Net invariant: at most one render to a given
   * dir at a time.
   *
   * Errors propagate to the caller (the GUI surfaces them, never silently swallowed); they are
   * not swallowed here.
   */
  async renderInBackground(outputDir: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const notInit = this._notInitError<RenderResult>();
    if (notInit) return notInit;

    // Open/restart staleness gate (opt-in, ONLY the GUI's open render sets it). If
    // the manifest's recorded template version + cursor match the live state read
    // through THIS connection's scope (a member's RLS connection on a member open),
    // nothing the tree depends on has advanced — SKIP the render before touching a
    // single table or emitting any per-table progress. This is what stops a plain
    // restart / version bump from re-rendering an unchanged tree. Fails OPEN: any
    // uncertainty falls through to a full render.
    if (opts.gateOnOpen && !opts.changedTables) {
      const start = Date.now();
      const recorded = readManifest(outputDir);
      // A render that wrote no manifest (no entity contexts) has nothing to gate
      // on — fall through and render. Otherwise compute the live cursor and skip
      // only when the gate proves freshness.
      if (recorded != null) {
        const live = await computeRenderCursor(this._adapter);
        if (cursorIsFresh(recorded, live)) {
          // Skip path: no table reads, no per-table progress, just one terminal
          // 'done' so the GUI shows complete.
          opts.onProgress?.({
            kind: 'done',
            table: null,
            entitiesRendered: 0,
            entitiesTotal: 0,
            tableIndex: 0,
            tableCount: 0,
            pct: 100,
            durationMs: Date.now() - start,
          });
          const skipped: RenderResult = {
            filesWritten: [],
            filesSkipped: 0,
            durationMs: Date.now() - start,
          };
          for (const h of this._renderHandlers) h(skipped);
          return skipped;
        }
      }
    }

    // `gateOnOpen` is a renderInBackground-only concern (handled above) — don't forward
    // it into the scheduler/engine. The scheduler's runGuarded owns the
    // scope-clearing-on-full-render that older inline versions did here.
    const { gateOnOpen: _gateOnOpen, ...engineOpts } = opts;
    return this._autoRender.runGuarded(outputDir, engineOpts);
  }

  /**
   * Install a per-viewer read-relation resolver for ALL renders (initial,
   * background, and the debounced auto-render that fires after every write).
   * A cloud member open passes `(t) => maskedReadViews.get(t) ?? t` so the
   * rendered context tree is read THROUGH the member's RLS connection + masking
   * views — making the on-disk tree the viewer's own scoped projection. Owner /
   * local SQLite leave it unset → identity → unchanged behavior. Set on the
   * SchemaManager (the read layer), not per-render-call, so the opts-less
   * auto-render path masks too — AND so the reverse-sync engine, which reads the
   * same SchemaManager, writes a member's file edit back through the masked view
   * instead of the REVOKE'd base table. One resolver, every reader.
   */
  setRenderReadRelation(fn: (table: string) => string): void {
    this._schema.setReadRelation(fn);
  }

  /**
   * Turn on the per-viewer enrichment fold for ALL renders. A cloud member open
   * calls this so the rendered context overlays the member-visible DERIVED
   * observations onto each ground row ({@link foldRenderRows}). Owner / local
   * SQLite leave it off → ground truth renders unchanged.
   */
  enableRenderFold(): void {
    this._render.setRenderFold((table, rows) => this.foldRenderRows(table, rows));
  }

  /**
   * Request a debounced re-render (the same coalesced, pending-requeue path that
   * a local write triggers). Used to eagerly refresh a cloud member's rendered
   * tree when a REMOTE change arrives — notably an owner re-sharing or un-sharing
   * a row, after which the member's per-viewer projection must be recompiled. A
   * no-op when auto-render isn't enabled.
   *
   * Pass the CHANGED table so only that entity (+ its cross-table dependents) is
   * re-rendered instead of the whole tree; omit it to force a full render.
   */
  requestRender(table?: string): void {
    this._autoRender.schedule(table);
  }

  /**
   * True while a render is actively writing the context tree + manifest (auto-
   * render OR a guarded background render). The file-loopback watcher checks this
   * to avoid reverse-syncing mid-render — a pass then would read half-written
   * output whose manifest hash hasn't caught up yet and re-ingest the render's
   * OWN writes as spurious "file-edit" changes.
   */
  isRendering(): boolean {
    return this._autoRender.isInFlight();
  }

  /**
   * Fold the viewer-visible DERIVED observations onto a table's ground rows in one
   * batched changelog read — the render-time, whole-table analogue of
   * {@link foldForViewer} (which is per-row). Read THROUGH this connection: on a
   * cloud member connection the changelog RLS (`lattice_changelog_sel`) already
   * drops any derived observation whose sources the member can't all reach AND
   * hides every owner-only ground-truth/audit entry — so what returns is exactly
   * the member-visible derived set, and overlaying it is leak-free by construction
   * (the database, not this code, is the enforcement point). One read per table,
   * never per row (the per-row `history()` fan-out would be an unbounded hot-path
   * cost). A no-op when the changelog substrate is absent or nothing is derived.
   */
  async foldRenderRows(table: string, rows: Row[]): Promise<Row[]> {
    if (rows.length === 0) return rows;
    if (!(await this._changelogTableExists())) return rows;
    // recentChanges reads via THIS adapter (RLS-filtered for a member); a member
    // sees no owner-only ground-truth rows, so only derived observations return.
    const changes = await this.recentChanges({ table, limit: RENDER_FOLD_MAX_CHANGES });
    const obsByRow = new Map<string, Observation[]>();
    for (const h of changes) {
      if (h.changeKind !== 'derived') continue;
      const sources = h.sourceRef ?? null;
      const opened = this._openSealedObservation(h.changes, sources, undefined);
      // A sealed value we can't open (no key at render time) reverts to ground.
      if (opened === null) continue;
      const list = obsByRow.get(h.rowId) ?? [];
      list.push(
        ...observationsFromChange({
          changes: opened,
          createdAt: h.createdAt,
          changeKind: 'derived',
          sourceRef: sources,
        }),
      );
      obsByRow.set(h.rowId, list);
    }
    if (obsByRow.size === 0) return rows;
    // Every observation that survived the changelog RLS read is, by construction,
    // one this viewer may see — so the visible-source set is the union of their
    // refs (the `'all'` semantics of foldForViewer's single-user path).
    const visibleSources = new Set<string>();
    for (const list of obsByRow.values())
      for (const o of list) for (const s of o.sourceRef ?? []) visibleSources.add(s);
    return rows.map((r) => {
      const obs = obsByRow.get(this._serializeRowPk(table, r));
      return obs ? foldEntity(r, obs, { visibleSources }) : r;
    });
  }

  async sync(outputDir: string): Promise<SyncResult> {
    const notInit = this._notInitError<SyncResult>();
    if (notInit) return notInit;

    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    const writebackProcessed = await this._writeback.process();

    return { ...renderResult, writebackProcessed };
  }

  /**
   * Recover rows from rendered files into empty database tables.
   *
   * For each registered table where `reverseSeed !== false`, checks if the
   * table has zero rows and rendered files exist. If so, parses the files
   * back into rows using the built-in template parser or a custom parser.
   *
   * Safe to call multiple times — uses INSERT OR IGNORE and only activates
   * on truly empty tables.
   *
   * @since 0.20.0
   */
  async reverseSeed(outputDir: string): Promise<ReverseSeedResult> {
    const notInit = this._notInitError<ReverseSeedResult>();
    if (notInit) return notInit;

    const result = await this._reverseSeedEngine.process(outputDir);

    // Emit events for each recovered table
    for (const tableResult of result.tables) {
      for (const h of this._reverseSeedHandlers) {
        h({ table: tableResult.table, rowCount: tableResult.rowsRecovered, source: 'files' });
      }
    }

    return result;
  }

  async reconcile(outputDir: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const notInit = this._notInitError<ReconcileResult>();
    if (notInit) return notInit;

    // Read previous manifest BEFORE render so cleanup can detect orphans
    const prevManifest = readManifest(outputDir);

    // Reverse-seed phase: detect or recover rows from files into empty tables.
    // Default: detect only (flag to human). With `reverseSeed: 'auto'`: auto-recover.
    let reverseSeedResult: ReverseSeedResult | null = null;
    let reverseSeedRequired: import('./types.js').ReverseSeedDetection[] = [];

    if (options.reverseSeed === 'auto') {
      // Auto-recovery mode: parse files and insert rows
      const result = await this._reverseSeedEngine.process(outputDir);
      for (const tableResult of result.tables) {
        for (const h of this._reverseSeedHandlers) {
          h({ table: tableResult.table, rowCount: tableResult.rowsRecovered, source: 'files' });
        }
      }
      reverseSeedResult = result.totalRowsRecovered > 0 ? result : null;
    } else {
      // Detect-only mode: report which tables need attention
      reverseSeedRequired = await this._reverseSeedEngine.detect(outputDir);
    }

    // Reverse-sync phase: detect external file edits and sweep them back into DB.
    // Runs before render so the render phase writes from the now-updated DB state.
    // Disabled by `reverseSync: false`. Dry-run with `reverseSync: 'dry-run'`.
    let reverseSyncResult: import('./types.js').ReverseSyncResult | null = null;
    if (options.reverseSync !== false) {
      const dryRun = options.reverseSync === 'dry-run';
      reverseSyncResult = await this._reverseSync.process(outputDir, prevManifest, dryRun);
    }

    // Render (writes new manifest with updated hashes)
    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    // Read the new manifest just written by render
    const newManifest = readManifest(outputDir);

    // Run cleanup after render, passing both old and new manifests.
    // Old manifest: detects orphaned directories (deleted entities).
    // New manifest: detects stale files in surviving entities (omitIfEmpty, removed files).
    const cleanup = await this._render.cleanup(outputDir, prevManifest, options, newManifest);

    return {
      ...renderResult,
      cleanup,
      reverseSync: reverseSyncResult,
      reverseSeed: reverseSeedResult,
      reverseSeedRequired,
    };
  }

  /** Build/refresh the full-text index for every `fts`-configured table (idempotent;
   *  `ensureFtsIndex` creates the index, triggers, and backfills existing rows). */
  private async _buildFtsIndexes(): Promise<void> {
    for (const [name, def] of this._schema.getTables()) {
      if (!def.fts) continue;
      const actualCols = await introspectColumnsAsyncOrSync(this._adapter, name);
      const cols = (def.fts.fields ?? autoFtsColumns(actualCols)).filter((c) =>
        actualCols.includes(c),
      );
      await ensureFtsIndex(this._adapter, name, cols);
    }
  }

  /**
   * Rebuild the full-text search indexes for all `fts`-configured tables and
   * backfill existing rows. `init()` runs this on an empty DB; this public entry
   * point re-runs it AFTER rows are present — notably after a migrate-to-cloud row
   * copy, which otherwise leaves the cloud with data but no `__lattice_fts_*`
   * tables (so search/the assistant find nothing). Idempotent.
   */
  async rebuildFtsIndexes(): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    await this._buildFtsIndexes();
  }

  /**
   * Run reverse-sync against the rendered tree at `outputDir` and return what was
   * applied. Unlike {@link reconcile} (which runs reverse-sync with raw SQL as a
   * pre-render step), this is the changelog-aware entry point the GUI file-loopback
   * uses: pass `apply` to route each update through a versioned write (so a file
   * edit is recorded exactly like a GUI edit) and `useDefault` to round-trip
   * frontmatter + body `key: value` fields for files lacking a hand-written
   * `reverseSync`. Compares file hashes against the current manifest, so a
   * render-written file is recognized as an echo and skipped.
   */
  /**
   * The post-render reconciliation pass: prune files the prior manifest managed
   * that the new render no longer produces (deleted rows, renamed roots, retired
   * rollups) — hash-guarded so a manually edited file is never deleted. Runs
   * automatically after auto/background renders and at workspace open; exposed
   * for callers that drive `render()` themselves.
   */
  async reconcileRenderedTree(
    outputDir: string,
    prevManifest: import('./lifecycle/manifest.js').LatticeManifest | null,
    newManifest: import('./lifecycle/manifest.js').LatticeManifest | null,
  ): Promise<import('./lifecycle/cleanup.js').CleanupResult> {
    const notInit = this._notInitError<import('./lifecycle/cleanup.js').CleanupResult>();
    if (notInit) return notInit;
    return this._render.cleanup(outputDir, prevManifest, {}, newManifest);
  }

  async reverseSyncFromFiles(
    outputDir: string,
    opts: import('./reverse-sync/engine.js').ReverseSyncProcessOptions = {},
  ): Promise<import('./types.js').ReverseSyncResult> {
    const notInit = this._notInitError<import('./types.js').ReverseSyncResult>();
    if (notInit) return notInit;
    const prevManifest = readManifest(outputDir);
    return this._reverseSync.process(outputDir, prevManifest, false, opts);
  }

  watch(outputDir: string, opts: WatchOptions = {}): Promise<StopFn> {
    const notInit = this._notInitError<StopFn>();
    if (notInit) return notInit;

    const stop = this._loop.watch(outputDir, {
      ...opts,
      onRender: (result) => {
        opts.onRender?.(result);
        for (const h of this._renderHandlers) h(result);
      },
      onError: (err) => {
        opts.onError?.(err);
        for (const h of this._errorHandlers) h(err);
      },
    });
    return Promise.resolve(stop);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(event: 'audit', handler: EventHandler<AuditEvent>): this;
  on(event: 'render', handler: EventHandler<RenderResult>): this;
  on(
    event: 'writeback',
    handler: EventHandler<{ filePath: string; entriesProcessed: number }>,
  ): this;
  on(
    event: 'reverseSeed',
    handler: EventHandler<{ table: string; rowCount: number; source: 'files' }>,
  ): this;
  on(event: 'error', handler: EventHandler<Error>): this;
  on(
    event: LatticeEvent['type'],
    handler:
      | EventHandler<AuditEvent>
      | EventHandler<RenderResult>
      | EventHandler<{ filePath: string; entriesProcessed: number }>
      | EventHandler<{ table: string; rowCount: number; source: 'files' }>
      | EventHandler<Error>,
  ): this {
    switch (event) {
      case 'audit':
        this._auditHandlers.push(handler as EventHandler<AuditEvent>);
        break;
      case 'render':
        this._renderHandlers.push(handler as EventHandler<RenderResult>);
        break;
      case 'writeback':
        this._writebackHandlers.push(
          handler as EventHandler<{ filePath: string; entriesProcessed: number }>,
        );
        break;
      case 'reverseSeed':
        this._reverseSeedHandlers.push(
          handler as EventHandler<{ table: string; rowCount: number; source: 'files' }>,
        );
        break;
      case 'error':
        this._errorHandlers.push(handler as EventHandler<Error>);
        break;
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Escape hatch
  // -------------------------------------------------------------------------

  /**
   * Direct access to the underlying better-sqlite3 handle. SQLite-only — throws
   * if the configured adapter isn't a SQLiteAdapter (e.g. when running on
   * Postgres). Use `.adapter` for portable access.
   */
  get db(): Database.Database {
    if (!(this._adapter instanceof SQLiteAdapter)) {
      throw new Error(
        '.db is only available on SQLiteAdapter. The current adapter is ' +
          this._adapter.constructor.name +
          ' — use .adapter for portable access or switch to a SQLite connection string.',
      );
    }
    return this._adapter.db;
  }

  /** Direct access to the configured StorageAdapter. Portable across backends. */
  get adapter(): StorageAdapter {
    return this._adapter;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Filter a sanitized row to only include columns that actually exist in the
   * table (verified via PRAGMA after init). Unregistered tables (accessed
   * through the raw `.db` handle) are passed through unchanged.
   *
   * This is a defence-in-depth guard: column names from caller-supplied `row`
   * objects are interpolated into SQL, so stripping unknown keys eliminates
   * any theoretical injection vector from crafted object keys.
   */
  /**
   * Return the column cache for a registered table. The cache is pre-populated
   * for every `define()`d table at the end of `_initAsync` (after migrations
   * apply, so migration-added columns are visible). Tables accessed through
   * the raw `.db` / `.adapter` escape hatch — outside lattice's `define()`
   * contract — return an empty set; their callers' `_filterToSchemaColumns`
   * short-circuit ("unknown table — pass through") is the right behavior for
   * those, since column filtering needs a known column list.
   *
   * Pre-1.10.0 this method had a lazy `introspectColumns` fallback for
   * unregistered tables. The fallback was dropped when synckit was removed —
   * synchronous Postgres introspection has no path on `pg.Pool`. The
   * effective behavior change is: raw-.db writes to a table that lattice
   * never `define()`d no longer get their `Row` filtered to "schema-known
   * columns". That contract is preserved for every `define()`d table, which
   * is what production code uses.
   */
  private _ensureColumnCache(table: string): Set<string> {
    return this._columnCache.get(table) ?? new Set<string>();
  }

  private _filterToSchemaColumns(table: string, row: Row): Row {
    const cols = this._ensureColumnCache(table);
    if (cols.size === 0) return row; // unknown table — pass through
    const keys = Object.keys(row);
    if (keys.every((k) => cols.has(k))) return row; // common case: no unknown keys
    return Object.fromEntries(keys.filter((k) => cols.has(k)).map((k) => [k, row[k]])) as Row;
  }

  /**
   * Build the WHERE clause and params for a PK lookup.
   * - `string` → matches against the table's first PK column.
   * - `Record` → matches every PK column; all must be present in the object.
   */
  private _pkWhere(table: string, id: PkLookup): { clause: string; params: unknown[] } {
    const pkCols = this._schema.getPrimaryKey(table);

    if (typeof id === 'string') {
      const firstCol = pkCols[0] ?? 'id';
      return { clause: `"${firstCol}" = ?`, params: [id] };
    }

    const clauses = pkCols.map((col) => `"${col}" = ?`);
    const params = pkCols.map((col) => id[col]);
    return { clause: clauses.join(' AND '), params };
  }

  // ── Composite-key serialization for the row-level-permission layer ───────
  // The cloud RLS bookkeeping (`__lattice_owners`/`__lattice_row_grants`) and
  // the change-log key each row by a single TEXT `pk`. For a table whose
  // primary key spans several columns (e.g. a junction table `(project_id,
  // meeting_id)` with no `id`), that key must encode EVERY pk column, and the
  // write side (what we store) must match the read side (the SQL that
  // reconstructs it from row columns). These helpers are the single source of
  // truth for both. A single-column key serializes to the bare value (so all
  // pre-2.2.1 single-`id` data stays valid).

  /**
   * The primary-key columns of `table` that PHYSICALLY exist, in declared
   * order. Empty when the table has no Lattice-addressable key — e.g. a table
   * reached via raw SQL whose PK metadata defaulted to `['id']` but that has
   * no `id` column. Callers treat an empty result as "unkeyable" (no per-row
   * ACL is possible, so the row-perm SQL must not reference a pk column).
   */
  private _resolvedPkCols(table: string): string[] {
    const cols = this._ensureColumnCache(table);
    return this._schema.getPrimaryKey(table).filter((c) => cols.has(c));
  }

  /** Canonical ACL / change-log `pk` string for a row. Matches `db/pk.ts` `pkSqlExpr`. */
  private _serializeRowPk(table: string, row: Row): string {
    return _serializeRowPkCodec(this._resolvedPkCols(table), row);
  }

  /**
   * Canonical `pk` string for a {@link PkLookup} used by update/delete, so a
   * row addressed by lookup keys its change-log entry identically to the way
   * {@link _serializeRowPk} keyed it at insert time.
   */
  private _serializePkLookup(table: string, id: PkLookup): string {
    return _serializePkLookupCodec(this._resolvedPkCols(table), id);
  }

  /** Returns a rejected Promise if not initialized; null if ready. */
  private async _fireWriteHooks(
    table: string,
    op: 'insert' | 'update' | 'delete',
    row: Row,
    pk: string,
    changedColumns?: string[],
  ): Promise<void> {
    for (const hook of this._writeHooks) {
      if (hook.table !== table) continue;
      if (!hook.on.includes(op)) continue;
      if (op === 'update' && hook.watchColumns && changedColumns) {
        if (!hook.watchColumns.some((c) => changedColumns.includes(c))) continue;
      }
      try {
        const ctx: WriteHookContext = { table, op, row, pk };
        if (changedColumns) ctx.changedColumns = changedColumns;
        await hook.handler(ctx);
      } catch (err) {
        // Hook errors must not crash the caller — routed through error
        // handlers like every other lattice background failure.
        for (const h of this._errorHandlers) h(err instanceof Error ? err : new Error(String(err)));
      }
    }
    // Every mutation schedules an auto-render when one is enabled (workspaces
    // enable it by default). Scoped to the written table so only that entity
    // (+ its cross-table dependents) re-renders. No-op when disabled.
    // Internal bookkeeping tables (`_lattice_*` / `__lattice_*`: the GUI audit
    // log, changelog, edges, lineage, …) are NOT rendered context, so their
    // writes must never trigger a render — during ingest the audit table alone
    // took a write per object and re-scheduled a full-table re-scan each time.
    if (!table.startsWith('_lattice_') && !table.startsWith('__lattice_')) {
      this._autoRender.schedule(table);
    }
  }

  /**
   * Suspend auto-render (re-entrant) for the duration of a bulk operation — e.g.
   * ingesting a folder of hundreds of files. Writes still record their render
   * scope, but no render fires until {@link resumeAutoRender} balances every
   * pause, at which point ONE coalesced render covers everything. This removes
   * the O(N²) "render-per-file" blowup where each of N writes re-scanned the
   * whole (growing) file set. Always pair with resumeAutoRender in a `finally`.
   */
  pauseAutoRender(): this {
    this._autoRender.pause();
    return this;
  }

  /** Balance a {@link pauseAutoRender}; the last resume arms one coalesced render. */
  resumeAutoRender(): this {
    this._autoRender.resume();
    return this;
  }

  /**
   * Turn on automatic rendering into `outputDir`. After this, every insert /
   * update / delete debounce-triggers a re-render (coalesced, so a bulk seed
   * produces a single render, and unchanged files are skipped by the manifest
   * hash-diff). Workspaces enable this by default; a bare `new Lattice(dbPath)`
   * is unaffected unless it opts in.
   */
  enableAutoRender(outputDir: string, opts: { debounceMs?: number } = {}): this {
    this._autoRender.enable(outputDir, opts);
    return this;
  }

  /** Turn off automatic rendering and cancel any pending render. */
  disableAutoRender(): this {
    this._autoRender.disable();
    return this;
  }

  /**
   * Update or remove the embedding for a row.
   * No-op if the table doesn't have `embeddings` configured.
   *
   * Fire-and-forget: errors are routed through the error handlers, never
   * thrown. The caller does not await — embedding compute is slow and
   * shouldn't block the write completion.
   */
  private _syncEmbedding(
    table: string,
    op: 'insert' | 'update' | 'delete',
    row: Row,
    pk: string,
  ): void {
    const def = this._schema.getTables().get(table);
    if (!def?.embeddings) return;

    const handle = (err: unknown): void => {
      for (const h of this._errorHandlers) {
        h(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // After the store write resolves, mirror the change into the native vector
    // index (no-op when none exists) on the SAME fire-and-forget chain — so an
    // existing index stays in lock-step with writes instead of silently drifting.
    if (op === 'delete') {
      removeEmbedding(this._adapter, table, pk)
        .then(() => removeVectorIndexRow(this._adapter, table, pk))
        .catch(handle);
      return;
    }

    storeEmbedding(this._adapter, table, pk, row, def.embeddings)
      .then(() => mirrorVectorIndexRow(this._adapter, table, pk))
      .catch(handle);
  }

  // -------------------------------------------------------------------------
  // Changelog internals
  // -------------------------------------------------------------------------

  /**
   * Create the __lattice_changelog table and index. This is the single,
   * canonical change-log substrate (the dead `__lattice_change_log` team-sync
   * envelope was removed in 3.0). Beyond the field-level delta columns it
   * carries provenance columns for the per-viewer observation model:
   * `source_ref` (the source-set that informed a derived value),
   * `change_kind` (`ground_truth` | `derived`), `superseded_by`, `audience`
   * (defaults to row audience), and `source_sensitive` (crypto-shred flag).
   * All are additive + nullable (or defaulted) — Stage-0 metadata, no behavior
   * change until later stages read them.
   */
  /** Whether `__lattice_changelog` physically exists (read-only; no DDL), so a
   *  scoped member can decide there are no observations without trying to create
   *  the table. */
  private async _changelogTableExists(): Promise<boolean> {
    return this._changelogWriter.tableExists();
  }

  private async _ensureChangelogTable(): Promise<void> {
    return this._changelogWriter.ensureTable();
  }

  /** Append a changelog entry if the table has changelog enabled. The optional
   *  `prov` carries the per-viewer observation provenance (source-set, kind,
   *  audience, …); when omitted the entry behaves exactly as a pre-3.0 entry. */
  private async _appendChangelog(
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
    prov?: ChangeProvenance,
  ): Promise<void> {
    return this._changelogWriter.append(
      table,
      rowId,
      operation,
      changes,
      previous,
      source,
      reason,
      prov,
    );
  }

  /** The ungated change-log INSERT. `_appendChangelog` wraps it with the
   *  changelog-enabled gate; `observe()` calls it directly (an observation is an
   *  explicit, always-recorded write to the substrate). The change-log table must
   *  exist already. */
  private async _writeChangelogRow(
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
    prov?: ChangeProvenance,
  ): Promise<void> {
    return this._changelogWriter.writeRow(
      table,
      rowId,
      operation,
      changes,
      previous,
      source,
      reason,
      prov,
    );
  }

  /** Prune changelog entries based on retention policy. */
  private async _pruneChangelog(): Promise<void> {
    return this._changelogWriter.prune();
  }

  /** Parse a raw changelog DB row into a ChangeEntry. */
  /** Lazily-constructed changelog read/replay collaborator (see src/changelog/service.ts). */
  private get _changelog(): ChangelogService {
    this._changelogService ??= new ChangelogService({
      adapter: this._adapter,
      pkWhere: (table, id) => this._pkWhere(table, id),
      appendChangelog: (table, rowId, operation, changes, previous, source, reason) =>
        this._appendChangelog(table, rowId, operation, changes, previous, source, reason),
    });
    return this._changelogService;
  }

  /** Lazily-constructed changelog write/DDL collaborator (see src/changelog/writer.js). */
  private get _changelogWriter(): ChangelogWriter {
    this._changelogWriterInstance ??= new ChangelogWriter({
      adapter: this._adapter,
      dialect: () => this.getDialect(),
      isChangelogTable: (t) => this._changelogTables.has(t),
      changelogOptions: this._changelogOptions,
    });
    return this._changelogWriterInstance;
  }

  // -------------------------------------------------------------------------
  // Changelog public API
  // -------------------------------------------------------------------------

  /**
   * Get change history for a specific row, newest first.
   */
  async history(table: string, id: string, opts?: { limit?: number }): Promise<ChangeEntry[]> {
    const notInit = this._notInitError<ChangeEntry[]>();
    if (notInit) return notInit;

    return this._changelog.history(table, id, opts);
  }

  /**
   * Get recent changes across tables.
   */
  async recentChanges(opts?: {
    table?: string;
    since?: string;
    limit?: number;
  }): Promise<ChangeEntry[]> {
    const notInit = this._notInitError<ChangeEntry[]>();
    if (notInit) return notInit;

    return this._changelog.recentChanges(opts);
  }

  /**
   * Rollback a specific change by applying the inverse operation.
   * The rollback itself is recorded as a new changelog entry.
   */
  async rollback(changeId: string): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    return this._changelog.rollback(changeId);
  }

  /**
   * Show field-level diff between two changelog entries for the same row.
   */
  diff(
    table: string,
    id: string,
    fromChangeId: string,
    toChangeId: string,
  ): Promise<Record<string, { old: unknown; new: unknown }>> {
    const notInit = this._notInitError<Record<string, { old: unknown; new: unknown }>>();
    if (notInit) return notInit;

    return this._changelog.diff(table, id, fromChangeId, toChangeId);
  }

  /**
   * Reconstruct the row state at a specific changelog entry by replaying
   * all operations up to and including that entry.
   */
  async snapshot(table: string, id: string, changeId: string): Promise<Record<string, unknown>> {
    const notInit = this._notInitError<Record<string, unknown>>();
    if (notInit) return notInit;

    return this._changelog.snapshot(table, id, changeId);
  }

  /**
   * Manually prune changelog entries based on the configured retention policy.
   * Also callable directly for on-demand cleanup.
   */
  async pruneChangelog(): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    await this._pruneChangelog();
  }

  private _notInitError<T>(): Promise<T> | null {
    if (!this._initialized) {
      return Promise.reject(
        new Error('Lattice: call await db.init() before using CRUD or sync methods'),
      );
    }
    return null;
  }

  /**
   * Returns a rejected Promise if any of the given column names are not present
   * in the table's schema; null if all columns are valid.
   *
   * Applied on the read path (query/count) to validate WHERE and filter column
   * names before they are interpolated into SQL. The write path strips unknown
   * columns via _filterToSchemaColumns; the read path rejects instead to avoid
   * silently discarding intended filter conditions.
   *
   * Unregistered tables (accessed via the raw `.db` handle) are passed through.
   */
  private _invalidColumnError<T>(table: string, cols: string[]): Promise<T> | null {
    const known = this._columnCache.get(table);
    if (!known) return null; // unregistered table — pass through
    for (const col of cols) {
      if (!known.has(col)) {
        return Promise.reject(new Error(`Lattice: unknown column "${col}" in table "${table}"`));
      }
    }
    return null;
  }

  private _assertNotInit(method: string): void {
    if (this._initialized) {
      throw new Error(`Lattice: ${method}() must be called before init()`);
    }
  }
}

export { SeedReconciliationError } from './crud/seed-engine.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Extract the built-in template name from a RenderSpec, if any. */
function _resolveTemplateName(render?: RenderSpec): BuiltinTemplateName | undefined {
  if (!render) return undefined;
  if (typeof render === 'string') return render;
  if (typeof render === 'function') return undefined;
  return render.template;
}
