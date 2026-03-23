import type { Row } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';

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
export interface HasManySource {
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
export interface ManyToManySource {
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
export interface BelongsToSource {
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

/** Union of all supported source types for {@link EntityFileSpec}. */
export type EntityFileSource =
  | SelfSource
  | HasManySource
  | ManyToManySource
  | BelongsToSource
  | CustomSource;

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
export interface EntityFileSpec {
  /** Determines what rows are passed to {@link render}. */
  source: EntityFileSource;
  /**
   * Converts the resolved rows into the file's markdown content.
   * For `self` sources, `rows` is always a single-element array.
   */
  render: (rows: Row[]) => string;
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
}
