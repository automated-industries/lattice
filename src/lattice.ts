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
import { SQLiteAdapter } from './db/sqlite.js';
import { SchemaManager } from './schema/manager.js';
import { Sanitizer } from './security/sanitize.js';
import { RenderEngine } from './render/engine.js';
import { SyncLoop } from './sync/loop.js';
import { WritebackPipeline } from './writeback/pipeline.js';
import type { Database } from 'better-sqlite3';

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
    this._adapter = new SQLiteAdapter(path, {
      wal: options.wal,
      busyTimeout: options.busyTimeout,
    });
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

  async init(options: InitOptions = {}): Promise<void> {
    if (this._initialized) {
      throw new Error('Lattice: init() has already been called');
    }
    this._adapter.open();
    this._schema.applySchema(this._adapter);
    if (options.migrations?.length) {
      this._schema.applyMigrations(this._adapter, options.migrations);
    }
    this._initialized = true;
  }

  close(): void {
    this._adapter.close();
    this._initialized = false;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async insert(table: string, row: Row): Promise<string> {
    this._assertInit();
    const sanitized = this._sanitizer.sanitizeRow(row);
    const id = (sanitized['id'] as string | undefined) ?? uuidv4();
    const rowWithId = { ...sanitized, id };

    const cols = Object.keys(rowWithId).map((c) => `"${c}"`).join(', ');
    const placeholders = Object.keys(rowWithId).map(() => '?').join(', ');
    const values = Object.values(rowWithId);

    this._adapter.run(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`,
      values,
    );

    this._sanitizer.emitAudit(table, 'insert', String(id));
    return String(id);
  }

  async upsert(table: string, row: Row): Promise<string> {
    this._assertInit();
    const sanitized = this._sanitizer.sanitizeRow(row);
    const id = (sanitized['id'] as string | undefined) ?? uuidv4();
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

    this._sanitizer.emitAudit(table, 'update', String(id));
    return String(id);
  }

  async upsertBy(
    table: string,
    col: string,
    val: unknown,
    row: Row,
  ): Promise<string> {
    this._assertInit();
    const existing = this._adapter.get(
      `SELECT id FROM "${table}" WHERE "${col}" = ?`,
      [val],
    );
    if (existing) {
      await this.update(table, String(existing['id']), row);
      return String(existing['id']);
    }
    return this.insert(table, { ...row, [col]: val });
  }

  async update(table: string, id: string, row: Partial<Row>): Promise<void> {
    this._assertInit();
    const sanitized = this._sanitizer.sanitizeRow(row as Row);
    const setCols = Object.keys(sanitized)
      .map((c) => `"${c}" = ?`)
      .join(', ');
    const values = [...Object.values(sanitized), id];

    this._adapter.run(`UPDATE "${table}" SET ${setCols} WHERE "id" = ?`, values);
    this._sanitizer.emitAudit(table, 'update', id);
  }

  async delete(table: string, id: string): Promise<void> {
    this._assertInit();
    this._adapter.run(`DELETE FROM "${table}" WHERE "id" = ?`, [id]);
    this._sanitizer.emitAudit(table, 'delete', id);
  }

  async query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    this._assertInit();
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
      sql += ` LIMIT ${opts.limit}`;
    }
    if (opts.offset !== undefined) {
      sql += ` OFFSET ${opts.offset}`;
    }

    return this._adapter.all(sql, params);
  }

  async get(table: string, id: string): Promise<Row | null> {
    this._assertInit();
    return (
      this._adapter.get(`SELECT * FROM "${table}" WHERE "id" = ?`, [id]) ?? null
    );
  }

  async count(table: string, opts: CountOptions = {}): Promise<number> {
    this._assertInit();
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
    return Number(row?.['n'] ?? 0);
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async render(outputDir: string): Promise<RenderResult> {
    this._assertInit();
    const result = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(result);
    return result;
  }

  async sync(outputDir: string): Promise<SyncResult> {
    this._assertInit();
    const renderResult = await this._render.render(outputDir);
    for (const h of this._renderHandlers) h(renderResult);

    const writebackProcessed = await this._writeback.process();

    return { ...renderResult, writebackProcessed };
  }

  async watch(outputDir: string, opts: WatchOptions = {}): Promise<StopFn> {
    this._assertInit();
    return this._loop.watch(outputDir, {
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
  on(event: LatticeEvent['type'], handler: EventHandler<unknown>): this {
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

  get db(): Database {
    return this._adapter.db as unknown as Database;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _assertInit(): void {
    if (!this._initialized) {
      throw new Error('Lattice: call await db.init() before using CRUD or sync methods');
    }
  }

  private _assertNotInit(method: string): void {
    if (this._initialized) {
      throw new Error(`Lattice: ${method}() must be called before init()`);
    }
  }
}
