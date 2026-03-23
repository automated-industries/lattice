export type Row = Record<string, unknown>;

export interface LatticeOptions {
  wal?: boolean;
  busyTimeout?: number;
  security?: SecurityOptions;
}

export interface SecurityOptions {
  sanitize?: boolean;
  auditTables?: string[];
  fieldLimits?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Primary key
// ---------------------------------------------------------------------------

/**
 * The primary key of a table. Either a single column name (string) or an
 * ordered list of column names for composite keys.
 *
 * Defaults to `'id'` when omitted from a TableDefinition. When the default
 * `'id'` is used and the `id` field is absent on insert, a UUID v4 is
 * generated automatically. For custom single or composite keys the caller
 * must supply all PK column values.
 */
export type PrimaryKey = string | string[];

// ---------------------------------------------------------------------------
// Relationships (metadata — used by template rendering in v0.3+)
// ---------------------------------------------------------------------------

/**
 * A foreign-key relationship where THIS table holds the FK pointing to another
 * table (e.g. `comment.post_id → posts.id`).
 */
export interface BelongsToRelation {
  type: 'belongsTo';
  /** The related table */
  table: string;
  /** Column on THIS table that holds the foreign key */
  foreignKey: string;
  /**
   * Column on the RELATED table being referenced.
   * Defaults to that table's first primary key column.
   */
  references?: string;
}

/**
 * A relationship where ANOTHER table holds the FK pointing back to this table
 * (e.g. `posts.id ← comments.post_id`).
 */
export interface HasManyRelation {
  type: 'hasMany';
  /** The related table */
  table: string;
  /** Column on the RELATED table that points back to this table */
  foreignKey: string;
  /**
   * Column on THIS table being referenced.
   * Defaults to this table's first primary key column.
   */
  references?: string;
}

/** A declared relationship between two tables. */
export type Relation = BelongsToRelation | HasManyRelation;

// ---------------------------------------------------------------------------
// Expanded query filters
// ---------------------------------------------------------------------------

/**
 * Comparison operators available in a {@link Filter}.
 *
 * - `eq` / `ne`  — equality / inequality
 * - `gt` / `gte` / `lt` / `lte` — numeric or lexicographic comparison
 * - `like`       — SQL LIKE pattern (`%` is the wildcard)
 * - `in`         — column value is one of a list
 * - `isNull` / `isNotNull` — NULL checks (no `val` needed)
 */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'in'
  | 'isNull'
  | 'isNotNull';

/**
 * A single filter clause with an explicit operator.
 *
 * @example
 * ```ts
 * { col: 'score',      op: 'gte',    val: 80 }
 * { col: 'deleted_at', op: 'isNull'           }
 * { col: 'status',     op: 'in',     val: ['open', 'pending'] }
 * { col: 'name',       op: 'like',   val: 'A%' }
 * ```
 */
export interface Filter {
  /** Column name to filter on */
  col: string;
  /** Comparison operator */
  op: FilterOp;
  /**
   * Operand value. Not required for `isNull` / `isNotNull`.
   * For `in`, must be an array.
   */
  val?: unknown;
}

// ---------------------------------------------------------------------------
// Template rendering (v0.3+)
// ---------------------------------------------------------------------------

/**
 * Names of the four built-in render templates.
 *
 * - `default-list`   — one bullet per row (supports `formatRow` hook)
 * - `default-table`  — GitHub-flavoured Markdown table
 * - `default-detail` — section per row with all fields (supports `formatRow` hook)
 * - `default-json`   — `JSON.stringify(rows, null, 2)`
 */
export type BuiltinTemplateName =
  | 'default-list'
  | 'default-table'
  | 'default-detail'
  | 'default-json';

/**
 * Lifecycle hooks that customise a built-in template.
 *
 * - `beforeRender(rows)` — transform or filter the row array before rendering.
 * - `formatRow` — control how each row is serialised to a string.
 *   Can be a plain function or a `{{field}}` interpolation template string.
 *   Supported by `default-list` and `default-detail`.
 *   `belongsTo` relation fields are available as `{{relationName.field}}`.
 *
 * @example
 * ```ts
 * hooks: {
 *   beforeRender: (rows) => rows.filter(r => r.active),
 *   formatRow: '{{title}} — {{status}}',
 * }
 * ```
 */
export interface RenderHooks {
  beforeRender?: (rows: Row[]) => Row[];
  formatRow?: ((row: Row) => string) | string;
}

/**
 * Use a built-in template, optionally with lifecycle hooks.
 *
 * @example
 * ```ts
 * render: { template: 'default-list', hooks: { formatRow: '- {{title}} ({{status}})' } }
 * ```
 */
export interface TemplateRenderSpec {
  template: BuiltinTemplateName;
  hooks?: RenderHooks;
}

/**
 * The accepted value for `TableDefinition.render`:
 *
 * - A plain `(rows: Row[]) => string` function — full control, unchanged from v0.1/v0.2.
 * - A `BuiltinTemplateName` string — use a built-in template with default settings.
 * - A `TemplateRenderSpec` object — use a built-in template with lifecycle hooks.
 */
export type RenderSpec = ((rows: Row[]) => string) | BuiltinTemplateName | TemplateRenderSpec;

// ---------------------------------------------------------------------------
// Table / multi-table definitions
// ---------------------------------------------------------------------------

export interface TableDefinition {
  /** Column name → SQLite type spec (e.g. `'TEXT PRIMARY KEY'`) */
  columns: Record<string, string>;
  /**
   * How to render DB rows into text content for the context file.
   *
   * - Pass a `(rows: Row[]) => string` function for full control (v0.1/v0.2 behaviour).
   * - Pass a `BuiltinTemplateName` string (`'default-list'`, `'default-table'`,
   *   `'default-detail'`, `'default-json'`) to use a built-in template.
   * - Pass a `TemplateRenderSpec` to use a built-in template with lifecycle hooks.
   */
  render: RenderSpec;
  /** Output path relative to the outputDir passed to render/watch */
  outputFile: string;
  /** Optional pre-filter applied before render */
  filter?: (rows: Row[]) => Row[];
  /**
   * Primary key column name or names.
   *
   * - Omit (or `'id'`): default behaviour — UUID auto-generated on insert when absent.
   * - Custom string (e.g. `'slug'`): caller must supply the value on every insert.
   * - Array (e.g. `['org_id', 'seq']`): composite key — caller must supply all columns.
   *
   * @example
   * ```ts
   * primaryKey: 'slug'
   * primaryKey: ['tenant_id', 'ticket_id']
   * ```
   */
  primaryKey?: PrimaryKey;
  /**
   * Optional table-level SQL constraints appended after the column list.
   * Required for composite primary keys and multi-column unique constraints,
   * which cannot be expressed in the per-column `columns` spec.
   *
   * @example
   * ```ts
   * tableConstraints: ['PRIMARY KEY (tenant_id, seq)']
   * tableConstraints: ['PRIMARY KEY (a, b)', 'UNIQUE (email, org_id)']
   * ```
   */
  tableConstraints?: string[];
  /**
   * Declared relationships to other registered tables.
   * Stored as metadata in v0.2; used by template rendering in v0.3+.
   *
   * @example
   * ```ts
   * relations: {
   *   author:   { type: 'belongsTo', table: 'users',    foreignKey: 'author_id' },
   *   comments: { type: 'hasMany',   table: 'comments', foreignKey: 'post_id'   },
   * }
   * ```
   */
  relations?: Record<string, Relation>;
}

export interface MultiTableDefinition {
  /** Returns the "anchor" entities — one output file is produced per anchor */
  keys: () => Promise<Row[]>;
  /** Derive the output file path from the anchor entity */
  outputFile: (key: Row) => string;
  /** Transform an anchor entity + related table data into text content */
  render: (key: Row, tables: Record<string, Row[]>) => string;
  /** Additional table names to query and pass into render */
  tables?: string[];
}

export interface WritebackDefinition {
  /** Path or glob to agent-written files */
  file: string;
  /** Parse new file content starting at fromOffset; return entries and next offset */
  parse: (content: string, fromOffset: number) => { entries: unknown[]; nextOffset: number };
  /** Persist a single parsed entry; called exactly once per unique dedupeKey */
  persist: (entry: unknown, filePath: string) => Promise<void>;
  /** Optional dedup key — if omitted, every entry is processed */
  dedupeKey?: (entry: unknown) => string;
}

// ---------------------------------------------------------------------------
// Query / count options
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /**
   * Equality filters — shorthand for `filters: [{ col, op: 'eq', val }]`.
   * Fully backward compatible with pre-v0.2 usage.
   */
  where?: Record<string, unknown>;
  /**
   * Advanced filter clauses with full operator support.
   * Combined with `where` using AND.
   *
   * @example
   * ```ts
   * filters: [
   *   { col: 'priority',   op: 'gte',    val: 3 },
   *   { col: 'deleted_at', op: 'isNull'          },
   *   { col: 'tag',        op: 'in',     val: ['bug', 'feature'] },
   * ]
   * ```
   */
  filters?: Filter[];
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CountOptions {
  /** Equality filters (same as QueryOptions.where) */
  where?: Record<string, unknown>;
  /** Advanced filter clauses (same as QueryOptions.filters) */
  filters?: Filter[];
}

// ---------------------------------------------------------------------------
// Remaining options / results / events
// ---------------------------------------------------------------------------

export interface InitOptions {
  migrations?: Migration[];
}

export interface Migration {
  version: number;
  sql: string;
}

export interface WatchOptions {
  /** Poll interval in milliseconds (default: 5000) */
  interval?: number;
  onRender?: (result: RenderResult) => void;
  onError?: (err: Error) => void;
}

export interface RenderResult {
  filesWritten: string[];
  filesSkipped: number;
  durationMs: number;
}

export interface SyncResult extends RenderResult {
  writebackProcessed: number;
}

export type StopFn = () => void;

export interface AuditEvent {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  id: string;
  timestamp: string;
}

export type LatticeEvent =
  | { type: 'audit'; data: AuditEvent }
  | { type: 'render'; data: RenderResult }
  | { type: 'writeback'; data: { filePath: string; entriesProcessed: number } }
  | { type: 'error'; data: Error };

// ---------------------------------------------------------------------------
// Entity context directories (v0.5+)
// ---------------------------------------------------------------------------

export type {
  SelfSource,
  HasManySource,
  ManyToManySource,
  BelongsToSource,
  CustomSource,
  EntityFileSource,
  EntityFileSpec,
  EntityContextDefinition,
} from './schema/entity-context.js';
