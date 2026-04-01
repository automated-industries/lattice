import type { Row, Filter } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';

// ---------------------------------------------------------------------------
// Shared source query options (v0.6+)
// ---------------------------------------------------------------------------

/**
 * Optional query refinements shared by `hasMany`, `manyToMany`, and
 * `belongsTo` sources.  All fields are additive — omitting them preserves
 * the v0.5 behaviour (bare `SELECT *`).
 */
export interface SourceQueryOptions {
  /**
   * Additional WHERE clauses applied after the relationship join condition.
   * Uses the existing {@link Filter} type.
   *
   * @example `filters: [{ col: 'status', op: 'eq', val: 'active' }]`
   */
  filters?: Filter[];

  /**
   * Shorthand for `filters: [{ col: 'deleted_at', op: 'isNull' }]`.
   * When `true`, soft-deleted rows are excluded.  If both `softDelete`
   * and an explicit `deleted_at` filter are present, the explicit filter wins.
   */
  softDelete?: boolean;

  /**
   * Column(s) to ORDER BY. Validated against `[a-zA-Z0-9_]`.
   * - `string` — single column (use `orderDir` for direction)
   * - `OrderBySpec[]` — multi-column with per-column direction
   *
   * @example
   * ```ts
   * orderBy: 'name'                                  // single column
   * orderBy: [{ col: 'severity' }, { col: 'timestamp', dir: 'desc' }]  // multi
   * ```
   */
  orderBy?: string | OrderBySpec[];

  /** Sort direction when `orderBy` is a string. Defaults to `'asc'`. */
  orderDir?: 'asc' | 'desc';

  /** Maximum number of rows to return. */
  limit?: number;
}

/**
 * A single ORDER BY column with optional direction.
 * Used in the array form of `SourceQueryOptions.orderBy`.
 */
export interface OrderBySpec {
  /** Column name (validated against `[a-zA-Z0-9_]`). */
  col: string;
  /** Sort direction. Defaults to `'asc'`. */
  dir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Source types — determine which rows are passed to each file's render fn
// ---------------------------------------------------------------------------

/**
 * Yield the entity row itself as a single-element array.
 * Use for the primary entity file (e.g. `AGENT.md`).
 */
export interface SelfSource {
  type: 'self';
}

/**
 * Query rows from another table where a foreign key on that table points back
 * to this entity (e.g. all tasks where `tasks.agent_id = agent.id`).
 *
 * @example
 * ```ts
 * source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' }
 * ```
 */
export interface HasManySource extends SourceQueryOptions {
  type: 'hasMany';
  /** The related table to query */
  table: string;
  /** Column on the RELATED table that holds the FK pointing to this entity */
  foreignKey: string;
  /**
   * Column on THIS entity's table that is referenced.
   * Defaults to the entity table's first primary key column.
   */
  references?: string;
}

/**
 * Query rows from a remote table via a junction table
 * (e.g. skills for an agent via `agent_skills`).
 *
 * @example
 * ```ts
 * source: {
 *   type: 'manyToMany',
 *   junctionTable: 'agent_skills',
 *   localKey:  'agent_id',   // FK in junction → this entity
 *   remoteKey: 'skill_id',   // FK in junction → remote entity
 *   remoteTable: 'skills',
 * }
 * ```
 */
export interface ManyToManySource extends SourceQueryOptions {
  type: 'manyToMany';
  /** The junction / association table */
  junctionTable: string;
  /** Column in the junction table that points to THIS entity */
  localKey: string;
  /** Column in the junction table that points to the REMOTE entity */
  remoteKey: string;
  /** The remote table to JOIN and return rows from */
  remoteTable: string;
  /**
   * Primary key column on `remoteTable` that `remoteKey` references.
   * Defaults to `'id'`.
   */
  references?: string;
  /**
   * Columns from the junction table to include in each result row.
   * Use a string for the column name as-is, or `{ col, as }` to alias.
   *
   * @example
   * ```ts
   * junctionColumns: ['source', { col: 'role', as: 'agent_role' }]
   * // Adds j."source" and j."role" AS "agent_role" to each row
   * ```
   */
  junctionColumns?: (string | { col: string; as: string })[];
}

/**
 * Query the single row that this entity belongs to via a foreign key on
 * THIS entity's table (e.g. the team a bot belongs to via `bot.team_id`).
 *
 * Returns `[]` when the FK column is NULL; returns `[row]` when found.
 *
 * @example
 * ```ts
 * source: { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' }
 * ```
 */
export interface BelongsToSource extends SourceQueryOptions {
  type: 'belongsTo';
  /** The related table to look up */
  table: string;
  /** Column on THIS entity's table that holds the FK */
  foreignKey: string;
  /**
   * Column on the RELATED table being referenced.
   * Defaults to `'id'`.
   */
  references?: string;
}

/**
 * Fully custom query — caller receives the entity row and the raw SQLite
 * adapter, returns whatever rows they need.  Use a closure to capture any
 * additional context (other table names, filter conditions, etc.).
 *
 * @example
 * ```ts
 * source: {
 *   type: 'custom',
 *   query: (row, adapter) =>
 *     adapter.all('SELECT * FROM events WHERE actor_id = ? ORDER BY ts DESC LIMIT 20', [row.id]),
 * }
 * ```
 */
export interface CustomSource {
  type: 'custom';
  query: (row: Row, adapter: StorageAdapter) => Row[];
}

/**
 * Sub-lookup definition for an {@link EnrichedSource}.
 * Each lookup resolves related rows and attaches them to the entity row
 * as a `_key` JSON string field.
 *
 * Declarative lookups reuse the same types as file sources (with all
 * query options). Custom lookups provide full control.
 */
export type EnrichmentLookup =
  | ({ as?: string } & Omit<HasManySource, 'type'> & { type: 'hasMany' })
  | ({ as?: string } & Omit<ManyToManySource, 'type'> & { type: 'manyToMany' })
  | ({ as?: string } & Omit<BelongsToSource, 'type'> & { type: 'belongsTo' })
  | { type: 'custom'; query: (row: Row, adapter: StorageAdapter) => Row[] };

/**
 * Start with the entity's own row (like `self`) and attach related data
 * as JSON string fields.  Each key in `include` becomes a `_key` field
 * on the returned row, containing `JSON.stringify(resolvedRows)`.
 *
 * Use when a single file needs the entity's own data plus related lists
 * (e.g. an org profile that includes its agents and projects).
 *
 * @example
 * ```ts
 * source: {
 *   type: 'enriched',
 *   include: {
 *     agents:   { type: 'hasMany', table: 'agents', foreignKey: 'org_id', softDelete: true },
 *     projects: { type: 'hasMany', table: 'projects', foreignKey: 'org_id', softDelete: true },
 *   },
 * }
 * // Result: [{ ...entityRow, _agents: '[...]', _projects: '[...]' }]
 * ```
 */
export interface EnrichedSource {
  type: 'enriched';
  /** Named lookups whose results are attached as `_key` JSON fields. */
  include: Record<string, EnrichmentLookup>;
}

/** Union of all supported source types for {@link EntityFileSpec}. */
export type EntityFileSource =
  | SelfSource
  | HasManySource
  | ManyToManySource
  | BelongsToSource
  | CustomSource
  | EnrichedSource;

// ---------------------------------------------------------------------------
// File spec — one entry per file generated inside each entity directory
// ---------------------------------------------------------------------------

/**
 * Specification for a single file generated inside an entity's directory.
 *
 * @example
 * ```ts
 * 'SKILLS.md': {
 *   source: { type: 'manyToMany', junctionTable: 'agent_skills', localKey: 'agent_id',
 *             remoteKey: 'skill_id', remoteTable: 'skills' },
 *   render: (rows) => `# Skills\n\n${rows.map(r => `- ${r.name}`).join('\n')}`,
 *   omitIfEmpty: true,
 *   budget: 2000,
 * }
 * ```
 */
// ---------------------------------------------------------------------------
// Entity render templates (v0.9+)
// ---------------------------------------------------------------------------

/** Column spec for entity-table template (reuses MarkdownTableColumn). */
export interface EntityTableColumn {
  key: string;
  header: string;
  format?: (val: unknown, row: Row) => string;
}

/**
 * Render a heading + GFM table. Auto-prepends read-only header + frontmatter.
 */
export interface EntityTableTemplate {
  template: 'entity-table';
  heading: string;
  columns: EntityTableColumn[];
  emptyMessage?: string;
  frontmatter?: Record<string, string | number | boolean>;
  beforeRender?: (rows: Row[]) => Row[];
}

/**
 * Field spec for entity-profile template.
 */
export interface EntityProfileField {
  key: string;
  label: string;
  format?: (val: unknown, row: Row) => string;
}

/**
 * Section spec for entity-profile template (renders enriched JSON arrays).
 */
export interface EntityProfileSection {
  /** Key of the enriched field (e.g. 'agents' → reads row._agents). */
  key: string;
  heading: string | ((row: Row) => string);
  condition?: (row: Row) => boolean;
  render: 'table' | 'list' | ((items: Row[]) => string);
  columns?: EntityTableColumn[];
  formatItem?: (item: Row) => string;
}

/**
 * Render entity profile: heading + field-value pairs + optional enriched sections.
 */
export interface EntityProfileTemplate {
  template: 'entity-profile';
  heading: string | ((row: Row) => string);
  fields: EntityProfileField[];
  sections?: EntityProfileSection[];
  frontmatter?:
    | Record<string, string | number | boolean>
    | ((row: Row) => Record<string, string | number | boolean>);
  beforeRender?: (rows: Row[]) => Row[];
}

/**
 * Per-row section spec for entity-sections template.
 */
export interface EntitySectionPerRow {
  heading: (row: Row) => string;
  metadata?: { key: string; label: string; format?: (val: unknown) => string }[];
  body?: (row: Row) => string;
}

/**
 * Render per-row sections: heading + metadata key-value + body text per row.
 */
export interface EntitySectionsTemplate {
  template: 'entity-sections';
  heading: string;
  perRow: EntitySectionPerRow;
  emptyMessage?: string;
  frontmatter?: Record<string, string | number | boolean>;
  beforeRender?: (rows: Row[]) => Row[];
}

/** Union of all entity render template types. */
export type EntityRenderTemplate =
  | EntityTableTemplate
  | EntityProfileTemplate
  | EntitySectionsTemplate;

/** Accepted values for EntityFileSpec.render — function or template object. */
export type EntityRenderSpec = ((rows: Row[]) => string) | EntityRenderTemplate;

// ---------------------------------------------------------------------------
// File spec — one entry per file generated inside each entity directory
// ---------------------------------------------------------------------------

/**
 * A single database mutation returned by a {@link EntityFileSpec.reverseSync} function.
 * Describes one row-level update to apply when file content has been modified externally.
 */
export interface ReverseSyncUpdate {
  /** Target table name. */
  table: string;
  /** Primary key column(s) identifying the row to update. */
  pk: Record<string, unknown>;
  /** Column values to SET on the matched row. */
  set: Record<string, unknown>;
}

export interface EntityFileSpec {
  /** Determines what rows are passed to {@link render}. */
  source: EntityFileSource;
  /**
   * Converts the resolved rows into the file's markdown content.
   * Accepts a function `(rows) => string` or a declarative template object.
   */
  render: EntityRenderSpec;
  /**
   * Maximum number of characters allowed in the rendered output.
   * Content exceeding this limit is truncated with a notice appended.
   */
  budget?: number;
  /**
   * When `true`, skip writing this file if the source returns zero rows.
   * Defaults to `false`.
   */
  omitIfEmpty?: boolean;
  /**
   * Optional reverse-sync function. When provided, Lattice will detect
   * external modifications to this file (by comparing content hashes) and
   * call this function to parse the changes back into database updates.
   *
   * Called with the current file content and the entity's own row.
   * Return an array of {@link ReverseSyncUpdate} describing the DB mutations.
   * Return an empty array if no updates are needed.
   *
   * @example
   * ```ts
   * reverseSync: (content, entityRow) => {
   *   const match = content.match(/^# (.+)$/m);
   *   if (match && match[1] !== entityRow.name) {
   *     return [{ table: 'agents', pk: { id: entityRow.id }, set: { name: match[1] } }];
   *   }
   *   return [];
   * }
   * ```
   */
  reverseSync?: (content: string, entityRow: Row) => ReverseSyncUpdate[];
}

// ---------------------------------------------------------------------------
// Entity context definition — top-level config for one entity type
// ---------------------------------------------------------------------------

/**
 * Defines the parallel file-system structure for one entity type.
 *
 * Lattice uses this to generate:
 * - An optional global index file listing all entities
 * - A per-entity subdirectory with one file per declared {@link files} entry
 * - An optional combined context file (CONTEXT.md) concatenating all files
 *
 * @example
 * ```ts
 * db.defineEntityContext('agents', {
 *   slug: (row) => row.slug as string,
 *   index: { outputFile: 'agents/AGENTS.md', render: (rows) => `# Agents\n...` },
 *   files: {
 *     'AGENT.md':   { source: { type: 'self' }, render: ([r]) => `# ${r.name}` },
 *     'SKILLS.md':  { source: { type: 'manyToMany', ... }, render, omitIfEmpty: true },
 *   },
 *   combined: { outputFile: 'CONTEXT.md' },
 * });
 * ```
 */
export interface EntityContextDefinition {
  /**
   * Derives the directory slug for this entity from its row.
   * Used as the subdirectory name under {@link directoryRoot}.
   *
   * @example `(row) => row.slug as string`
   */
  slug: (row: Row) => string;

  /**
   * Optional global index file written once per render cycle (not per entity).
   * Lists all entities of this type.
   */
  index?: {
    /** Path relative to the `outputDir` passed to `render()` / `watch()` */
    outputFile: string;
    render: (rows: Row[]) => string;
  };

  /**
   * Files written inside each entity's directory.
   * Keys are filenames (e.g. `'AGENT.md'`); values define the source and renderer.
   * Files are written in iteration order.
   */
  files: Record<string, EntityFileSpec>;

  /**
   * Optional combined context file inside each entity's directory.
   * Lattice concatenates all per-entity files with `\n\n---\n\n` dividers.
   * Files listed in `exclude` are omitted from the combined output.
   */
  combined?: {
    /** Filename for the combined file (e.g. `'CONTEXT.md'`) */
    outputFile: string;
    /** Filenames to exclude from the combined output */
    exclude?: string[];
  };

  /**
   * Override the per-entity directory path relative to `outputDir`.
   * Defaults to `'{directoryRoot}/{slug}'`.
   *
   * @example `(row) => \`custom-dir/${row.slug as string}/\``
   */
  directory?: (row: Row) => string;

  /**
   * Top-level directory owned by this entity context.
   * Used by `reconcile()` to scan for orphaned subdirectories.
   * Defaults to the table name.
   */
  directoryRoot?: string;

  /**
   * Files inside each entity's directory that Lattice must never delete
   * during cleanup or reconciliation (e.g. agent-writable files like `SESSION.md`).
   * Defaults to `[]`.
   */
  protectedFiles?: string[];

  /**
   * Default query options merged into every `hasMany`, `manyToMany`, and
   * `belongsTo` source in this context.  Per-file source options override
   * these defaults.  `custom` and `self` sources are unaffected.
   *
   * @example
   * ```ts
   * sourceDefaults: { softDelete: true }   // exclude soft-deleted rows everywhere
   * ```
   */
  sourceDefaults?: SourceQueryOptions;
}
