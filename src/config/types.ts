// ---------------------------------------------------------------------------
// Lattice YAML config schema types
// ---------------------------------------------------------------------------

import type { BelongsToRelation } from '../types.js';

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
 * assignee_id: { type: uuid }
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
   * Per-column audience (Stage-0 scaffolding for the per-viewer enrichment
   * model). Names who may see this column's value in a cloud. Omitted ⇒
   * `row-audience` — the value is visible to exactly whoever can see the row,
   * which is today's behavior, so leaving it unset changes nothing. Later
   * stages parse a richer grammar (e.g. `subject+role:hr`) and generate a
   * cell-masking view from it; Stage-0 only records the metadata.
   */
  audience?: string;
  /**
   * DEPRECATED (3.x) per-field foreign-key shorthand: `ref: <targetTable>` declared
   * a `belongsTo` whose relation name is the field name with a trailing `_id`
   * stripped. Superseded by the explicit entity-level `relations:` block. 4.0 still
   * PARSES it (converted to a `belongsTo` in-memory) so existing 3.0+ configs keep
   * working, and the GUI silently rewrites it to `relations:` on open so configs
   * migrate forward. A future major may drop this once configs have upgraded.
   */
  ref?: string;
  /**
   * Marks this field as a COMPUTED column: a real, materialized column on the base
   * table whose value is derived (not hand-entered) using one of the computed field
   * kinds (alias / calc / ai_classify / ai_transform / aggregate — the same vocabulary
   * the retired computed-TABLE views used). Because it is a real column it is
   * queryable/filterable/sortable and appears in `SELECT *`. A field is computed iff it
   * carries `computed:`; deterministic kinds recompute synchronously on write, AI kinds
   * fill asynchronously. See src/schema/computed-field.ts.
   */
  computed?: ComputedFieldDef;
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
 *     id:          { type: uuid, primaryKey: true }
 *     title:       { type: text, required: true }
 *     assignee_id: { type: uuid }
 *   relations:
 *     assignee:
 *       type: belongsTo
 *       table: user
 *       foreignKey: assignee_id
 *   render: default-list
 *   outputFile: context/TICKETS.md
 * ```
 */
export interface LatticeEntityDef {
  /** Column definitions */
  fields: Record<string, LatticeFieldDef>;
  /**
   * Explicit `belongsTo` relations for this entity, keyed by relation name.
   *
   * Each entry declares a foreign key on THIS entity pointing at another
   * table: `{ type: belongsTo, table, foreignKey, references? }`. The
   * `foreignKey` names a plain field on this entity; `references` is the
   * column on the related table (defaults to its primary key). The relation
   * name (the map key) is whatever you choose — it is not derived from the
   * field name.
   *
   * @example
   * ```yaml
   * relations:
   *   assignee:
   *     type: belongsTo
   *     table: user
   *     foreignKey: assignee_id
   *     # references: id   # optional; defaults to the target's primary key
   * ```
   */
  relations?: Record<string, BelongsToRelation>;
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

// ---------------------------------------------------------------------------
// Computed tables — config-defined, read-only SQL projections
// ---------------------------------------------------------------------------

/**
 * A single field of a computed table. Every field has a direct computation:
 *
 * - `alias` — project a base column (`'status'`) or a dotted belongsTo path
 *   (`'assignee.team.name'`, resolved through declared relations).
 * - `calc` — a sandboxed calculation expression over base columns / belongsTo
 *   paths (see `schema/calc-expr.ts` for the grammar). `type` is the display
 *   type; defaults to `text`.
 * - `ai_classify` — a model-assigned label for the field's `input` value,
 *   constrained to `labels`. Model outputs are materialized once into the
 *   `__lattice_ai_map` bookkeeping table and LEFT JOINed by the view — the
 *   model is never re-run at read time.
 * - `ai_transform` — a model-derived free-form value over `inputs` (order is
 *   part of the cache identity). Materialized into `__lattice_ai_cell` per
 *   row and LEFT JOINed; a changed source row makes the join miss, so the
 *   field reads NULL until the next fill pass — never a stale value.
 * - `aggregate` — fold many junction rows into one scalar per base row via a
 *   correlated subquery. `via` is `'<junctionTable>.<remoteRelationOrTable>'`
 *   (e.g. `'ticket_tags.tag'`); `column` names the remote column to aggregate
 *   (required for every `fn` except `count`).
 */
export type ComputedFieldDef =
  | { kind: 'alias'; source: string }
  | { kind: 'calc'; expr: string; type?: LatticeFieldType }
  | {
      kind: 'ai_classify';
      input: string;
      prompt: string;
      labels: string[];
      model?: 'default' | 'cheapest';
    }
  | { kind: 'ai_transform'; inputs: string[]; prompt: string; model?: 'default' | 'cheapest' }
  | {
      kind: 'aggregate';
      via: string;
      fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'concat';
      column?: string;
    };

/**
 * A computed table: a live, read-only SQL VIEW defined over one base table
 * (a declared entity or another computed table). The view always projects the
 * base primary key as `id` first, then each field in declaration order.
 * Registered at init as a queryable, non-writable table.
 *
 * @example
 * ```yaml
 * computed:
 *   ticket_summary:
 *     base: ticket
 *     fields:
 *       title:     { kind: alias, source: title }
 *       team:      { kind: alias, source: assignee.team.name }
 *       is_urgent: { kind: calc, expr: "priority >= 3", type: boolean }
 *       tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
 * ```
 */
export interface ComputedTableDef {
  /** Base table: a declared entity or another computed table. */
  base: string;
  /** Optional human description (display metadata only). */
  description?: string;
  /** Field definitions, projected in declaration order. */
  fields: Record<string, ComputedFieldDef>;
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
  /** Computed-table (read-only SQL projection) definitions */
  computed?: Record<string, ComputedTableDef>;
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
  | {
      type: 'manyToMany';
      junctionTable: string;
      localKey: string;
      remoteKey: string;
      remoteTable: string;
      references?: string;
    }
  | { type: 'belongsTo'; table: string; foreignKey: string; references?: string };

/** A single per-entity file spec in YAML config */
export interface LatticeEntityContextFileDef {
  source: LatticeEntityContextSourceDef;
  template: string; // builtin template name
  budget?: number;
  omitIfEmpty?: boolean;
}

/** Entity context definition in YAML config */
export interface LatticeEntityContextDef {
  slug: string; // template string e.g. "{{slug}}"
  directoryRoot?: string;
  protectedFiles?: string[];
  index?: {
    outputFile: string;
    render: string; // builtin template name
  };
  files: Record<string, LatticeEntityContextFileDef>; // filename → spec
  combined?: {
    outputFile: string;
    exclude?: string[];
  };
}
