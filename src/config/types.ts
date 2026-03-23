// ---------------------------------------------------------------------------
// Lattice YAML config schema types
// ---------------------------------------------------------------------------

/**
 * Scalar types recognised in `lattice.config.yml` field definitions.
 *
 * | YAML type   | SQLite type | TypeScript type |
 * | ----------- | ----------- | --------------- |
 * | `uuid`      | TEXT        | string          |
 * | `text`      | TEXT        | string          |
 * | `integer`   | INTEGER     | number          |
 * | `int`       | INTEGER     | number          |
 * | `real`      | REAL        | number          |
 * | `float`     | REAL        | number          |
 * | `boolean`   | INTEGER     | boolean         |
 * | `bool`      | INTEGER     | boolean         |
 * | `datetime`  | TEXT        | string          |
 * | `date`      | TEXT        | string          |
 * | `blob`      | BLOB        | Buffer          |
 */
export type LatticeFieldType =
  | 'uuid'
  | 'text'
  | 'integer'
  | 'int'
  | 'real'
  | 'float'
  | 'boolean'
  | 'bool'
  | 'datetime'
  | 'date'
  | 'blob';

/**
 * A single field (column) definition in a `lattice.config.yml` entity.
 *
 * @example
 * ```yaml
 * id:          { type: uuid,    primaryKey: true }
 * title:       { type: text,    required: true }
 * status:      { type: text,    default: open }
 * assignee_id: { type: uuid,    ref: user }
 * score:       { type: integer, default: 0 }
 * ```
 */
export interface LatticeFieldDef {
  /** Column data type */
  type: LatticeFieldType;
  /** Mark this column as the table's primary key */
  primaryKey?: boolean;
  /** Column is NOT NULL */
  required?: boolean;
  /** SQL DEFAULT value */
  default?: string | number | boolean;
  /**
   * Foreign-key reference to another entity (table name).
   * Creates a `belongsTo` relation automatically.
   * The relation name is derived from the field name — `_id` suffix is stripped
   * (e.g. `assignee_id: { ref: user }` → relation name `assignee`).
   */
  ref?: string;
}

/**
 * Inline render spec inside YAML — a flat object alternative to `TemplateRenderSpec`.
 *
 * @example
 * ```yaml
 * render:
 *   template: default-list
 *   formatRow: "{{title}} — {{status}}"
 * ```
 */
export interface LatticeEntityRenderSpec {
  template: string;
  formatRow?: string;
}

/**
 * A single entity (table) definition in `lattice.config.yml`.
 *
 * @example
 * ```yaml
 * ticket:
 *   fields:
 *     id:    { type: uuid, primaryKey: true }
 *     title: { type: text, required: true }
 *   render: default-list
 *   outputFile: context/TICKETS.md
 * ```
 */
export interface LatticeEntityDef {
  /** Column definitions */
  fields: Record<string, LatticeFieldDef>;
  /**
   * How to render rows into context text.
   * Accepts the same forms as `TableDefinition.render`:
   * - A `BuiltinTemplateName` string (e.g. `default-list`)
   * - A `{ template, formatRow }` object for hooks
   */
  render?: string | LatticeEntityRenderSpec;
  /** Render output file path (relative to the config file directory) */
  outputFile: string;
  /**
   * Optional explicit primary key override.
   * If omitted, the field with `primaryKey: true` is used.
   * Accepts a single column name or an array for composite keys.
   */
  primaryKey?: string | string[];
}

/**
 * The top-level `lattice.config.yml` document.
 *
 * @example
 * ```yaml
 * db: ./data/app.db
 * entities:
 *   ticket:
 *     fields:
 *       id: { type: uuid, primaryKey: true }
 *       title: { type: text, required: true }
 *     render: default-list
 *     outputFile: context/TICKETS.md
 * ```
 */
export interface LatticeConfig {
  /** Path to the SQLite database file (relative to the config file) */
  db: string;
  /** Entity (table) definitions */
  entities: Record<string, LatticeEntityDef>;
  /** Entity context directory definitions */
  entityContexts?: Record<string, LatticeEntityContextDef>;
}

// ---------------------------------------------------------------------------
// Entity context YAML config types
// ---------------------------------------------------------------------------

/**
 * Source spec in YAML config — either the shorthand string 'self' or an object.
 */
export type LatticeEntityContextSourceDef =
  | 'self'
  | { type: 'hasMany'; table: string; foreignKey: string; references?: string }
  | { type: 'manyToMany'; junctionTable: string; localKey: string; remoteKey: string; remoteTable: string; references?: string }
  | { type: 'belongsTo'; table: string; foreignKey: string; references?: string };

/** A single per-entity file spec in YAML config */
export interface LatticeEntityContextFileDef {
  source: LatticeEntityContextSourceDef;
  template: string;          // builtin template name
  budget?: number;
  omitIfEmpty?: boolean;
}

/** Entity context definition in YAML config */
export interface LatticeEntityContextDef {
  slug: string;              // template string e.g. "{{slug}}"
  directoryRoot?: string;
  protectedFiles?: string[];
  index?: {
    outputFile: string;
    render: string;          // builtin template name
  };
  files: Record<string, LatticeEntityContextFileDef>;  // filename → spec
  combined?: {
    outputFile: string;
    exclude?: string[];
  };
}
