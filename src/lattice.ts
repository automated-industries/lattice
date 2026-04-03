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
    this._render = new RenderEngine(this._schema, this._adapter);
    this._reverseSync = new ReverseSyncEngine(this._schema, this._adapter);
    this._loop = new SyncLoop(this._render);
    this._writeback = new WritebackPipeline();

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
    const compiledDef: CompiledTableDef = {
      ...def,
      render: def.render
        ? compileRender(def as TableDefinition & { render: RenderSpec }, table, this._schema, this._adapter)
        : () => '',
      outputFile: def.outputFile ?? `.schema-only/${table}.md`,
    };
    this._schema.define(table, compiledDef);
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
    this._initialized = false;
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

    const cols = Object.keys(rowWithPk)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(rowWithPk)
      .map(() => '?')
      .join(', ');
    const values = Object.values(rowWithPk);

    this._adapter.run(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`, values);

    // pkCols[0] is always defined — validated non-empty in SchemaManager.define()
    const pkCol = pkCols[0] ?? 'id';
    const rawPk = rowWithPk[pkCol];
    const pkValue = rawPk != null ? String(rawPk as string | number) : '';
    this._sanitizer.emitAudit(table, 'insert', pkValue);
    this._fireWriteHooks(table, 'insert', rowWithPk, pkValue);
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

    const cols = Object.keys(rowWithPk)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(rowWithPk)
      .map(() => '?')
      .join(', ');
    // Conflict target uses all PK columns
    const conflictCols = pkCols.map((c) => `"${c}"`).join(', ');
    // Exclude all PK columns from the UPDATE SET clause
    const updateCols = Object.keys(rowWithPk)
      .filter((c) => !pkCols.includes(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ');
    const values = Object.values(rowWithPk);

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
    const setCols = Object.keys(sanitized)
      .map((c) => `"${c}" = ?`)
      .join(', ');

    const { clause, params: pkParams } = this._pkWhere(table, id);
    const values = [...Object.values(sanitized), ...pkParams];

    this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE ${clause}`, values);

    const auditId = typeof id === 'string' ? id : JSON.stringify(id);
    this._sanitizer.emitAudit(table, 'update', auditId);
    this._fireWriteHooks(table, 'update', sanitized, auditId, Object.keys(sanitized));
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
    this._adapter.run(`DELETE FROM "${table}" WHERE ${clause}`, params);

    const auditId = typeof id === 'string' ? id : JSON.stringify(id);
    this._sanitizer.emitAudit(table, 'delete', auditId);
    this._fireWriteHooks(table, 'delete', { id: auditId }, auditId);
    return Promise.resolve();
  }

  get(table: string, id: PkLookup): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;

    const { clause, params } = this._pkWhere(table, id);
    return Promise.resolve(
      this._adapter.get(`SELECT * FROM "${table}" WHERE ${clause}`, params) ?? null,
    );
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
      const entries = Object.entries(withConventions).filter(([k]) => k !== 'id');
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
    const colNames = Object.keys(filtered)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(filtered)
      .map(() => '?')
      .join(', ');
    this._adapter.run(
      `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
      Object.values(filtered),
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

    return Promise.resolve(this._adapter.all(sql, params));
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
