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
} from './types.js';
import type Database from 'better-sqlite3';
import { SQLiteAdapter } from './db/sqlite.js';
import { SchemaManager } from './schema/manager.js';
import { Sanitizer } from './security/sanitize.js';
import { RenderEngine } from './render/engine.js';
import { SyncLoop } from './sync/loop.js';
import { WritebackPipeline } from './writeback/pipeline.js';

type EventHandler<T> = (data: T) => void;

export class Lattice {
  private readonly _adapter: SQLiteAdapter;
  private readonly _schema: SchemaManager;
  private readonly _sanitizer: Sanitizer;
  private readonly _render: RenderEngine;
  private readonly _loop: SyncLoop;
  private readonly _writeback: WritebackPipeline;
  private _initialized = false;

  private readonly _auditHandlers: EventHandler<AuditEvent>[] = [];
  private readonly _renderHandlers: EventHandler<RenderResult>[] = [];
  private readonly _writebackHandlers: EventHandler<{ filePath: string; entriesProcessed: number }>[] = [];
  private readonly _errorHandlers: EventHandler<Error>[] = [];

  constructor(path: string, options: LatticeOptions = {}) {
    const adapterOpts: { wal?: boolean; busyTimeout?: number } = {};
    if (options.wal !== undefined) adapterOpts.wal = options.wal;
    if (options.busyTimeout !== undefined) adapterOpts.busyTimeout = options.busyTimeout;
    this._adapter = new SQLiteAdapter(path, adapterOpts);
    this._schema = new SchemaManager();
    this._sanitizer = new Sanitizer(options.security);
    this._render = new RenderEngine(this._schema, this._adapter);
    this._loop = new SyncLoop(this._render);
    this._writeback = new WritebackPipeline();

    this._sanitizer.onAudit((event) => {
      for (const h of this._auditHandlers) h(event);
    });
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  define(table: string, def: TableDefinition): this {
    this._assertNotInit('define');
    this._schema.define(table, def);
    return this;
  }

  defineMulti(name: string, def: MultiTableDefinition): this {
    this._assertNotInit('defineMulti');
    this._schema.defineMulti(name, def);
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
    this._initialized = true;
    return Promise.resolve();
  }

  close(): void {
    this._adapter.close();
    this._initialized = false;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  insert(table: string, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

    const sanitized = this._sanitizer.sanitizeRow(row);
    const id = (sanitized.id as string | undefined) ?? uuidv4();
    const rowWithId = { ...sanitized, id };

    const cols = Object.keys(rowWithId).map((c) => `"${c}"`).join(', ');
    const placeholders = Object.keys(rowWithId).map(() => '?').join(', ');
    const values = Object.values(rowWithId);

    this._adapter.run(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`,
      values,
    );

    this._sanitizer.emitAudit(table, 'insert', id);
    return Promise.resolve(id);
  }

  upsert(table: string, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

    const sanitized = this._sanitizer.sanitizeRow(row);
    const id = (sanitized.id as string | undefined) ?? uuidv4();
    const rowWithId = { ...sanitized, id };

    const cols = Object.keys(rowWithId).map((c) => `"${c}"`).join(', ');
    const placeholders = Object.keys(rowWithId).map(() => '?').join(', ');
    const updateCols = Object.keys(rowWithId)
      .filter((c) => c !== 'id')
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ');
    const values = Object.values(rowWithId);

    this._adapter.run(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT("id") DO UPDATE SET ${updateCols}`,
      values,
    );

    this._sanitizer.emitAudit(table, 'update', id);
    return Promise.resolve(id);
  }

  upsertBy(table: string, col: string, val: unknown, row: Row): Promise<string> {
    const notInit = this._notInitError<string>();
    if (notInit) return notInit;

    const existing = this._adapter.get(
      `SELECT id FROM "${table}" WHERE "${col}" = ?`,
      [val],
    );
    if (existing) {
      const existingId = String(existing.id);
      return this.update(table, existingId, row).then(() => existingId);
    }
    return this.insert(table, { ...row, [col]: val });
  }

  update(table: string, id: string, row: Partial<Row>): Promise<void> {
    const notInit = this._notInitError<void>();
    if (notInit) return notInit;

    const sanitized = this._sanitizer.sanitizeRow(row as Row);
    const setCols = Object.keys(sanitized)
      .map((c) => `"${c}" = ?`)
      .join(', ');
    const values = [...Object.values(sanitized), id];

    this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE "id" = ?`, values);
    this._sanitizer.emitAudit(table, 'update', id);
    return Promise.resolve();
  }

  delete(table: string, id: string): Promise<void> {
    const notInit = this._notInitError<void>();
    if (notInit) return notInit;

    this._adapter.run(`DELETE FROM "${table}" WHERE "id" = ?`, [id]);
    this._sanitizer.emitAudit(table, 'delete', id);
    return Promise.resolve();
  }

  query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    const notInit = this._notInitError<Row[]>();
    if (notInit) return notInit;

    let sql = `SELECT * FROM "${table}"`;
    const params: unknown[] = [];

    if (opts.where && Object.keys(opts.where).length > 0) {
      const clauses = Object.entries(opts.where).map(([col, val]) => {
        params.push(val);
        return `"${col}" = ?`;
      });
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    if (opts.orderBy) {
      const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
    }
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${opts.limit.toString()}`;
    }
    if (opts.offset !== undefined) {
      // SQLite requires LIMIT before OFFSET; use -1 (unlimited) if no explicit limit
      if (opts.limit === undefined) sql += ' LIMIT -1';
      sql += ` OFFSET ${opts.offset.toString()}`;
    }

    return Promise.resolve(this._adapter.all(sql, params));
  }

  get(table: string, id: string): Promise<Row | null> {
    const notInit = this._notInitError<Row | null>();
    if (notInit) return notInit;

    return Promise.resolve(
      this._adapter.get(`SELECT * FROM "${table}" WHERE "id" = ?`, [id]) ?? null,
    );
  }

  count(table: string, opts: CountOptions = {}): Promise<number> {
    const notInit = this._notInitError<number>();
    if (notInit) return notInit;

    let sql = `SELECT COUNT(*) as n FROM "${table}"`;
    const params: unknown[] = [];

    if (opts.where && Object.keys(opts.where).length > 0) {
      const clauses = Object.entries(opts.where).map(([col, val]) => {
        params.push(val);
        return `"${col}" = ?`;
      });
      sql += ` WHERE ${clauses.join(' AND ')}`;
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
  // Private
  // -------------------------------------------------------------------------

  /** Returns a rejected Promise if not initialized; null if ready. */
  private _notInitError<T>(): Promise<T> | null {
    if (!this._initialized) {
      return Promise.reject(
        new Error('Lattice: call await db.init() before using CRUD or sync methods'),
      ) as Promise<T>;
    }
    return null;
  }

  private _assertNotInit(method: string): void {
    if (this._initialized) {
      throw new Error(`Lattice: ${method}() must be called before init()`);
    }
  }
}
