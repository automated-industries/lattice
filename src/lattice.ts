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
  WriteHook,
  WriteHookContext,
  SeedConfig,
  SeedResult,
  ReportConfig,
  ReportResult,
  ReportSectionResult,
  EntityContextDefinition,
  ReconcileOptions,
  ReconcileResult,
  SearchOptions,
  SearchResult,
  ChangelogOptions,
  ChangeEntry,
} from './types.js';
import { readManifest } from './lifecycle/manifest.js';
import type Database from 'better-sqlite3';
import { SQLiteAdapter } from './db/sqlite.js';
import { SchemaManager } from './schema/manager.js';
import type { CompiledTableDef } from './schema/manager.js';
import { Sanitizer } from './security/sanitize.js';
import { RenderEngine } from './render/engine.js';
import { ReverseSyncEngine } from './reverse-sync/engine.js';
import { SyncLoop } from './sync/loop.js';
import { WritebackPipeline } from './writeback/pipeline.js';
import { compileRender } from './render/templates.js';
import { parseConfigFile } from './config/parser.js';
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

export class Lattice {
  private readonly _adapter: SQLiteAdapter;
  private readonly _schema: SchemaManager;
  private readonly _sanitizer: Sanitizer;
  private readonly _render: RenderEngine;
  private readonly _reverseSync: ReverseSyncEngine;
  private readonly _loop: SyncLoop;
  private readonly _writeback: WritebackPipeline;
  private _initialized = false;

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
  private readonly _writeHooks: WriteHook[] = [];

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

    const adapterOpts: { wal?: boolean; busyTimeout?: number } = {};
    if (options.wal !== undefined) adapterOpts.wal = options.wal;
    if (options.busyTimeout !== undefined) adapterOpts.busyTimeout = options.busyTimeout;
    this._adapter = new SQLiteAdapter(dbPath, adapterOpts);
    this._schema = new SchemaManager();
    this._sanitizer = new Sanitizer(options.security);
    this._render = new RenderEngine(this._schema, this._adapter, () => this._taskContext);
    this._reverseSync = new ReverseSyncEngine(this._schema, this._adapter);
    this._loop = new SyncLoop(this._render);
    this._writeback = new WritebackPipeline();

    if (options.encryptionKey) this._encryptionKeyRaw = options.encryptionKey;
    if (options.changelog) this._changelogOptions = options.changelog;

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

  define(table: string, def: TableDefinition): this {
    this._assertNotInit('define');

    // Auto-inject reward tracking columns
    const columns = def.rewardTracking
      ? { ...def.columns, _reward_total: 'REAL DEFAULT 0', _reward_count: 'INTEGER DEFAULT 0' }
      : def.columns;

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
        : () => '',
      outputFile: def.outputFile ?? `.schema-only/${table}.md`,
    };
    this._schema.define(table, compiledDef);
    if (def.changelog) this._changelogTables.add(table);
    return this;
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
    if (this._initialized) {
      return Promise.reject(new Error('Lattice: init() has already been called'));
    }
    this._adapter.open();
    this._schema.applySchema(this._adapter);
    if (options.migrations?.length) {
      this._schema.applyMigrations(this._adapter, options.migrations);
    }
    // Snapshot actual columns post-migration: schema state only includes declared
    // columns, so migration-added columns would be stripped by _filterToSchemaColumns
    // without this PRAGMA-based cache.
    for (const tableName of this._schema.getTables().keys()) {
      const rows = this._adapter.all(`PRAGMA table_info("${tableName}")`);
      this._columnCache.set(tableName, new Set(rows.map((r) => r.name as string)));
    }

    // Create embeddings table if any table uses embeddings
    const hasEmbeddings = [...this._schema.getTables().values()].some((d) => d.embeddings);
    if (hasEmbeddings) {
      ensureEmbeddingsTable(this._adapter);
    }

    // Create changelog table if any table uses changelog tracking
    if (this._changelogTables.size > 0) {
      this._ensureChangelogTable();
      this._pruneChangelog();
    }

    // Set up encryption for entity contexts that declare encrypted: true|{columns}
    this._setupEncryption();

    this._initialized = true;
    return Promise.resolve();
  }

  /**
   * Run additional migrations after init(). Useful for package-level schema
   * changes applied at runtime (e.g. update hooks that add columns).
   *
   * @since 0.17.0
   */
  migrate(migrations: Migration[]): Promise<void> {
    if (!this._initialized) {
      return Promise.reject(new Error('Lattice: not initialized — call init() first'));
    }
    this._schema.applyMigrations(this._adapter, migrations);
    // Refresh column cache for any tables affected by migrations
    for (const tableName of this._schema.getTables().keys()) {
      const rows = this._adapter.all(`PRAGMA table_info("${tableName}")`);
      this._columnCache.set(tableName, new Set(rows.map((r) => r.name as string)));
    }
    return Promise.resolve();
  }

  close(): void {
    this._adapter.close();
    this._columnCache.clear();
    this._encryptedTableColumns.clear();
    delete this._encryptionKey;
    this._initialized = false;
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

  private _setupEncryption(): void {
    for (const [table, def] of this._schema.getEntityContexts()) {
      if (!def.encrypted) continue;
      if (!this._encryptionKeyRaw) {
        throw new Error(
          `Entity context "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
        );
      }
      this._encryptionKey ??= deriveKey(this._encryptionKeyRaw);
      // Get actual column names from the DB
      const pragmaRows = this._adapter.all(`PRAGMA table_info("${table}")`);
      const allCols = pragmaRows.map((r) => r.name as string);
      const encCols = resolveEncryptedColumns(def.encrypted, allCols);
      this._encryptedTableColumns.set(table, encCols);
    }
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

  insert(table: string, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

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

    this._adapter.run(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`, values);

    // pkCols[0] is always defined — validated non-empty in SchemaManager.define()
    const pkCol = pkCols[0] ?? 'id';
    const rawPk = rowWithPk[pkCol];
    const pkValue = rawPk != null ? String(rawPk as string | number) : '';
    this._appendChangelog(table, pkValue, 'insert', rowWithPk, null);
    this._sanitizer.emitAudit(table, 'insert', pkValue);
    this._fireWriteHooks(table, 'insert', rowWithPk, pkValue);
    this._syncEmbedding(table, 'insert', rowWithPk, pkValue);
    return Promise.resolve(pkValue);
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

  upsert(table: string, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

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

    this._adapter.run(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${updateCols}`,
      values,
    );

    // pkCols[0] is always defined — validated non-empty in SchemaManager.define()
    const pkCol = pkCols[0] ?? 'id';
    const rawPk = rowWithPk[pkCol];
    const pkValue = rawPk != null ? String(rawPk as string | number) : '';
    this._sanitizer.emitAudit(table, 'update', pkValue);
    return Promise.resolve(pkValue);
  }

  upsertBy(table: string, col: string, val: unknown, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

    const existing = this._adapter.get(`SELECT * FROM "${table}" WHERE "${col}" = ?`, [val]);
    if (existing) {
      const pkCols = this._schema.getPrimaryKey(table);
      // pkCols[0] is always defined — validated non-empty in SchemaManager.define()
      const pkLookup: PkLookup =
        pkCols.length === 1
          ? String(existing[pkCols[0] ?? 'id'] as string | number)
          : Object.fromEntries(pkCols.map((c) => [c, existing[c]]));
      return this.update(table, pkLookup, row).then(() =>
        typeof pkLookup === 'string' ? pkLookup : JSON.stringify(pkLookup),
      );
    }
    return this.insert(table, { ...row, [col]: val });
  }

  update(table: string, id: PkLookup, row: Partial<Row>): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(row as Row));
    const encrypted = this._encryptRow(table, sanitized);
    const setCols = Object.keys(encrypted)
      .map((c) => `"${c}" = ?`)
      .join(', ');

    const { clause, params: pkParams } = this._pkWhere(table, id);

    // Capture previous values before the write for changelog
    let previousValues: Record<string, unknown> | null = null;
    if (this._changelogTables.has(table)) {
      const current = this._adapter.get(`SELECT * FROM "${table}" WHERE ${clause}`, pkParams);
      if (current) {
        previousValues = {};
        for (const col of Object.keys(sanitized)) {
          previousValues[col] = current[col];
        }
      }
    }

    const values = [...Object.values(encrypted), ...pkParams];

    this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE ${clause}`, values);

    const auditId = typeof id === 'string' ? id : JSON.stringify(id);
    this._appendChangelog(table, auditId, 'update', sanitized, previousValues);
    this._sanitizer.emitAudit(table, 'update', auditId);
    this._fireWriteHooks(table, 'update', sanitized, auditId, Object.keys(sanitized));
    // Re-fetch full row for embedding recomputation
    const def = this._schema.getTables().get(table);
    if (def?.embeddings) {
      const fullRow = this._adapter.get(`SELECT * FROM "${table}" WHERE ${clause}`, pkParams);
      if (fullRow) this._syncEmbedding(table, 'update', fullRow, auditId);
    }
    return Promise.resolve();
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

  delete(table: string, id: PkLookup): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    const { clause, params } = this._pkWhere(table, id);

    // Capture full row before deletion for changelog
    let previousRow: Row | null = null;
    if (this._changelogTables.has(table)) {
      previousRow = this._adapter.get(`SELECT * FROM "${table}" WHERE ${clause}`, params) ?? null;
    }

    this._adapter.run(`DELETE FROM "${table}" WHERE ${clause}`, params);

    const auditId = typeof id === 'string' ? id : JSON.stringify(id);
    this._appendChangelog(
      table,
      auditId,
      'delete',
      null,
      previousRow as Record<string, unknown> | null,
    );
    this._sanitizer.emitAudit(table, 'delete', auditId);
    this._fireWriteHooks(table, 'delete', { id: auditId }, auditId);
    this._syncEmbedding(table, 'delete', {}, auditId);
    return Promise.resolve();
  }

  get(table: string, id: PkLookup): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;

    const { clause, params } = this._pkWhere(table, id);
    const row = this._adapter.get(`SELECT * FROM "${table}" WHERE ${clause}`, params) ?? null;
    return Promise.resolve(row ? this._decryptRow(table, row) : null);
  }

  // -------------------------------------------------------------------------
  // Generic CRUD — works on ANY table (v0.11+)
  // -------------------------------------------------------------------------

  /**
   * Upsert a record by natural key. If a non-deleted record with the given
   * natural key exists, update it. Otherwise insert with a new UUID.
   * Auto-handles `org_id`, `updated_at`, `deleted_at`, `source_file`, `source_hash`.
   */
  upsertByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
    data: Row,
    opts?: import('./types.js').UpsertByNaturalKeyOptions,
  ): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

    const cols = this._ensureColumnCache(table);
    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(data));

    // Auto-set convention columns
    const withConventions = { ...sanitized };
    if (cols.has('updated_at')) withConventions.updated_at = new Date().toISOString();
    if (opts?.sourceFile && cols.has('source_file')) withConventions.source_file = opts.sourceFile;
    if (opts?.sourceHash && cols.has('source_hash')) withConventions.source_hash = opts.sourceHash;

    // Check if record exists
    const existing = this._adapter.get(
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND (deleted_at IS NULL OR deleted_at = '')`,
      [naturalKeyVal],
    );

    if (existing) {
      // Update existing
      const encUpdated = this._encryptRow(table, withConventions);
      const entries = Object.entries(encUpdated).filter(([k]) => k !== 'id');
      if (entries.length === 0) return Promise.resolve(existing.id as string);
      const setCols = entries.map(([k]) => `"${k}" = ?`).join(', ');
      this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
        ...entries.map(([, v]) => v),
        existing.id,
      ]);
      this._fireWriteHooks(
        table,
        'update',
        withConventions,
        existing.id as string,
        Object.keys(sanitized),
      );
      return Promise.resolve(existing.id as string);
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
    this._adapter.run(
      `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
      Object.values(encInserted),
    );
    this._fireWriteHooks(table, 'insert', filtered, id);
    return Promise.resolve(id);
  }

  /**
   * Sparse update by natural key — only writes non-null fields on an existing record.
   * Returns true if a row was found and updated.
   */
  enrichByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
    data: Row,
  ): Promise<boolean> {
    const notInit = this._notInitError<boolean>();
    if (notInit) return notInit;

    const existing = this._adapter.get(
      `SELECT id FROM "${table}" WHERE "${naturalKeyCol}" = ? AND (deleted_at IS NULL OR deleted_at = '')`,
      [naturalKeyVal],
    );
    if (!existing) return Promise.resolve(false);

    const sanitized = this._filterToSchemaColumns(table, this._sanitizer.sanitizeRow(data));
    const entries = Object.entries(sanitized).filter(
      ([k, v]) => v !== null && v !== undefined && k !== 'id',
    );
    if (entries.length === 0) return Promise.resolve(true);

    const cols = this._ensureColumnCache(table);
    const withTs = [...entries];
    if (cols.has('updated_at')) withTs.push(['updated_at', new Date().toISOString()]);

    const setCols = withTs.map(([k]) => `"${k}" = ?`).join(', ');
    this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE id = ?`, [
      ...withTs.map(([, v]) => v),
      existing.id,
    ]);
    this._fireWriteHooks(
      table,
      'update',
      Object.fromEntries(entries),
      existing.id as string,
      entries.map(([k]) => k),
    );
    return Promise.resolve(true);
  }

  /**
   * Soft-delete records from a source file whose natural key is NOT in the given set.
   * Returns count of rows soft-deleted.
   */
  softDeleteMissing(
    table: string,
    naturalKeyCol: string,
    sourceFile: string,
    currentKeys: string[],
  ): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;

    if (currentKeys.length === 0) return Promise.resolve(0);

    // Count rows that will be soft-deleted
    const placeholders = currentKeys.map(() => '?').join(', ');
    const countRow = this._adapter.get(
      `SELECT COUNT(*) as cnt FROM "${table}"
       WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
       AND (deleted_at IS NULL OR deleted_at = '')`,
      [sourceFile, ...currentKeys],
    ) as { cnt: number } | undefined;
    const count = countRow?.cnt ?? 0;

    if (count > 0) {
      this._adapter.run(
        `UPDATE "${table}" SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE source_file = ? AND "${naturalKeyCol}" NOT IN (${placeholders})
         AND (deleted_at IS NULL OR deleted_at = '')`,
        [sourceFile, ...currentKeys],
      );
    }
    return Promise.resolve(count);
  }

  /**
   * Get all non-deleted rows from a table, ordered by the given column.
   * Works on any table, not just defined ones.
   */
  getActive(table: string, orderBy = 'name'): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;

    const cols = this._ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const order = cols.has(orderBy) ? ` ORDER BY "${orderBy}"` : '';
    return Promise.resolve(this._adapter.all(`SELECT * FROM "${table}"${where}${order}`));
  }

  /**
   * Count non-deleted rows in a table.
   */
  countActive(table: string): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;

    const cols = this._ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const row = this._adapter.get(`SELECT COUNT(*) as cnt FROM "${table}"${where}`) as {
      cnt: number;
    };
    return Promise.resolve(row.cnt);
  }

  /**
   * Lookup a single row by natural key (non-deleted).
   */
  getByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
  ): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;

    return Promise.resolve(
      this._adapter.get(
        `SELECT * FROM "${table}" WHERE "${naturalKeyCol}" = ? AND (deleted_at IS NULL OR deleted_at = '')`,
        [naturalKeyVal],
      ) ?? null,
    );
  }

  /**
   * Insert a row into a junction table. Uses INSERT OR IGNORE by default
   * (idempotent). Pass `{ upsert: true }` for INSERT OR REPLACE.
   */
  link(junctionTable: string, data: Row, opts?: import('./types.js').LinkOptions): Promise<void> {
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
    this._adapter.run(
      `${verb} INTO "${junctionTable}" (${colNames}) VALUES (${placeholders})`,
      Object.values(filtered),
    );
    return Promise.resolve();
  }

  /**
   * Delete rows from a junction table matching all given conditions.
   */
  unlink(junctionTable: string, conditions: Row): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;

    const entries = Object.entries(conditions);
    if (entries.length === 0) return Promise.resolve();
    const where = entries.map(([k]) => `"${k}" = ?`).join(' AND ');
    this._adapter.run(
      `DELETE FROM "${junctionTable}" WHERE ${where}`,
      entries.map(([, v]) => v),
    );
    return Promise.resolve();
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
            if (!target) continue;

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

    return { upserted, linked, softDeleted };
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

    const since = this._resolveSince(config.since);
    const sections: ReportSectionResult[] = [];
    let allEmpty = true;

    for (const section of config.sections) {
      const cols = this._ensureColumnCache(section.query.table);
      const hasTimestamp = cols.has('timestamp');
      const conditions: string[] = [];
      const params: unknown[] = [];

      // Time window filter
      if (hasTimestamp) {
        conditions.push('timestamp >= ?');
        params.push(since);
      }

      // Soft-delete exclusion
      if (cols.has('deleted_at')) {
        conditions.push('deleted_at IS NULL');
      }

      // User filters
      if (section.query.filters) {
        for (const f of section.query.filters) {
          switch (f.op) {
            case 'eq':
              conditions.push(`"${f.col}" = ?`);
              params.push(f.val);
              break;
            case 'ne':
              conditions.push(`"${f.col}" != ?`);
              params.push(f.val);
              break;
            case 'gt':
              conditions.push(`"${f.col}" > ?`);
              params.push(f.val);
              break;
            case 'gte':
              conditions.push(`"${f.col}" >= ?`);
              params.push(f.val);
              break;
            case 'lt':
              conditions.push(`"${f.col}" < ?`);
              params.push(f.val);
              break;
            case 'lte':
              conditions.push(`"${f.col}" <= ?`);
              params.push(f.val);
              break;
            case 'like':
              conditions.push(`"${f.col}" LIKE ?`);
              params.push(f.val);
              break;
            case 'isNull':
              conditions.push(`"${f.col}" IS NULL`);
              break;
            case 'isNotNull':
              conditions.push(`"${f.col}" IS NOT NULL`);
              break;
            case 'in': {
              const arr = f.val as unknown[];
              if (arr.length > 0) {
                conditions.push(`"${f.col}" IN (${arr.map(() => '?').join(', ')})`);
                params.push(...arr);
              }
              break;
            }
          }
        }
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const orderBy = section.query.orderBy
        ? ` ORDER BY "${section.query.orderBy}" ${section.query.orderDir === 'desc' ? 'DESC' : 'ASC'}`
        : '';
      const limit = section.query.limit ? ` LIMIT ${String(section.query.limit)}` : '';

      const rows = this._adapter.all(
        `SELECT * FROM "${section.query.table}"${where}${orderBy}${limit}`,
        params,
      );

      if (rows.length > 0) allEmpty = false;

      // Format
      let formatted = '';
      if (section.format === 'custom' && section.customFormat) {
        formatted = section.customFormat(rows);
      } else if (section.format === 'counts' && section.query.groupBy) {
        const groups = new Map<string, number>();
        for (const row of rows) {
          const rawGroupVal = row[section.query.groupBy];
          const type =
            typeof rawGroupVal === 'string'
              ? rawGroupVal
              : typeof rawGroupVal === 'number'
                ? String(rawGroupVal)
                : 'other';
          const prefix = type.includes('.') ? (type.split('.')[0] ?? type) : type;
          groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
        }
        formatted = [...groups.entries()].map(([k, v]) => `${k}: ${String(v)}`).join('\n');
      } else if (section.format === 'count_and_list') {
        const label = (r: Row): string => {
          const v = r.summary ?? r.name ?? r.title;
          return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(r);
        };
        formatted = `Count: ${String(rows.length)}\n` + rows.map((r) => `- ${label(r)}`).join('\n');
      } else {
        const label = (r: Row): string => {
          const v = r.summary ?? r.name ?? r.title;
          return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(r);
        };
        formatted = rows.map((r) => `- ${label(r)}`).join('\n');
      }

      sections.push({ name: section.name, rows, count: rows.length, formatted });
    }

    return { sections, isEmpty: allEmpty, since };
  }

  /** Parse duration shorthand ('8h', '24h', '7d') into ISO timestamp. */
  private _resolveSince(since: string): string {
    const match = /^(\d+)([hmd])$/.exec(since);
    if (!match) return since; // assume ISO timestamp
    const [, numStr, unit] = match;
    const num = parseInt(numStr ?? '0', 10);
    const ms = unit === 'h' ? num * 3600000 : unit === 'd' ? num * 86400000 : num * 60000;
    return new Date(Date.now() - ms).toISOString();
  }

  // -------------------------------------------------------------------------
  // Reward tracking
  // -------------------------------------------------------------------------

  /**
   * Update reward scores for a row. The total reward is recalculated as
   * the running average across all reward calls. Requires `rewardTracking`
   * on the table definition.
   */
  reward(table: string, id: PkLookup, scores: import('./types.js').RewardScores): Promise<void> {
    const notInit = this._notInitError<undefined>();
    if (notInit) return notInit;

    const def = this._schema.getTables().get(table);
    if (!def?.rewardTracking) {
      return Promise.reject(new Error(`Table "${table}" does not have rewardTracking enabled`));
    }

    // Compute the average of provided dimension scores
    const vals = Object.values(scores);
    if (vals.length === 0) return Promise.resolve();
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

    const { clause, params: pkParams } = this._pkWhere(table, id);
    // Incremental running average: new_total = (old_total * old_count + avg) / (old_count + 1)
    this._adapter.run(
      `UPDATE "${table}" SET "_reward_total" = ("_reward_total" * "_reward_count" + ?) / ("_reward_count" + 1), "_reward_count" = "_reward_count" + 1 WHERE ${clause}`,
      [avg, ...pkParams],
    );
    return Promise.resolve();
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

  query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;

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

    return Promise.resolve(this._decryptRows(table, this._adapter.all(sql, params)));
  }

  count(table: string, opts: CountOptions = {}): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;

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

    const row = this._adapter.get(sql, params);
    return Promise.resolve(Number(row?.n ?? 0));
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async render(outputDir: string): Promise<RenderResult> {
    const notInit = this._notInitError<RenderResult>();
    if (notInit) return notInit;

    const result = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(result);
    return result;
  }

  async sync(outputDir: string): Promise<SyncResult> {
    const notInit = this._notInitError<SyncResult>();
    if (notInit) return notInit;

    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    const writebackProcessed = await this._writeback.process();

    return { ...renderResult, writebackProcessed };
  }

  async reconcile(outputDir: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const notInit = this._notInitError<ReconcileResult>();
    if (notInit) return notInit;

    // Read previous manifest BEFORE render so cleanup can detect orphans
    const prevManifest = readManifest(outputDir);

    // Reverse-sync phase: detect external file edits and sweep them back into DB.
    // Runs before render so the render phase writes from the now-updated DB state.
    // Disabled by `reverseSync: false`. Dry-run with `reverseSync: 'dry-run'`.
    let reverseSyncResult: import('./types.js').ReverseSyncResult | null = null;
    if (options.reverseSync !== false) {
      const dryRun = options.reverseSync === 'dry-run';
      reverseSyncResult = this._reverseSync.process(outputDir, prevManifest, dryRun);
    }

    // Render (writes new manifest with updated hashes)
    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    // Read the new manifest just written by render
    const newManifest = readManifest(outputDir);

    // Run cleanup after render, passing both old and new manifests.
    // Old manifest: detects orphaned directories (deleted entities).
    // New manifest: detects stale files in surviving entities (omitIfEmpty, removed files).
    const cleanup = this._render.cleanup(outputDir, prevManifest, options, newManifest);

    return { ...renderResult, cleanup, reverseSync: reverseSyncResult };
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
  on(event: 'error', handler: EventHandler<Error>): this;
  on(
    event: LatticeEvent['type'],
    handler:
      | EventHandler<AuditEvent>
      | EventHandler<RenderResult>
      | EventHandler<{ filePath: string; entriesProcessed: number }>
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
      case 'error':
        this._errorHandlers.push(handler as EventHandler<Error>);
        break;
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Escape hatch
  // -------------------------------------------------------------------------

  get db(): Database.Database {
    return this._adapter.db;
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
  /** Lazily populate column cache for tables not registered via define(). */
  private _ensureColumnCache(table: string): Set<string> {
    let cols = this._columnCache.get(table);
    if (!cols) {
      const rows = this._adapter.all(`PRAGMA table_info("${table}")`);
      cols = new Set(rows.map((r) => r.name as string));
      if (cols.size > 0) this._columnCache.set(table, cols);
    }
    return cols;
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
  private _fireWriteHooks(
    table: string,
    op: 'insert' | 'update' | 'delete',
    row: Row,
    pk: string,
    changedColumns?: string[],
  ): void {
    for (const hook of this._writeHooks) {
      if (hook.table !== table) continue;
      if (!hook.on.includes(op)) continue;
      if (op === 'update' && hook.watchColumns && changedColumns) {
        if (!hook.watchColumns.some((c) => changedColumns.includes(c))) continue;
      }
      try {
        const ctx: WriteHookContext = { table, op, row, pk };
        if (changedColumns) ctx.changedColumns = changedColumns;
        hook.handler(ctx);
      } catch (err) {
        // Hook errors must not crash the caller
        for (const h of this._errorHandlers) h(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Update or remove the embedding for a row.
   * No-op if the table doesn't have `embeddings` configured.
   */
  private _syncEmbedding(
    table: string,
    op: 'insert' | 'update' | 'delete',
    row: Row,
    pk: string,
  ): void {
    const def = this._schema.getTables().get(table);
    if (!def?.embeddings) return;

    if (op === 'delete') {
      removeEmbedding(this._adapter, table, pk);
      return;
    }

    // For insert/update, compute and store embedding asynchronously.
    // Errors are emitted via the error handlers, never thrown.
    storeEmbedding(this._adapter, table, pk, row, def.embeddings).catch((err: unknown) => {
      for (const h of this._errorHandlers) {
        h(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Changelog internals
  // -------------------------------------------------------------------------

  /** Create the __lattice_changelog table and index. */
  private _ensureChangelogTable(): void {
    this._adapter.run(`
      CREATE TABLE IF NOT EXISTS __lattice_changelog (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changes TEXT,
        previous TEXT,
        source TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    this._adapter.run(`
      CREATE INDEX IF NOT EXISTS idx_changelog_row
      ON __lattice_changelog (table_name, row_id, created_at)
    `);
  }

  /** Append a changelog entry if the table has changelog enabled. */
  private _appendChangelog(
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
  ): void {
    if (!this._changelogTables.has(table)) return;
    const id = uuidv4();
    this._adapter.run(
      `INSERT INTO __lattice_changelog (id, table_name, row_id, operation, changes, previous, source, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        table,
        rowId,
        operation,
        changes ? JSON.stringify(changes) : null,
        previous ? JSON.stringify(previous) : null,
        source ?? null,
        reason ?? null,
      ],
    );
  }

  /** Prune changelog entries based on retention policy. */
  private _pruneChangelog(): void {
    const opts = this._changelogOptions;
    if (!opts) return;

    if (opts.retentionDays != null && opts.retentionDays > 0) {
      this._adapter.run(
        `DELETE FROM __lattice_changelog
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
        [`-${String(opts.retentionDays)} days`],
      );
    }

    if (opts.maxEntriesPerRow != null && opts.maxEntriesPerRow > 0) {
      // Delete entries beyond the max per (table_name, row_id), keeping the newest
      this._adapter.run(
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
  private _parseChangeEntry(row: Row): ChangeEntry {
    return {
      id: row.id as string,
      table: row.table_name as string,
      rowId: row.row_id as string,
      operation: row.operation as ChangeEntry['operation'],
      changes: row.changes ? (JSON.parse(row.changes as string) as Record<string, unknown>) : null,
      previous: row.previous
        ? (JSON.parse(row.previous as string) as Record<string, unknown>)
        : null,
      source: row.source != null ? (row.source as string) : null,
      reason: row.reason != null ? (row.reason as string) : null,
      createdAt: row.created_at as string,
    };
  }

  // -------------------------------------------------------------------------
  // Changelog public API
  // -------------------------------------------------------------------------

  /**
   * Get change history for a specific row, newest first.
   */
  history(table: string, id: string, opts?: { limit?: number }): Promise<ChangeEntry[]> {
    const notInit = this._notInitError<ChangeEntry[]>();
    if (notInit) return notInit;

    const limit = opts?.limit ?? 100;
    const rows = this._adapter.all(
      `SELECT *, rowid AS _rowid FROM __lattice_changelog
       WHERE table_name = ? AND row_id = ?
       ORDER BY rowid DESC
       LIMIT ?`,
      [table, id, limit],
    );
    return Promise.resolve(rows.map((r) => this._parseChangeEntry(r)));
  }

  /**
   * Get recent changes across tables.
   */
  recentChanges(opts?: { table?: string; since?: string; limit?: number }): Promise<ChangeEntry[]> {
    const notInit = this._notInitError<ChangeEntry[]>();
    if (notInit) return notInit;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts?.table) {
      clauses.push('table_name = ?');
      params.push(opts.table);
    }
    if (opts?.since) {
      clauses.push('created_at >= ?');
      params.push(opts.since);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;

    const rows = this._adapter.all(
      `SELECT *, rowid AS _rowid FROM __lattice_changelog ${where}
       ORDER BY rowid DESC
       LIMIT ?`,
      [...params, limit],
    );
    return Promise.resolve(rows.map((r) => this._parseChangeEntry(r)));
  }

  /**
   * Rollback a specific change by applying the inverse operation.
   * The rollback itself is recorded as a new changelog entry.
   */
  rollback(changeId: string): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    const entry = this._adapter.get(`SELECT * FROM __lattice_changelog WHERE id = ?`, [changeId]);
    if (!entry) {
      return Promise.reject(new Error(`Lattice: changelog entry "${changeId}" not found`));
    }

    const parsed = this._parseChangeEntry(entry);
    const { clause, params: pkParams } = this._pkWhere(parsed.table, parsed.rowId);

    switch (parsed.operation) {
      case 'insert':
        // Undo insert → delete the row
        this._adapter.run(`DELETE FROM "${parsed.table}" WHERE ${clause}`, pkParams);
        break;

      case 'update':
        // Undo update → restore previous values
        if (!parsed.previous) {
          return Promise.reject(
            new Error(`Lattice: changelog entry "${changeId}" has no previous values to restore`),
          );
        }
        {
          const setCols = Object.keys(parsed.previous)
            .map((c) => `"${c}" = ?`)
            .join(', ');
          this._adapter.run(`UPDATE "${parsed.table}" SET ${setCols} WHERE ${clause}`, [
            ...Object.values(parsed.previous),
            ...pkParams,
          ]);
        }
        break;

      case 'delete':
        // Undo delete → re-insert the row
        if (!parsed.previous) {
          return Promise.reject(
            new Error(`Lattice: changelog entry "${changeId}" has no previous row to restore`),
          );
        }
        {
          const cols = Object.keys(parsed.previous)
            .map((c) => `"${c}"`)
            .join(', ');
          const placeholders = Object.keys(parsed.previous)
            .map(() => '?')
            .join(', ');
          this._adapter.run(
            `INSERT INTO "${parsed.table}" (${cols}) VALUES (${placeholders})`,
            Object.values(parsed.previous),
          );
        }
        break;

      default:
        return Promise.reject(
          new Error(`Lattice: cannot rollback operation "${parsed.operation}"`),
        );
    }

    // Record the rollback as a new changelog entry
    this._appendChangelog(
      parsed.table,
      parsed.rowId,
      'rollback',
      parsed.previous, // The values we restored to become the "changes"
      parsed.changes, // The values we undid become the "previous"
      'system',
      `rollback of ${changeId}`,
    );

    return Promise.resolve();
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

    const fromSnap = this.snapshot(table, id, fromChangeId);
    const toSnap = this.snapshot(table, id, toChangeId);

    return Promise.all([fromSnap, toSnap]).then(([fromState, toState]) => {
      const result: Record<string, { old: unknown; new: unknown }> = {};
      const allKeys = new Set([...Object.keys(fromState), ...Object.keys(toState)]);
      for (const key of allKeys) {
        const oldVal = fromState[key];
        const newVal = toState[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          result[key] = { old: oldVal ?? null, new: newVal ?? null };
        }
      }
      return result;
    });
  }

  /**
   * Reconstruct the row state at a specific changelog entry by replaying
   * all operations up to and including that entry.
   */
  snapshot(table: string, id: string, changeId: string): Promise<Record<string, unknown>> {
    const notInit = this._notInitError<Record<string, unknown>>();
    if (notInit) return notInit;

    // Get the target entry's rowid for reliable ordering
    const target = this._adapter.get(`SELECT rowid FROM __lattice_changelog WHERE id = ?`, [
      changeId,
    ]);
    if (!target) {
      return Promise.reject(new Error(`Lattice: changelog entry "${changeId}" not found`));
    }

    // Get all entries for this row up to and including the target, in insertion order
    const entries = this._adapter.all(
      `SELECT * FROM __lattice_changelog
       WHERE table_name = ? AND row_id = ? AND rowid <= ?
       ORDER BY rowid ASC`,
      [table, id, target.rowid],
    );

    // Replay to build state
    let state: Record<string, unknown> = {};
    for (const raw of entries) {
      const entry = this._parseChangeEntry(raw);
      switch (entry.operation) {
        case 'insert':
          state = { ...state, ...(entry.changes ?? {}) };
          break;
        case 'update':
          state = { ...state, ...(entry.changes ?? {}) };
          break;
        case 'delete':
          state = {};
          break;
        case 'rollback':
          // Rollback restores the "changes" field (which holds what was restored)
          state = { ...state, ...(entry.changes ?? {}) };
          break;
      }
    }
    return Promise.resolve(state);
  }

  /**
   * Manually prune changelog entries based on the configured retention policy.
   * Also callable directly for on-demand cleanup.
   */
  pruneChangelog(): Promise<void> {
    const notInit = this._notInitError<never>();
    if (notInit) return notInit;

    this._pruneChangelog();
    return Promise.resolve();
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
