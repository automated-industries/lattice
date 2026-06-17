import { v4 as uuidv4 } from 'uuid';
import type {
  Row,
  LatticeOptions,
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
  LatticeEvent,
  Filter,
  RenderSpec,
  BuiltinTemplateName,
  WriteHook,
  WriteHookContext,
  SeedConfig,
  SeedResult,
  UnresolvedLink,
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
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { StorageAdapter } from './db/adapter.js';
import {
  runAsyncOrSync,
  getAsyncOrSync,
  allAsyncOrSync,
  introspectColumnsAsyncOrSync,
  addColumnAsyncOrSync,
} from './db/adapter.js';
import { SQLiteAdapter } from './db/sqlite.js';
import { PostgresAdapter } from './db/postgres.js';
import { SchemaManager } from './schema/manager.js';
import type { CompiledTableDef } from './schema/manager.js';
import { assertSafeIdentifier } from './schema/identifier.js';
import { ChangelogService } from './changelog/service.js';
import { ReportBuilder } from './report/builder.js';
import { Sanitizer } from './security/sanitize.js';
import { RenderEngine, NOOP_RENDER } from './render/engine.js';
import type { RenderOptions } from './render/progress.js';
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
import {
  deriveKey,
  encrypt as encryptValue,
  decrypt as decryptValue,
  resolveEncryptedColumns,
} from './security/encryption.js';
import {
  ensureEmbeddingsTable,
  storeEmbedding,
  removeEmbedding,
  searchByEmbedding,
} from './search/embeddings.js';
import { ensureFtsIndex, autoFtsColumns } from './search/fts.js';

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
  return new SQLiteAdapter(sqlitePath, adapterOpts);
}

/**
 * Soft-delete filter fragment. A row is "live" when `deleted_at` is NULL or the
 * empty string (legacy rows used `''`). Interpolated into the WHERE clause of
 * natural-key lookups so a soft-deleted row never satisfies a uniqueness probe.
 */
const NOT_DELETED = "(deleted_at IS NULL OR deleted_at = '')";

export class Lattice {
  private readonly _adapter: StorageAdapter;
  private _changelogService?: ChangelogService;
  private _reportBuilder?: ReportBuilder;
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
   * When set, insert/update/delete debounce-trigger a re-render into this dir.
   * Configured by {@link enableAutoRender} / {@link Lattice.openWorkspace}.
   * Undefined = inert: a bare `new Lattice(dbPath)` pays zero overhead and its
   * behavior is unchanged.
   */
  private _autoRenderDir: string | undefined;
  private _autoRenderTimer: ReturnType<typeof setTimeout> | undefined;
  private _autoRenderPending = false;
  private _autoRenderInFlight = false;
  private _autoRenderDebounceMs = 250;

  /** Cache of actual table columns (from PRAGMA), populated after init(). */
  private readonly _columnCache = new Map<string, Set<string>>();

  /** Derived encryption key (from options.encryptionKey via scrypt). */
  private _encryptionKey?: Buffer;
  /** Map of table → set of column names that should be encrypted at rest. */
  private readonly _encryptedTableColumns = new Map<string, Set<string>>();
  /** Raw encryption key passphrase from constructor options. */
  private readonly _encryptionKeyRaw?: string;

  /** Changelog retention options. */
  private readonly _changelogOptions?: ChangelogOptions;
  /** Set of table names that have changelog: true. */
  private readonly _changelogTables = new Set<string>();

  /** Current task context string for relevance filtering. */
  private _taskContext = '';

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
      await db.render(paths.contextDir);
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
    if (def.encrypted && !this._encryptionKeyRaw) {
      throw new Error(
        `Table "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
      );
    }
    this._registerTable(table, def);
    await this._schema.applySchemaForAsync(this._adapter, table);
    const cols = await introspectColumnsAsyncOrSync(this._adapter, table);
    this._columnCache.set(table, new Set(cols));
    if (def.encrypted) {
      await this._registerEncryptedColumns(table, def.encrypted);
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
    // Auto-inject reward tracking columns
    const columns = def.rewardTracking
      ? { ...def.columns, _reward_total: 'REAL DEFAULT 0', _reward_count: 'INTEGER DEFAULT 0' }
      : def.columns;

    // Resolve the built-in template name (if any) for reverse-seed parsing
    const renderTemplateName = _resolveTemplateName(def.render);

    const compiledDef: CompiledTableDef = {
      ...def,
      columns,
      render: def.render
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
    this._validateEncryptionConfig();
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
    if (!introspectOnly && this.getDialect() === 'postgres') {
      try {
        const [marker, role] = await Promise.all([
          getAsyncOrSync(this._adapter, `SELECT to_regclass('__lattice_owners') AS reg`),
          getAsyncOrSync(
            this._adapter,
            `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user`,
          ),
        ]);
        const provisioned = !!marker && (marker as { reg?: unknown }).reg != null;
        const canCreateRoles =
          !!role && (role as { rolcreaterole?: unknown }).rolcreaterole === true;
        introspectOnly = provisioned && !canCreateRoles;
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
      for (const tableName of this._schema.getTables().keys()) {
        try {
          const cols = await introspectColumnsAsyncOrSync(this._adapter, tableName);
          this._columnCache.set(tableName, new Set(cols));
        } catch {
          // Table absent or not visible to this member — leave it uncached.
        }
      }
      await this._finalizeEncryptionSetup();
      this._initialized = true;
      return;
    }
    await this._schema.applySchema(this._adapter);
    if (options.migrations?.length) {
      // applyMigrationsAsync uses adapter.withClient when available
      // (Postgres path acquires pg_advisory_xact_lock for concurrent-boot
      // serialization; SQLite path is a plain BEGIN/COMMIT). Falls back to
      // the sync runner when an older adapter doesn't implement withClient.
      await this._schema.applyMigrationsAsync(this._adapter, options.migrations);
    }
    // Snapshot actual columns post-migration: schema state only includes declared
    // columns, so migration-added columns would be stripped by _filterToSchemaColumns
    // without this introspection-based cache.
    for (const tableName of this._schema.getTables().keys()) {
      const cols = await introspectColumnsAsyncOrSync(this._adapter, tableName);
      this._columnCache.set(tableName, new Set(cols));
    }

    // Resolve encrypted columns (needs introspectColumns to see post-migration schema)
    await this._finalizeEncryptionSetup();

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
    this._autoRenderDir = undefined;
    if (this._autoRenderTimer) {
      clearTimeout(this._autoRenderTimer);
      this._autoRenderTimer = undefined;
    }
    this._autoRenderPending = false;
    this._autoRenderInFlight = false;
    this._adapter.close();
    this._columnCache.clear();
    this._encryptedTableColumns.clear();
    delete this._encryptionKey;
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
    const existing = await introspectColumnsAsyncOrSync(this._adapter, table);
    if (!existing.includes(column)) {
      await addColumnAsyncOrSync(this._adapter, table, column, typeSpec);
    }
    const cols = await introspectColumnsAsyncOrSync(this._adapter, table);
    this._columnCache.set(table, new Set(cols));
    // Mirror the new column into the registered def so getRegisteredColumns()
    // (which the Teams `share` serialization reads) reflects the post-ALTER
    // state. No-op for an unregistered table (def stays null).
    const def = this._schema.getTables().get(table);
    if (def && !(column in def.columns)) def.columns[column] = typeSpec;
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
   * Throw-only validation of encryption-key configuration. Runs in the
   * synchronous prefix of `init()` so `expect(() => db.init()).toThrow(...)`
   * still observes the throw — moving this check into the async tail would
   * convert the throw into a rejected Promise and break those tests.
   * Column resolution happens later in {@link _finalizeEncryptionSetup} once
   * the schema has been applied.
   */
  private _validateEncryptionConfig(): void {
    for (const [table, def] of this._schema.getEntityContexts()) {
      if (!def.encrypted) continue;
      if (!this._encryptionKeyRaw) {
        throw new Error(
          `Entity context "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
        );
      }
    }
    for (const [table, def] of this._schema.getTables()) {
      if (!def.encrypted) continue;
      if (!this._encryptionKeyRaw) {
        throw new Error(
          `Table "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
        );
      }
    }
  }

  /**
   * Resolve which columns to encrypt per table, using introspectColumns to
   * see the post-migration schema. Runs in the async tail of init() after
   * applySchema/applyMigrationsAsync.
   */
  private async _finalizeEncryptionSetup(): Promise<void> {
    for (const [table, def] of this._schema.getEntityContexts()) {
      if (!def.encrypted) continue;
      if (!this._encryptionKeyRaw) continue; // already validated above
      await this._registerEncryptedColumns(table, def.encrypted);
    }
    for (const [table, def] of this._schema.getTables()) {
      if (!def.encrypted) continue;
      if (!this._encryptionKeyRaw) continue;
      // Entity-context encryption for this table (if any) was already
      // resolved in the first loop — skip to avoid clobbering with a
      // narrower table-level spec.
      if (this._encryptedTableColumns.has(table)) continue;
      await this._registerEncryptedColumns(table, def.encrypted);
    }
  }

  /**
   * Shared helper: derive the encryption key on first use, introspect the
   * table's current columns, resolve which to encrypt, and record the set
   * in `_encryptedTableColumns`. Called from both `_finalizeEncryptionSetup`
   * (boot path) and `defineLate` (post-init table registration).
   */
  private async _registerEncryptedColumns(
    table: string,
    encrypted: true | { columns: string[] },
  ): Promise<void> {
    if (!this._encryptionKeyRaw) {
      throw new Error(
        `Cannot register encrypted columns for "${table}": no encryptionKey was provided`,
      );
    }
    this._encryptionKey ??= deriveKey(this._encryptionKeyRaw);
    const allCols = await introspectColumnsAsyncOrSync(this._adapter, table);
    const encCols = resolveEncryptedColumns(encrypted, allCols);
    this._encryptedTableColumns.set(table, encCols);
  }

  /** Encrypt applicable columns in a row before writing. Returns a new row. */
  private _encryptRow(table: string, row: Row): Row {
    const encCols = this._encryptedTableColumns.get(table);
    if (!encCols || !this._encryptionKey) return row;
    const result = { ...row };
    for (const col of encCols) {
      const val = result[col];
      if (typeof val === 'string' && val.length > 0) {
        result[col] = encryptValue(val, this._encryptionKey);
      }
    }
    return result;
  }

  /** Decrypt applicable columns in a row after reading. Mutates in place. */
  private _decryptRow(table: string, row: Row): Row {
    const encCols = this._encryptedTableColumns.get(table);
    if (!encCols || !this._encryptionKey) return row;
    for (const col of encCols) {
      const val = row[col];
      if (typeof val === 'string' && val.length > 0) {
        row[col] = decryptValue(val, this._encryptionKey);
      }
    }
    return row;
  }

  /** Decrypt applicable columns in multiple rows. Mutates in place. */
  private _decryptRows(table: string, rows: Row[]): Row[] {
    if (!this._encryptedTableColumns.has(table)) return rows;
    for (const row of rows) this._decryptRow(table, row);
    return rows;
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
    await runAsyncOrSync(this._adapter, sql, values);
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
    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row));
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
    const encrypted = this._encryptRow(table, rowWithPk);
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
    this._assertRowSize(table, row);

    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row));
    const pkCols = this._schema.getPrimaryKey(table);
    const isDefaultPk = pkCols.length === 1 && pkCols[0] === 'id';

    let rowWithPk: Row;
    if (isDefaultPk) {
      const id = (sanitized.id as string | undefined) ?? uuidv4();
      rowWithPk = { ...sanitized, id };
    } else {
      rowWithPk = sanitized;
    }

    const encrypted = this._encryptRow(table, rowWithPk);

    const cols = Object.keys(encrypted)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(encrypted)
      .map(() => '?')
      .join(', ');
    // Conflict target uses all PK columns
    const conflictCols = pkCols.map((c) => `"${c}"`).join(', ');
    // Exclude all PK columns from the UPDATE SET clause
    const updateCols = Object.keys(encrypted)
      .filter((c) => !pkCols.includes(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ');
    const values = Object.values(encrypted);

    await runAsyncOrSync(
      this._adapter,
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${updateCols}`,
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
    return pkValue;
  }

  async upsertBy(table: string, col: string, val: unknown, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;
    this._assertIdent(table, col);

    const existing = await getAsyncOrSync(
      this._adapter,
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
    this._assertRowSize(table, row as Row);

    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row as Row));
    const encrypted = this._encryptRow(table, sanitized);
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
        this._adapter,
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

    await runAsyncOrSync(this._adapter, `UPDATE "${table}" SET ${setCols} WHERE ${clause}`, values);

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
        this._adapter,
        `SELECT * FROM "${table}" WHERE ${clause}`,
        pkParams,
      );
      if (fullRow) this._syncEmbedding(table, 'update', fullRow, auditId);
    }
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

  async delete(table: string, id: PkLookup, provenance?: ChangeProvenance): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;
    this._assertIdent(table);

    const { clause, params } = this._pkWhere(table, id);

    // Capture full row before deletion for changelog
    let previousRow: Row | null = null;
    if (this._changelogTables.has(table)) {
      previousRow =
        (await getAsyncOrSync(this._adapter, `SELECT * FROM "${table}" WHERE ${clause}`, params)) ??
        null;
    }

    await runAsyncOrSync(this._adapter, `DELETE FROM "${table}" WHERE ${clause}`, params);

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

    const { clause, params } = this._pkWhere(table, id);
    const row =
      (await getAsyncOrSync(this._adapter, `SELECT * FROM "${table}" WHERE ${clause}`, params)) ??
      null;
    return row ? this._decryptRow(table, row) : null;
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

    const cols = this._ensureColumnCache(table);
    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(data));

    // Auto-set convention columns
    const withConventions = { ...sanitized };
    if (cols.has('updated_at')) withConventions.updated_at = new Date().toISOString();
    if (opts?.sourceFile && cols.has('source_file')) withConventions.source_file = opts.sourceFile;
    if (opts?.sourceHash && cols.has('source_hash')) withConventions.source_hash = opts.sourceHash;

    // Check if record exists
    const existing = await getAsyncOrSync(
      this._adapter,
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND ${NOT_DELETED}`,
      [naturalKeyVal],
    );

    if (existing) {
      // Update existing
      const encUpdated = this._encryptRow(table, withConventions);
      const entries = Object.entries(encUpdated).filter(([k]) => k !== 'id');
      if (entries.length === 0) return existing.id as string;
      const setCols = entries.map(([k]) => `"${k}" = ?`).join(', ');
      await runAsyncOrSync(this._adapter, `UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
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
    const encInserted = this._encryptRow(table, filtered);
    const colNames = Object.keys(encInserted)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(encInserted)
      .map(() => '?')
      .join(', ');
    await runAsyncOrSync(
      this._adapter,
      `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
      Object.values(encInserted),
    );
    await this._fireWriteHooks(table, 'insert', filtered, id);
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

    const existing = await getAsyncOrSync(
      this._adapter,
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND ${NOT_DELETED}`,
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
    await runAsyncOrSync(this._adapter, `UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
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

    if (currentKeys.length === 0) return 0;

    // Count rows that will be soft-deleted
    const placeholders = currentKeys.map(() => '?').join(', ');
    const countRow = await getAsyncOrSync(
      this._adapter,
      `SELECT COUNT(*) as cnt FROM "${table}"
       WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
       AND ${NOT_DELETED}`,
      [sourceFile, ...currentKeys],
    );
    // Postgres returns COUNT(*) as a string; SQLite returns a number. Coerce
    // so the public Promise<number> contract holds across dialects.
    const count = Number(countRow?.cnt ?? 0);

    if (count > 0) {
      await runAsyncOrSync(
        this._adapter,
        `UPDATE "${table}" SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
         AND ${NOT_DELETED}`,
        [sourceFile, ...currentKeys],
      );
    }
    return count;
  }

  /**
   * Get all non-deleted rows from a table, ordered by the given column.
   * Works on any table, not just defined ones.
   */
  async getActive(table: string, orderBy = 'name'): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;

    const cols = this._ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const order = cols.has(orderBy) ? ` ORDER BY "${orderBy}"` : '';
    return allAsyncOrSync(this._adapter, `SELECT * FROM "${table}"${where}${order}`);
  }

  /**
   * Count non-deleted rows in a table.
   */
  async countActive(table: string): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;

    const cols = this._ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const row = await getAsyncOrSync(
      this._adapter,
      `SELECT COUNT(*) as cnt FROM "${table}"${where}`,
    );
    // Postgres returns COUNT(*) as a string; SQLite returns a number. Coerce
    // so the public Promise<number> contract holds across dialects.
    return Number(row?.cnt ?? 0);
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
    this._assertIdent(table, naturalKeyCol);

    return (
      (await getAsyncOrSync(
        this._adapter,
        `SELECT * FROM "${table}" WHERE "${naturalKeyCol}" = ? AND ${NOT_DELETED}`,
        [naturalKeyVal],
      )) ?? null
    );
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

    const filtered = this._filterToSchemaColumns(junctionTable, data);
    const colNames = Object.keys(filtered)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(filtered)
      .map(() => '?')
      .join(', ');
    const verb = opts?.upsert ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
    await runAsyncOrSync(
      this._adapter,
      `${verb} INTO "${junctionTable}" (${colNames}) VALUES (${placeholders})`,
      Object.values(filtered),
    );
    // Relation rollups (e.g. PROJECTS.md / FILES.md) are link-driven — refresh.
    this._scheduleAutoRender();
  }

  /**
   * Delete rows from a junction table matching all given conditions.
   */
  async unlink(junctionTable: string, conditions: Row): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;

    const entries = Object.entries(conditions);
    if (entries.length === 0) return;
    const where = entries.map(([k]) => `"${k}" = ?`).join(' AND ');
    await runAsyncOrSync(
      this._adapter,
      `DELETE FROM "${junctionTable}" WHERE ${where}`,
      entries.map(([, v]) => v),
    );
    this._scheduleAutoRender();
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

    let upserted = 0;
    let linked = 0;
    let softDeleted = 0;
    const keys: string[] = [];
    const unresolvedLinks: UnresolvedLink[] = [];

    for (const record of config.data) {
      const rawKey = record[config.naturalKey];
      const naturalKeyVal =
        typeof rawKey === 'string' ? rawKey : typeof rawKey === 'number' ? String(rawKey) : '';
      if (!naturalKeyVal) continue;

      keys.push(naturalKeyVal);

      // Upsert the record
      const upsertOpts: import('./types.js').UpsertByNaturalKeyOptions = {};
      if (config.sourceFile) upsertOpts.sourceFile = config.sourceFile;
      if (config.sourceHash) upsertOpts.sourceHash = config.sourceHash;
      if (config.orgId) upsertOpts.orgId = config.orgId;
      await this.upsertByNaturalKey(
        config.table,
        config.naturalKey,
        naturalKeyVal,
        record as Row,
        upsertOpts,
      );
      upserted++;

      // Process links
      if (config.linkTo) {
        const recordId = await this.getByNaturalKey(config.table, config.naturalKey, naturalKeyVal);
        if (!recordId) continue;
        const id = recordId.id as string;

        for (const [field, spec] of Object.entries(config.linkTo)) {
          const names = record[field] as string[] | undefined;
          if (!Array.isArray(names)) continue;

          const resolveTable = spec.resolveTable ?? field;
          for (const name of names) {
            const target = await this.getByNaturalKey(resolveTable, spec.resolveBy, name);
            if (!target) {
              // Reconciliation point: the link's target doesn't exist. Surface
              // it instead of silently dropping (Rule: no silent failures) —
              // otherwise the source row cites a relationship in text but has
              // no link in the graph.
              unresolvedLinks.push({
                record: naturalKeyVal,
                field,
                name,
                junction: spec.junction,
                resolveTable,
                resolveBy: spec.resolveBy,
              });
              continue;
            }

            const linkData: Row = {
              [this._inferFk(config.table)]: id,
              [spec.foreignKey]: target.id,
              ...(spec.extras ?? {}),
            };
            await this.link(spec.junction, linkData);
            linked++;
          }
        }
      }
    }

    // Soft-delete missing
    if (config.softDeleteMissing && config.sourceFile && keys.length > 0) {
      softDeleted = await this.softDeleteMissing(
        config.table,
        config.naturalKey,
        config.sourceFile,
        keys,
      );
    }

    if (config.onUnresolvedLink === 'throw' && unresolvedLinks.length > 0) {
      throw new SeedReconciliationError(config.table, unresolvedLinks);
    }

    return { upserted, linked, softDeleted, unresolvedLinks };
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
      this._adapter,
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
    return searchByEmbedding(
      this._adapter,
      table,
      query,
      def.embeddings,
      opts.topK ?? 10,
      opts.minScore ?? 0,
      pkCol,
    );
  }

  async query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;
    this._assertIdent(table);

    const colErr = this._invalidColumnError<Row[]>(table, [
      ...Object.keys(opts.where ?? {}),
      ...(opts.filters ?? []).map((f) => f.col),
      ...(opts.orderBy ? [opts.orderBy] : []),
    ]);
    if (colErr) return colErr;

    let sql = `SELECT * FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    // Equality where (backward compat shorthand)
    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [col, val] of Object.entries(opts.where)) {
        whereClauses.push(`"${col}" = ?`);
        params.push(val);
      }
    }

    // Advanced filters with full operator support
    if (opts.filters && opts.filters.length > 0) {
      const { clauses, params: fp } = this._buildFilters(opts.filters);
      whereClauses.push(...clauses);
      params.push(...fp);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    if (opts.orderBy) {
      const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
    }
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${opts.limit.toString()}`;
    }
    if (opts.offset !== undefined) {
      if (opts.limit === undefined) sql += ' LIMIT -1';
      sql += ` OFFSET ${opts.offset.toString()}`;
    }

    const rows = await allAsyncOrSync(this._adapter, sql, params);
    return this._decryptRows(table, rows);
  }

  async count(table: string, opts: CountOptions = {}): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;
    this._assertIdent(table);

    const colErr = this._invalidColumnError<number>(table, [
      ...Object.keys(opts.where ?? {}),
      ...(opts.filters ?? []).map((f) => f.col),
    ]);
    if (colErr) return colErr;

    let sql = `SELECT COUNT(*) as n FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [col, val] of Object.entries(opts.where)) {
        whereClauses.push(`"${col}" = ?`);
        params.push(val);
      }
    }

    if (opts.filters && opts.filters.length > 0) {
      const { clauses, params: fp } = this._buildFilters(opts.filters);
      whereClauses.push(...clauses);
      params.push(...fp);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const row = await getAsyncOrSync(this._adapter, sql, params);
    return Number(row?.n ?? 0);
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
   * The guard ({@link _renderGuarded}) holds {@link _autoRenderInFlight} for the
   * render's duration, so a data mutation that lands while this render is in
   * flight is deferred by {@link _runAutoRender} and coalesced — when this
   * render settles, `finally` clears the flag and re-arms exactly one follow-up
   * render via {@link _rearmAutoRenderIfPending}. Net invariant: at most one
   * render to a given dir at a time.
   *
   * Errors propagate to the caller (the GUI surfaces them, never silently swallowed); they are
   * not swallowed here.
   */
  async renderInBackground(outputDir: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const notInit = this._notInitError<RenderResult>();
    if (notInit) return notInit;

    return this._renderGuarded(outputDir, opts);
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

  private static readonly _PK_SEP = '\t';

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

  /** Canonical ACL / change-log `pk` string for a row. Matches `cloud/rls.ts` `pkSqlExpr`. */
  private _serializeRowPk(table: string, row: Row): string {
    const pkCols = this._resolvedPkCols(table);
    const cols = pkCols.length > 0 ? pkCols : ['id'];
    return cols
      .map((c) => {
        const v = row[c];
        return v != null ? String(v as string | number) : '';
      })
      .join(Lattice._PK_SEP);
  }

  /**
   * Canonical `pk` string for a {@link PkLookup} used by update/delete, so a
   * row addressed by lookup keys its change-log entry identically to the way
   * {@link _serializeRowPk} keyed it at insert time.
   */
  private _serializePkLookup(table: string, id: PkLookup): string {
    if (typeof id === 'string') return id; // single-column key — the bare value
    const pkCols = this._resolvedPkCols(table);
    if (pkCols.length === 0) return JSON.stringify(id);
    return pkCols
      .map((c) => {
        const v = id[c];
        return v != null ? String(v as string | number) : '';
      })
      .join(Lattice._PK_SEP);
  }

  /**
   * Convert Filter objects into SQL clause strings and bound params.
   * An `in` filter with an empty array is silently ignored (produces no clause).
   */
  private _buildFilters(filters: Filter[]): {
    clauses: string[];
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const f of filters) {
      const col = `"${f.col}"`;
      switch (f.op) {
        case 'eq':
          clauses.push(`${col} = ?`);
          params.push(f.val);
          break;
        case 'ne':
          clauses.push(`${col} != ?`);
          params.push(f.val);
          break;
        case 'gt':
          clauses.push(`${col} > ?`);
          params.push(f.val);
          break;
        case 'gte':
          clauses.push(`${col} >= ?`);
          params.push(f.val);
          break;
        case 'lt':
          clauses.push(`${col} < ?`);
          params.push(f.val);
          break;
        case 'lte':
          clauses.push(`${col} <= ?`);
          params.push(f.val);
          break;
        case 'like':
          clauses.push(`${col} LIKE ?`);
          params.push(f.val);
          break;
        case 'in': {
          const list = f.val as unknown[];
          if (Array.isArray(list) && list.length > 0) {
            clauses.push(`${col} IN (${list.map(() => '?').join(', ')})`);
            params.push(...list);
          }
          break;
        }
        case 'isNull':
          clauses.push(`${col} IS NULL`);
          break;
        case 'isNotNull':
          clauses.push(`${col} IS NOT NULL`);
          break;
      }
    }

    return { clauses, params };
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
    // enable it by default). No-op + zero overhead when disabled.
    this._scheduleAutoRender();
  }

  /**
   * Turn on automatic rendering into `outputDir`. After this, every insert /
   * update / delete debounce-triggers a re-render (coalesced, so a bulk seed
   * produces a single render, and unchanged files are skipped by the manifest
   * hash-diff). Workspaces enable this by default; a bare `new Lattice(dbPath)`
   * is unaffected unless it opts in.
   */
  enableAutoRender(outputDir: string, opts: { debounceMs?: number } = {}): this {
    this._autoRenderDir = outputDir;
    if (opts.debounceMs != null) this._autoRenderDebounceMs = opts.debounceMs;
    return this;
  }

  /** Turn off automatic rendering and cancel any pending render. */
  disableAutoRender(): this {
    this._autoRenderDir = undefined;
    if (this._autoRenderTimer) {
      clearTimeout(this._autoRenderTimer);
      this._autoRenderTimer = undefined;
    }
    this._autoRenderPending = false;
    return this;
  }

  private _scheduleAutoRender(): void {
    if (!this._autoRenderDir) return;
    this._autoRenderPending = true;
    if (this._autoRenderTimer) return;
    this._autoRenderTimer = setTimeout(() => {
      this._autoRenderTimer = undefined;
      void this._runAutoRender();
    }, this._autoRenderDebounceMs);
    // Don't keep the event loop alive solely for a pending auto-render.
    this._autoRenderTimer.unref();
  }

  /**
   * Shared single-flight render path used by {@link renderInBackground}.
   *
   * Holds {@link _autoRenderInFlight} for the render's duration so the
   * mutation-driven {@link _runAutoRender} defers while this render runs (it
   * sees the flag and marks itself pending instead of starting a second,
   * overlapping render). On settle, `finally` clears the flag and re-arms a
   * single coalesced follow-up render if any mutation arrived mid-flight.
   * Errors propagate to the caller; the flag is always cleared.
   */
  private async _renderGuarded(outputDir: string, opts: RenderOptions): Promise<RenderResult> {
    // If an auto-render is already in flight, wait for it to clear before
    // claiming the guard so the two never overlap on the same dir.
    while (this._autoRenderInFlight) {
      await new Promise((r) => setImmediate(r));
    }
    this._autoRenderInFlight = true;
    try {
      const result = await this._render.render(outputDir, opts);
      for (const h of this._renderHandlers) h(result);
      return result;
    } finally {
      this._autoRenderInFlight = false;
      // A mutation may have arrived during the render (hitting the in-flight
      // guard in _runAutoRender without arming a timer); re-arm so exactly one
      // coalesced follow-up render runs.
      this._rearmAutoRenderIfPending();
    }
  }

  private async _runAutoRender(): Promise<void> {
    const dir = this._autoRenderDir;
    if (!dir || !this._initialized) return;
    if (this._autoRenderInFlight) {
      // A render is mid-flight (auto-render OR a guarded background render);
      // mark pending and re-arm when it finishes so we coalesce into exactly
      // one follow-up render rather than overlapping.
      this._autoRenderPending = true;
      return;
    }
    if (!this._autoRenderPending) return;
    this._autoRenderPending = false;
    this._autoRenderInFlight = true;
    try {
      const result = await this._render.render(dir);
      for (const h of this._renderHandlers) h(result);
    } catch (err) {
      for (const h of this._errorHandlers) h(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._autoRenderInFlight = false;
      // Mutations may have arrived while the render was in flight (and hit the
      // in-flight guard above without arming a timer); re-arm if so.
      this._rearmAutoRenderIfPending();
    }
  }

  private _rearmAutoRenderIfPending(): void {
    if (this._autoRenderPending) this._scheduleAutoRender();
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

    if (op === 'delete') {
      removeEmbedding(this._adapter, table, pk).catch(handle);
      return;
    }

    storeEmbedding(this._adapter, table, pk, row, def.embeddings).catch(handle);
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
    if (this.getDialect() === 'postgres') {
      const row = (await getAsyncOrSync(
        this._adapter,
        `SELECT to_regclass('__lattice_changelog') AS reg`,
      )) as { reg?: string | null } | undefined;
      return !!row && row.reg != null;
    }
    const row = (await getAsyncOrSync(
      this._adapter,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='__lattice_changelog'`,
    )) as { name?: string } | undefined;
    return !!row;
  }

  private async _ensureChangelogTable(): Promise<void> {
    // `created_at` default is dialect-specific: SQLite's `strftime` isn't valid
    // Postgres, and a cloud change-log (the per-viewer observation substrate)
    // must create cleanly on Postgres. Both produce a sortable ISO-8601 string;
    // every write also passes `created_at` explicitly (see _writeChangelogRow),
    // so the default only matters for any out-of-band insert.
    const createdAtDefault =
      this.getDialect() === 'postgres'
        ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
    await runAsyncOrSync(
      this._adapter,
      `
      CREATE TABLE IF NOT EXISTS __lattice_changelog (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changes TEXT,
        previous TEXT,
        source TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT ${createdAtDefault},
        source_ref TEXT,
        change_kind TEXT,
        superseded_by TEXT,
        audience TEXT,
        source_sensitive INTEGER NOT NULL DEFAULT 0
      )
    `,
    );
    // Idempotent additive migration for change-logs created before 3.0:
    // introspect the live columns and ALTER in any provenance column that is
    // missing. Each is nullable or defaulted, so existing rows + readers are
    // unaffected. (CREATE TABLE IF NOT EXISTS above only covers fresh DBs.)
    const existing = new Set(
      await introspectColumnsAsyncOrSync(this._adapter, '__lattice_changelog'),
    );
    const additive: [string, string][] = [
      ['source_ref', 'TEXT'],
      ['change_kind', 'TEXT'],
      ['superseded_by', 'TEXT'],
      ['audience', 'TEXT'],
      ['source_sensitive', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, type] of additive) {
      if (!existing.has(col)) {
        await runAsyncOrSync(
          this._adapter,
          `ALTER TABLE __lattice_changelog ADD COLUMN ${col} ${type}`,
        );
      }
    }
    // Monotonic insertion order. SQLite has `rowid` natively; Postgres needs an
    // explicit identity column — ordering by `created_at` alone ties when two
    // entries land in the same millisecond (the uuid `id` is no tiebreak), which
    // corrupts history/replay order. The change feed uses the same pattern.
    if (this.getDialect() === 'postgres' && !existing.has('seq')) {
      await runAsyncOrSync(
        this._adapter,
        `ALTER TABLE __lattice_changelog ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY`,
      );
    }
    await runAsyncOrSync(
      this._adapter,
      `
      CREATE INDEX IF NOT EXISTS idx_changelog_row
      ON __lattice_changelog (table_name, row_id, created_at)
    `,
    );
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
    if (!this._changelogTables.has(table)) return;
    await this._writeChangelogRow(table, rowId, operation, changes, previous, source, reason, prov);
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
    const id = uuidv4();
    // Normalize the source-set to a JSON array string for the source_ref column.
    const sourceRef =
      prov?.sourceRef == null
        ? null
        : JSON.stringify(Array.isArray(prov.sourceRef) ? prov.sourceRef : [prov.sourceRef]);
    // Stamp created_at explicitly so the value + ordering are identical on SQLite
    // and Postgres (the column default differs per dialect; see _ensureChangelogTable).
    const createdAt = new Date().toISOString();
    await runAsyncOrSync(
      this._adapter,
      `INSERT INTO __lattice_changelog
         (id, table_name, row_id, operation, changes, previous, source, reason,
          source_ref, change_kind, superseded_by, audience, source_sensitive, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        table,
        rowId,
        operation,
        changes ? JSON.stringify(changes) : null,
        previous ? JSON.stringify(previous) : null,
        source ?? null,
        reason ?? prov?.reason ?? null,
        sourceRef,
        prov?.changeKind ?? null,
        prov?.supersededBy ?? null,
        prov?.audience ?? null,
        prov?.sourceSensitive ? 1 : 0,
        createdAt,
      ],
    );
  }

  /** Prune changelog entries based on retention policy. */
  private async _pruneChangelog(): Promise<void> {
    const opts = this._changelogOptions;
    if (!opts) return;

    if (opts.retentionDays != null && opts.retentionDays > 0) {
      await runAsyncOrSync(
        this._adapter,
        `DELETE FROM __lattice_changelog
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
        [`-${String(opts.retentionDays)} days`],
      );
    }

    if (opts.maxEntriesPerRow != null && opts.maxEntriesPerRow > 0) {
      // Delete entries beyond the max per (table_name, row_id), keeping the newest
      await runAsyncOrSync(
        this._adapter,
        `DELETE FROM __lattice_changelog WHERE id IN (
           SELECT c.id FROM __lattice_changelog c
           INNER JOIN (
             SELECT table_name, row_id, COUNT(*) as cnt
             FROM __lattice_changelog
             GROUP BY table_name, row_id
             HAVING cnt > ?
           ) g ON c.table_name = g.table_name AND c.row_id = g.row_id
           WHERE c.created_at <= (
             SELECT created_at FROM __lattice_changelog c2
             WHERE c2.table_name = c.table_name AND c2.row_id = c.row_id
             ORDER BY c2.created_at DESC
             LIMIT 1 OFFSET ?
           )
         )`,
        [opts.maxEntriesPerRow, opts.maxEntriesPerRow],
      );
    }
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

/**
 * Thrown by {@link Lattice.seed} when `onUnresolvedLink: 'throw'` is set and
 * one or more junction links could not be created because their target rows
 * did not resolve. Carries the full list so the caller can report or
 * reconcile every missing target at once rather than discovering them one
 * silent drop at a time.
 */
export class SeedReconciliationError extends Error {
  constructor(
    public readonly table: string,
    public readonly unresolvedLinks: UnresolvedLink[],
  ) {
    const detail = unresolvedLinks
      .map((u) => `${u.field}="${u.name}" (→ ${u.resolveTable}.${u.resolveBy})`)
      .join(', ');
    super(
      `seed("${table}"): ${String(unresolvedLinks.length)} unresolved link(s) — ` +
        `target row(s) not found: ${detail}. Create the missing target(s) and re-seed.`,
    );
    this.name = 'SeedReconciliationError';
  }
}

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
