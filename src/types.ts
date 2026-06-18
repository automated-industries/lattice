export type Row = Record<string, unknown>;

import type { StorageAdapter } from './db/adapter.js';

export interface LatticeOptions {
  wal?: boolean;
  busyTimeout?: number;
  security?: SecurityOptions;
  /**
   * Master key for at-rest encryption of protected entity contexts.
   * Required when any entity context has `encrypted: true`.
   * The key is derived via scrypt before use — provide a strong passphrase.
   */
  encryptionKey?: string;
  /**
   * Configuration for the change log. When provided, tables with
   * `changelog: true` automatically record every insert, update, and
   * delete to `__lattice_changelog`.
   */
  changelog?: ChangelogOptions;
  /**
   * Bring-your-own adapter override. When set, the connection-string scheme
   * is ignored and this adapter is used directly. Useful for tests, custom
   * backends, or pre-opened connections.
   */
  adapter?: StorageAdapter;
  /**
   * When true, `render()` skips both the full-table read and the file write
   * for tables registered without a `render` spec — those compile to a no-op
   * that would only emit an empty `.schema-only/<table>.md`. Off by default,
   * preserving the original behavior (the table is still scanned and an empty
   * schema-only file written). Enable this to avoid reading large tables off
   * the wire just to produce empty files. Tables with an explicit `render`
   * (or `outputFile`) are unaffected.
   */
  renderSkipsEmpty?: boolean;
  /**
   * Reject any insert/upsert/update whose row payload exceeds this many
   * bytes (sum of UTF-8 byte lengths of string columns + buffer lengths).
   * Off by default — when unset, only Postgres TOAST / SQLite blob limits
   * (~1 GB) cap row size. A modest cap (e.g. 1 MiB) blocks one class of
   * denial-of-service from a malicious member writing oversized rows; a
   * production deployment should set this to whatever your app actually
   * needs plus headroom. Throws `Error("Lattice: row exceeds maxRowBytes
   * ...")` on violation, so callers can catch it.
   */
  maxRowBytes?: number;
}

/**
 * Retention policy for the change log.
 */
export interface ChangelogOptions {
  /** Auto-prune entries older than this many days. */
  retentionDays?: number;
  /** Keep at most this many entries per row. */
  maxEntriesPerRow?: number;
}

/**
 * Provenance for a change — the per-viewer observation model's audit metadata.
 * Every field is optional and additive: a plain edit carries none of it and
 * behaves exactly as before. A *derived* value (e.g. an AI enrichment computed
 * from source files) carries the `sourceRef` set that informed it, so the
 * change-log records which authority produced the value rather than discarding
 * it (the confused-deputy guard). Stage-0 persists this as audit metadata;
 * later stages read it to fold per-viewer entities and cascade revocation.
 */
export interface ChangeProvenance {
  /** Source row/file id(s) that informed this value. Persisted as a JSON array
   *  in `__lattice_changelog.source_ref`. NOT a foreign key — purely an audit
   *  trail; a source may be deleted without violating anything. */
  sourceRef?: string[] | string;
  /** `ground_truth` — a direct edit; `derived` — computed from sources. */
  changeKind?: 'ground_truth' | 'derived';
  /** Reserved per-value audience. Omitted ⇒ the row's audience (no change). */
  audience?: string;
  /** Marks the source(s) sensitive (a future crypto-shred candidate). */
  sourceSensitive?: boolean;
  /** A prior changelog id this entry supersedes. */
  supersededBy?: string;
  /** Free-text reason (mirrors the legacy `reason` field). */
  reason?: string;
}

/**
 * A single entry in the change log returned by `history()` and
 * `recentChanges()`.
 */
export interface ChangeEntry {
  /** Unique ID of this changelog entry. */
  id: string;
  /** Table that was modified. */
  table: string;
  /** Primary key of the affected row. */
  rowId: string;
  /** The operation that was performed. */
  operation: 'insert' | 'update' | 'delete' | 'rollback';
  /** JSON object of the fields that changed (null for deletes). */
  changes: Record<string, unknown> | null;
  /** Previous values of changed fields (null for inserts). */
  previous: Record<string, unknown> | null;
  /** Who made the change (from caller context). */
  source: string | null;
  /** Why the change was made (optional). */
  reason: string | null;
  /** ISO timestamp of when the change was recorded. */
  createdAt: string;
  /** Source-set that informed a derived value (deserialized from `source_ref`).
   *  Null for plain edits + rows written before 3.0. */
  sourceRef?: string[] | null;
  /** `ground_truth` | `derived` provenance tag (null when unrecorded). */
  changeKind?: 'ground_truth' | 'derived' | null;
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
   * Column name → canonical Lattice field type (`text`/`integer`/`real`/
   * `boolean`/`uuid`/`datetime`/`date`), retained from the config so the GUI
   * can display the declared type instead of the lossy SQL spec in `columns`.
   * Populated only for config-declared (YAML) tables; absent for tables defined
   * directly in code via `define()`.
   */
  fieldTypes?: Record<string, string>;
  /**
   * Column name → audience identifier (Stage-0 per-viewer enrichment
   * scaffolding). A column absent from this map has `row-audience` — visible to
   * whoever can see the row, i.e. today's behavior. Populated from YAML field
   * `audience:` specs (or a future code-level option). Recorded by the schema
   * manager so a later stage can generate a per-column cell-masking view from
   * it; unused in Stage-0, so it never changes behavior.
   */
  columnAudience?: Record<string, string>;
  /**
   * Optional human description of what this entity represents. Surfaced in the
   * GUI and given to the assistant's ingest classifier so it can decide which
   * records a document relates to. Metadata only — never affects DDL.
   */
  description?: string;
  /**
   * How to render DB rows into text content for the context file.
   *
   * - Pass a `(rows: Row[]) => string` function for full control (v0.1/v0.2 behaviour).
   * - Pass a `BuiltinTemplateName` string (`'default-list'`, `'default-table'`,
   *   `'default-detail'`, `'default-json'`) to use a built-in template.
   * - Pass a `TemplateRenderSpec` to use a built-in template with lifecycle hooks.
   */
  render?: RenderSpec;
  /** Output path relative to the outputDir passed to render/watch */
  outputFile?: string;
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
  /**
   * Enable semantic search for this table via embeddings.
   *
   * When configured, Lattice computes and stores vector embeddings for
   * the specified text fields. Use `lattice.search(table, query, opts)`
   * to retrieve rows by semantic similarity.
   *
   * The `embed` function is called to generate vectors — bring your own
   * embedding model (OpenAI, local model, etc.).
   *
   * @example
   * ```ts
   * embeddings: {
   *   fields: ['title', 'body'],
   *   embed: async (text) => openai.embeddings.create({ input: text, model: 'text-embedding-3-small' }).then(r => r.data[0].embedding),
   * }
   * ```
   */
  embeddings?: EmbeddingsConfig;
  /**
   * Opt this table into indexed full-text search. When set, Lattice builds an
   * inverted index (SQLite FTS5 / Postgres `tsvector` + GIN) in a separate
   * `__lattice_fts_<table>` table, maintained automatically by DB triggers, and
   * `fullTextSearch` uses it instead of the `LIKE` fallback. Omitting `fields`
   * auto-detects the table's text columns (excluding ids / `deleted_at` /
   * reward bookkeeping).
   *
   * Tables WITHOUT this config are completely unaffected — no index, no
   * triggers, no write-path overhead — so a bare library consumer pays nothing.
   *
   * @example
   * ```ts
   * fts: { fields: ['title', 'body'] }
   * ```
   */
  fts?: FtsConfig;
  /**
   * Enable reward tracking for this table. When `true`, Lattice
   * auto-adds `_reward_total REAL DEFAULT 0` and `_reward_count INTEGER
   * DEFAULT 0` columns. Rows are sorted by `_reward_total DESC` before
   * rendering (unless overridden by `prioritizeBy`).
   *
   * Use `lattice.reward(table, id, scores)` to update reward values.
   */
  rewardTracking?: boolean;
  /**
   * When `rewardTracking` is enabled, automatically soft-delete rows
   * whose `_reward_total` falls below this threshold during rendering.
   * Requires a `deleted_at` column on the table. Default: no pruning.
   */
  pruneBelow?: number;
  /**
   * Pipeline of enrichment functions applied to rows after query and
   * filtering but before rendering. Each function receives the row
   * array and returns a (possibly transformed) row array.
   *
   * Use enrichment hooks to cluster, annotate, summarize, or
   * cross-reference rows without modifying the underlying data.
   *
   * @example
   * ```ts
   * enrich: [
   *   (rows) => rows.map(r => ({ ...r, _age: Date.now() - new Date(r.created_at as string).getTime() })),
   *   (rows) => rows.length > 50 ? [{ summary: `${rows.length} items` }] : rows,
   * ]
   * ```
   */
  enrich?: ((rows: Row[]) => Row[])[];
  /**
   * Dynamic filter that scores rows against the current task context
   * (set via `lattice.setTaskContext()`). Called before `filter` and
   * before rendering. Only rows for which the function returns `true`
   * are included.
   *
   * The second argument is the current task-context string (empty string
   * when none has been set).
   *
   * @example
   * ```ts
   * relevanceFilter: (row, ctx) =>
   *   ctx ? String(row.body).toLowerCase().includes(ctx.toLowerCase()) : true
   * ```
   */
  relevanceFilter?: (row: Row, taskContext: string) => boolean;
  /**
   * Maximum estimated token count for the rendered output.
   * When the rendered content exceeds this budget, rows are pruned
   * (lowest-priority first) and re-rendered with a truncation notice.
   *
   * Token count is estimated at ~4 characters per token.
   */
  tokenBudget?: number;
  /**
   * Controls row priority when `tokenBudget` forces pruning.
   *
   * - `string` — column name to sort by descending (highest value = highest priority).
   * - `(a, b) => number` — custom comparator (positive = a has higher priority).
   *
   * When omitted, rows at the end of the query result are pruned first.
   */
  prioritizeBy?: string | ((a: Row, b: Row) => number);
  /**
   * Control reverse-seed behaviour for this table.
   *
   * When the database table is empty but rendered files still exist on disk,
   * reverse-seed parses those files back into database rows to recover data
   * after a DB reset/wipe.
   *
   * - `undefined` / `true` — enabled with auto-detection of built-in template parser.
   * - `false` — disabled (e.g. junction tables, computed tables).
   * - `{ parser }` — enabled with a custom parser function.
   *
   * @since 0.20.0
   */
  reverseSeed?:
    | boolean
    | {
        parser: (fileContent: string) => Record<string, unknown>[];
      };
  /**
   * Enable automatic change tracking for this table. When `true`, every
   * insert, update, and delete is recorded in `__lattice_changelog` with
   * full field-level diffs and rollback capability.
   *
   * @default false
   */
  changelog?: boolean;
  /**
   * Encrypt named columns at rest via AES-256-GCM. Same shape as the
   * `encrypted` option on EntityContextDefinition — `true` to encrypt all
   * non-structural TEXT columns, or `{ columns: [...] }` to encrypt only
   * the named ones. Requires `encryptionKey` in Lattice options; init()
   * throws otherwise.
   *
   * Encrypted values are stored as `enc:<base64(iv+tag+ciphertext)>` and
   * transparently decrypted on read. Plaintext values pass through
   * unchanged (migration-safe).
   *
   * Lets framework-shipped tables (e.g. native `secrets`) encrypt
   * sensitive columns without going through `defineEntityContext()`.
   *
   * @default false
   */
  encrypted?: boolean | { columns: string[] };
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

// ---------------------------------------------------------------------------
// Embeddings / semantic search
// ---------------------------------------------------------------------------

/**
 * Configuration for indexed full-text search on a table (see `TableDefinition.fts`).
 */
export interface FtsConfig {
  /** Columns to index. Omit to auto-detect the table's text columns. */
  fields?: string[];
}

/**
 * Configuration for embedding-based semantic search on a table.
 */
export interface EmbeddingsConfig {
  /** Column names whose values are concatenated and embedded. */
  fields: string[];
  /**
   * Function that converts text into a numeric vector.
   * Bring your own model — Lattice does not bundle an embedding provider.
   */
  embed: (text: string) => Promise<number[]>;
}

/**
 * Options for `Lattice.search()`.
 */
export interface SearchOptions {
  /** Maximum number of results to return. Default: 10. */
  topK?: number;
  /**
   * Minimum cosine similarity threshold (0–1). Results below this
   * score are excluded. Default: 0.
   */
  minScore?: number;
}

/**
 * A single search result returned by `Lattice.search()`.
 */
export interface SearchResult {
  /** The matched row from the source table. */
  row: Row;
  /** Cosine similarity score (0–1). */
  score: number;
}

/**
 * Dimension scores passed to `Lattice.reward()`.
 * Values should be between 0 and 1. The total reward is the average
 * of all provided dimension scores, accumulated over multiple calls.
 */
export type RewardScores = Record<string, number>;

/**
 * Result of a writeback validation check.
 */
export interface WritebackValidationResult {
  /** Whether the entry passed validation. */
  pass: boolean;
  /** Overall quality score (0–1). */
  score: number;
  /** Human-readable reason when validation fails. */
  reason?: string;
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
  /**
   * Optional state store for persistent offset/dedup tracking.
   * Default: in-memory (lost on process exit).
   * Use `createSQLiteStateStore(db)` for persistence across restarts.
   */
  stateStore?: import('./writeback/state-store.js').WritebackStateStore;
  /** Called after entries are processed for a file. Useful for archival. */
  onArchive?: (filePath: string) => void;
  /**
   * Optional validation hook. Called before `persist` for each entry.
   * Return `{ pass: true, score }` to allow the write, or
   * `{ pass: false, score, reason }` to reject it.
   *
   * When omitted, all parsed entries are persisted without validation.
   */
  validate?: (entry: unknown) => WritebackValidationResult | Promise<WritebackValidationResult>;
  /**
   * Minimum score threshold. Entries with `score < rejectBelow` are
   * automatically rejected even if `validate` returns `pass: true`.
   * Only meaningful when `validate` is set. Default: 0 (no threshold).
   */
  rejectBelow?: number;
  /**
   * Called for each entry that fails validation.
   * Useful for logging or auditing rejected writes.
   */
  onReject?: (entry: unknown, result: WritebackValidationResult) => void;
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
  /**
   * Open an already-provisioned database WITHOUT issuing any DDL — no
   * `CREATE TABLE`, no migrations, no FTS/changelog/embeddings setup. Used to
   * connect as a scoped, non-superuser cloud member: every table, migration,
   * and policy was installed by the cloud owner, and the member's role has no
   * CREATE/ALTER privilege, so applying the schema would fail. Declared tables
   * are introspected (best-effort) to populate the column cache; tables the
   * member can't see are skipped.
   */
  introspectOnly?: boolean;
}

export interface Migration {
  version: number | string;
  sql: string;
}

export interface WatchOptions {
  /** Poll interval in milliseconds (default: 5000) */
  interval?: number;
  onRender?: (result: RenderResult) => void;
  onError?: (err: Error) => void;
  /**
   * If set, runs orphan cleanup after each render cycle using the previous manifest.
   * Safe to enable in long-running daemons — never removes protectedFiles.
   */
  cleanup?: import('./lifecycle/cleanup.js').CleanupOptions;
  /** Called after each cleanup cycle (only when cleanup option is set). */
  onCleanup?: (result: import('./lifecycle/cleanup.js').CleanupResult) => void;
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
  | { type: 'reverseSeed'; data: { table: string; rowCount: number; source: 'files' } }
  | { type: 'error'; data: Error };

// ---------------------------------------------------------------------------
// Generic CRUD options (v0.11+)
// ---------------------------------------------------------------------------

/**
 * Options for {@link Lattice.upsertByNaturalKey}.
 */
export interface UpsertByNaturalKeyOptions {
  /** Source file path for change tracking (stored in `source_file` column if present). */
  sourceFile?: string;
  /** Content hash of the source (stored in `source_hash` column if present). */
  sourceHash?: string;
  /** Organization ID — auto-set on insert when the table has an `org_id` column and data lacks it. */
  orgId?: string;
}

/**
 * Options for {@link Lattice.link}.
 */
export interface LinkOptions {
  /** Use INSERT OR REPLACE instead of INSERT OR IGNORE. Set true when junction has updateable columns. */
  upsert?: boolean;
}

/**
 * A junction link that {@link Lattice.seed} could not create because its
 * target row did not resolve. Surfaced (never silently dropped) in
 * {@link SeedResult.unresolvedLinks} so callers can reconcile — create the
 * missing target, then re-seed — instead of ending up with a record that
 * cites a relationship in text but has no link in the graph.
 */
export interface UnresolvedLink {
  /** Natural-key value of the source record whose link failed to resolve. */
  record: string;
  /** Field on the source record that held the array of target names. */
  field: string;
  /** The target name that did not resolve to an existing row. */
  name: string;
  /** Junction table the link would have been written to. */
  junction: string;
  /** Table the name was looked up in. */
  resolveTable: string;
  /** Column on the target table the name was matched against. */
  resolveBy: string;
}

/**
 * Result from {@link Lattice.seed}.
 */
export interface SeedResult {
  upserted: number;
  linked: number;
  softDeleted: number;
  /**
   * Links whose target row did not resolve. Empty when every link
   * resolved. Always present, so callers can check
   * `result.unresolvedLinks.length` without a guard. With
   * `onUnresolvedLink: 'throw'`, {@link Lattice.seed} throws a
   * `SeedReconciliationError` carrying these instead of returning them.
   */
  unresolvedLinks: UnresolvedLink[];
}

/**
 * Link specification for {@link SeedConfig}.
 */
export interface SeedLinkSpec {
  /** Junction table name. */
  junction: string;
  /** FK column in the junction that points to the linked entity. */
  foreignKey: string;
  /** Column on the target table used to resolve names to IDs. */
  resolveBy: string;
  /** Target table name (defaults to the link key). */
  resolveTable?: string;
  /** Additional static columns to set on each junction row. */
  extras?: Record<string, unknown>;
}

/**
 * Configuration for {@link Lattice.seed}.
 */
export interface SeedConfig {
  /** Array of records to seed (caller loads from YAML/JSON). */
  data: Record<string, unknown>[];
  /** Target table. */
  table: string;
  /** Column used as the natural key for upserting. */
  naturalKey: string;
  /** Source file for soft-delete tracking. */
  sourceFile?: string;
  /** Content hash. */
  sourceHash?: string;
  /** Junction table links — key is the field name on each data record containing an array of names. */
  linkTo?: Record<string, SeedLinkSpec>;
  /** Soft-delete records not in data. */
  softDeleteMissing?: boolean;
  /** Organization ID for org-scoped tables. */
  orgId?: string;
  /**
   * How to handle a junction link whose target row doesn't resolve.
   * - `'collect'` (default): record it in {@link SeedResult.unresolvedLinks}
   *   and continue. Preserves the historical non-throwing behavior.
   * - `'throw'`: abort the seed with a `SeedReconciliationError` listing
   *   every unresolved link. Use for pipelines that must never leave a
   *   record citing a relationship that has no link in the graph.
   */
  onUnresolvedLink?: 'collect' | 'throw';
}

// ---------------------------------------------------------------------------
// Report framework (v0.14+)
// ---------------------------------------------------------------------------

/**
 * A single section in a report.
 */
export interface ReportSection {
  /** Section name (used as key in result). */
  name: string;
  /** Query configuration. */
  query: {
    /** Table to query. */
    table: string;
    /** Additional filters beyond the time window. */
    filters?: Filter[];
    /** Group results by column value prefix (e.g., type prefix). */
    groupBy?: string;
    /** Order results. */
    orderBy?: string;
    /** Sort direction. */
    orderDir?: 'asc' | 'desc';
    /** Max rows. */
    limit?: number;
  };
  /** Output format. */
  format: 'count_and_list' | 'counts' | 'list' | 'custom';
  /** Custom formatter (when format='custom'). */
  customFormat?: (rows: Row[]) => string;
}

/**
 * Configuration for {@link Lattice.buildReport}.
 */
export interface ReportConfig {
  /** Time window: ISO timestamp or shorthand ('8h', '24h', '7d'). */
  since: string;
  /** Report sections to generate. */
  sections: ReportSection[];
  /** Message when all sections are empty. */
  emptyMessage?: string;
}

/**
 * Result from {@link Lattice.buildReport}.
 */
export interface ReportSectionResult {
  name: string;
  rows: Row[];
  count: number;
  formatted: string;
}

export interface ReportResult {
  sections: ReportSectionResult[];
  isEmpty: boolean;
  since: string;
}

// ---------------------------------------------------------------------------
// Write hooks (v0.10+)
// ---------------------------------------------------------------------------

/**
 * Context passed to write hook handlers.
 */
export interface WriteHookContext {
  /** Table that was modified. */
  table: string;
  /** The operation that triggered the hook. */
  op: 'insert' | 'update' | 'delete';
  /** The row data (for insert: full row; for update: changed fields; for delete: { id }). */
  row: Row;
  /** Primary key value(s) of the affected row. */
  pk: string;
  /** For updates: the column names that were changed. */
  changedColumns?: string[];
}

/**
 * A write hook fires after insert/update/delete operations.
 *
 * @example
 * ```ts
 * db.defineWriteHook({
 *   table: 'agents',
 *   on: ['insert', 'update'],
 *   watchColumns: ['team_id'],
 *   handler: (ctx) => { denormalizeTeamFields(ctx.pk); },
 * });
 * ```
 */
export interface WriteHook {
  /** Table the hook fires on. */
  table: string;
  /** Operations that trigger the hook. */
  on: ('insert' | 'update' | 'delete')[];
  /** Only fire on update when these columns changed. Omit = fire on any change. */
  watchColumns?: string[];
  /**
   * Handler function. Fires after the DB write completes.
   *
   * The handler may return `void` (sync, fire-and-forget) OR a Promise
   * the write path will await. The async option exists so callers can
   * persist side-effects (e.g. the Lattice Teams outbox) atomically with
   * the user's `await db.insert(...)` rather than racing the response.
   */
  handler: (ctx: WriteHookContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Entity context directories (v0.5+)
// ---------------------------------------------------------------------------

export type {
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
  EntityTableColumn,
  EntityTableTemplate,
  EntityProfileField,
  EntityProfileSection,
  EntityProfileTemplate,
  EntitySectionPerRow,
  EntitySectionsTemplate,
  EntityRenderTemplate,
  EntityRenderSpec,
  ReverseSyncUpdate,
  EntityFileSpec,
  EntityContextDefinition,
} from './schema/entity-context.js';

// ---------------------------------------------------------------------------
// Lifecycle management (v0.5+)
// ---------------------------------------------------------------------------

export type { CleanupOptions, CleanupResult } from './lifecycle/cleanup.js';
import type { CleanupResult } from './lifecycle/cleanup.js';

// ---------------------------------------------------------------------------
// Reverse-sync (v0.15+)
// ---------------------------------------------------------------------------

/**
 * An error encountered while reverse-syncing a single file.
 */
export interface ReverseSyncError {
  /** Absolute path to the file that failed. */
  file: string;
  /** Error description. */
  error: string;
}

/**
 * A reverse-sync update that was NOT applied because the database row changed
 * since the render that produced the file's baseline — applying the file edit
 * would have silently overwritten that concurrent change. Reported (never
 * applied) so a human can re-resolve; the DB row is left intact.
 */
export interface ReverseSyncConflict {
  /** Entity table the conflicting row belongs to. */
  table: string;
  /** Slug of the entity whose file changed. */
  slug: string;
  /** The changed file whose write was rejected. */
  filename: string;
  /** Why the write was rejected (e.g. the row changed since render). */
  reason: string;
}

/**
 * Result of the reverse-sync phase in {@link Lattice.reconcile}.
 */
export interface ReverseSyncResult {
  /** Number of files checked for modifications. */
  filesScanned: number;
  /** Number of files that had been modified since last render. */
  filesChanged: number;
  /** Total number of DB updates applied from modified files. */
  updatesApplied: number;
  /** Errors encountered (file-level — other files still processed). */
  errors: ReverseSyncError[];
  /**
   * Changed files whose write was REJECTED because the DB row changed since the
   * render baseline (optimistic-concurrency conflict). Surfaced loudly, never
   * applied — applying would have clobbered a concurrent DB/cloud edit.
   */
  conflicts: ReverseSyncConflict[];
}

// ---------------------------------------------------------------------------
// Reverse-seed (v0.20+)
// ---------------------------------------------------------------------------

/**
 * A missing row detected during reconcile: rendered files exist on disk
 * but the corresponding database row is absent.
 *
 * For entity contexts, each detection represents a single missing entity
 * (e.g., one agent directory exists but no DB row). For regular tables
 * (no entity context), a detection means the entire table is empty but
 * a rendered file exists.
 */
export interface ReverseSeedDetection {
  /** Table the missing data belongs to. */
  table: string;
  /**
   * Entity slug (for entity context tables). Identifies which specific
   * entity is missing from the DB. Absent for table-level detections.
   */
  entity?: string;
  /** Path to the rendered file or entity directory containing recoverable data. */
  filePath: string;
}

/**
 * Result for a single table's reverse-seed recovery.
 */
export interface ReverseSeedTableResult {
  /** Table name that was reverse-seeded. */
  table: string;
  /** Number of rows recovered from files. */
  rowsRecovered: number;
}

/**
 * Aggregate result of the reverse-seed phase.
 */
export interface ReverseSeedResult {
  /** Per-table results. */
  tables: ReverseSeedTableResult[];
  /** Total rows recovered across all tables. */
  totalRowsRecovered: number;
  /** Warnings (e.g. unparseable files). */
  warnings: string[];
}

export interface ReconcileOptions {
  /** Remove entity directories whose slug is no longer in the DB. Default: true. */
  removeOrphanedDirectories?: boolean;
  /** Remove files inside entity dirs that are no longer declared. Default: true. */
  removeOrphanedFiles?: boolean;
  /** Additional globally protected files. */
  protectedFiles?: string[];
  /** Report orphans but do not delete anything. */
  dryRun?: boolean;
  /** Called for each orphan before removal. */
  onOrphan?: (path: string, kind: 'directory' | 'file') => void;
  /**
   * Enable reverse-sync: detect external file edits and sync them back to the DB
   * before rendering. Only applies to entity context files that define a
   * `reverseSync` function on their file spec.
   *
   * - `true` — run reverse-sync (default when any file spec has `reverseSync`)
   * - `false` — skip reverse-sync entirely
   * - `'dry-run'` — detect changes and report what would be synced, but do not
   *   modify the database
   *
   * Default: `true`
   */
  reverseSync?: boolean | 'dry-run';
  /**
   * Control reverse-seed behaviour during reconcile.
   *
   * When a table is empty but rendered files exist on disk, this controls
   * whether reconcile automatically recovers data or just flags the condition.
   *
   * - `undefined` / omitted — **detect only**: reports empty tables with existing
   *   files in `result.reverseSeedRequired` but does NOT auto-recover.
   *   The caller should surface this to a human and let them call
   *   `db.reverseSeed(outputDir)` explicitly.
   * - `'auto'` — silently recover data from files into empty tables.
   *   Useful for daemon/unattended processes that want self-healing.
   *
   * Default: detect only (no auto-recovery).
   */
  reverseSeed?: 'auto';
}

export interface ReconcileResult extends RenderResult {
  cleanup: CleanupResult;
  /** Result of the reverse-sync phase. `null` when `reverseSync: false`. */
  reverseSync: ReverseSyncResult | null;
  /** Result of the reverse-seed phase. `null` when not run or no tables recovered. */
  reverseSeed: ReverseSeedResult | null;
  /**
   * Tables detected as empty while rendered files exist on disk.
   * Present when `reverseSeed` option is NOT `'auto'` and at least one
   * table is in this state. The caller should surface this to a human.
   *
   * Empty array when all tables have data or no files exist.
   */
  reverseSeedRequired: ReverseSeedDetection[];
}
