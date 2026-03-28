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
  WatchOptions,
  RenderResult,
  SyncResult,
  StopFn,
  AuditEvent,
  LatticeEvent,
  Filter,
  WriteHook,
  WriteHookContext,
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
    let configEntityContexts:
      | { table: string; definition: EntityContextDefinition }[]
      | undefined;

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
      render: compileRender(def, table, this._schema, this._adapter),
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

    // Render first (writes new manifest)
    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    // Read the new manifest just written by render
    const newManifest = readManifest(outputDir);

    // Run cleanup after render, passing both old and new manifests.
    // Old manifest: detects orphaned directories (deleted entities).
    // New manifest: detects stale files in surviving entities (omitIfEmpty, removed files).
    const cleanup = this._render.cleanup(outputDir, prevManifest, options, newManifest);

    return { ...renderResult, cleanup };
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
  private _filterToSchemaColumns(table: string, row: Row): Row {
    const cols = this._columnCache.get(table);
    if (!cols) return row; // unregistered table — pass through unchanged
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
  private _fireWriteHooks(table: string, op: 'insert' | 'update' | 'delete', row: Row, pk: string, changedColumns?: string[]): void {
    for (const hook of this._writeHooks) {
      if (hook.table !== table) continue;
      if (!hook.on.includes(op)) continue;
      if (op === 'update' && hook.watchColumns && changedColumns) {
        if (!hook.watchColumns.some(c => changedColumns.includes(c))) continue;
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
        return Promise.reject(
          new Error(`Lattice: unknown column "${col}" in table "${table}"`),
        );
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
