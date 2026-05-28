/**
 * The Lattice function registry: a single, declarative catalog of every
 * operation the GUI can perform on a database. Each entry mirrors a GUI
 * server endpoint and carries a JSON-schema argument spec.
 *
 * This catalog is the shared artifact across the sidebar's two surfaces:
 *  - the command palette (stage 1) lists and invokes these directly;
 *  - the assistant tool loop (stage 2) exposes the identical set to the model
 *    as tools.
 *
 * Handlers are bound separately, server-side, to the shared mutation
 * functions (which append the audit-log entry and publish a feed event). The
 * registry here is declarations only, so it stays decoupled and testable.
 */

/** A minimal JSON Schema object describing a function's arguments. */
export interface ArgsSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
}

/** Coarse grouping for palette organization + read/write gating. */
export type FnCategory = 'read' | 'row' | 'schema' | 'history' | 'database';

export interface LatticeFunctionDef {
  /** Stable identifier, snake_case (also the tool name in stage 2). */
  name: string;
  /** One-line description shown in the palette and given to the model. */
  description: string;
  /** Whether invoking this mutates data (drives confirm UX + audit/feed). */
  mutates: boolean;
  category: FnCategory;
  args: ArgsSchema;
}

const obj = (
  properties: Record<string, JsonSchemaProperty>,
  required: string[] = [],
): ArgsSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (description: string): JsonSchemaProperty => ({ type: 'string', description });

export const REGISTRY: readonly LatticeFunctionDef[] = [
  // ── Reads ───────────────────────────────────────────────────────────────
  {
    name: 'list_entities',
    description: 'List all user-facing entities (tables) with their row counts.',
    mutates: false,
    category: 'read',
    args: obj({}),
  },
  {
    name: 'get_entity_graph',
    description: 'Return the entity relationship graph (nodes + many-to-many edges).',
    mutates: false,
    category: 'read',
    args: obj({}),
  },
  {
    name: 'list_rows',
    description: 'List rows in a table. Omits soft-deleted rows unless includeDeleted is true.',
    mutates: false,
    category: 'read',
    args: obj(
      {
        table: str('Table name to list rows from.'),
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted rows.' },
      },
      ['table'],
    ),
  },
  {
    name: 'get_row',
    description: 'Fetch a single row by id from a table.',
    mutates: false,
    category: 'read',
    args: obj({ table: str('Table name.'), id: str('Primary key of the row.') }, ['table', 'id']),
  },
  {
    name: 'get_row_context',
    description: 'Fetch the Lattice-rendered markdown context for a single row.',
    mutates: false,
    category: 'read',
    args: obj({ table: str('Table name.'), id: str('Primary key of the row.') }, ['table', 'id']),
  },
  {
    name: 'get_history',
    description: 'Fetch recent audit-log entries, optionally filtered to one table.',
    mutates: false,
    category: 'read',
    args: obj({
      table: str('Restrict to this table (optional).'),
      limit: { type: 'integer', description: 'Maximum entries to return.' },
    }),
  },
  {
    name: 'list_system_tables',
    description: 'List the internal Lattice bookkeeping tables and their schema.',
    mutates: false,
    category: 'read',
    args: obj({}),
  },
  {
    name: 'get_system_table_rows',
    description: 'Fetch rows from an internal Lattice system table.',
    mutates: false,
    category: 'read',
    args: obj({ table: str('System table name.') }, ['table']),
  },

  // ── Row writes ────────────────────────────────────────────────────────────
  {
    name: 'create_row',
    description: 'Create a new row in a table.',
    mutates: true,
    category: 'row',
    args: obj(
      { table: str('Table name.'), values: { type: 'object', description: 'Column → value map.' } },
      ['table', 'values'],
    ),
  },
  {
    name: 'update_row',
    description: 'Update columns on an existing row.',
    mutates: true,
    category: 'row',
    args: obj(
      {
        table: str('Table name.'),
        id: str('Primary key of the row.'),
        values: { type: 'object', description: 'Column → value map of changes.' },
      },
      ['table', 'id', 'values'],
    ),
  },
  {
    name: 'delete_row',
    description: 'Delete a row. Soft-deletes (sets deleted_at) unless hard is true.',
    mutates: true,
    category: 'row',
    args: obj(
      {
        table: str('Table name.'),
        id: str('Primary key of the row.'),
        hard: { type: 'boolean', description: 'Permanently delete instead of soft-delete.' },
      },
      ['table', 'id'],
    ),
  },
  {
    name: 'link',
    description:
      'Create a many-to-many link by inserting a junction row. `values` is the ' +
      'junction record — its two foreign-key columns (e.g. {project_id, file_id}).',
    mutates: true,
    category: 'row',
    args: obj(
      {
        table: str('Junction table name.'),
        values: { type: 'object', description: 'Junction row: the two foreign-key columns + ids.' },
      },
      ['table', 'values'],
    ),
  },
  {
    name: 'unlink',
    description: 'Remove a many-to-many link by its junction row (the two foreign-key columns + ids).',
    mutates: true,
    category: 'row',
    args: obj(
      {
        table: str('Junction table name.'),
        values: { type: 'object', description: 'Junction row identifying the link to remove.' },
      },
      ['table', 'values'],
    ),
  },

  // ── Schema mutations ──────────────────────────────────────────────────────
  {
    name: 'create_entity',
    description: 'Create a new entity (table) with an optional icon and starter columns.',
    mutates: true,
    category: 'schema',
    args: obj(
      {
        name: str('New entity name.'),
        icon: str('Emoji icon (optional).'),
        columns: {
          type: 'array',
          description: 'Starter column names (optional).',
          items: { type: 'string' },
        },
      },
      ['name'],
    ),
  },
  {
    name: 'rename_entity',
    description: 'Rename an existing entity (table).',
    mutates: true,
    category: 'schema',
    args: obj({ table: str('Current table name.'), newName: str('New table name.') }, [
      'table',
      'newName',
    ]),
  },
  {
    name: 'add_column',
    description: 'Add a column to an entity.',
    mutates: true,
    category: 'schema',
    args: obj(
      {
        table: str('Table name.'),
        column: str('New column name.'),
        type: str('Column type (e.g. text, integer).'),
      },
      ['table', 'column'],
    ),
  },
  {
    name: 'rename_column',
    description: 'Rename a column on an entity.',
    mutates: true,
    category: 'schema',
    args: obj(
      { table: str('Table name.'), column: str('Current column name.'), newName: str('New column name.') },
      ['table', 'column', 'newName'],
    ),
  },
  {
    name: 'set_column_secret',
    description: 'Toggle the secret (masked) flag on a column.',
    mutates: true,
    category: 'schema',
    args: obj(
      {
        table: str('Table name.'),
        column: str('Column name.'),
        secret: { type: 'boolean', description: 'Whether to mask the column in the GUI.' },
      },
      ['table', 'column', 'secret'],
    ),
  },
  {
    name: 'set_entity_icon',
    description: 'Set the emoji icon override for an entity.',
    mutates: true,
    category: 'schema',
    args: obj({ table: str('Table name.'), icon: str('Emoji icon.') }, ['table', 'icon']),
  },

  // ── History ───────────────────────────────────────────────────────────────
  {
    name: 'undo',
    description: 'Undo the most recent mutation.',
    mutates: true,
    category: 'history',
    args: obj({}),
  },
  {
    name: 'redo',
    description: 'Redo the most recently undone mutation.',
    mutates: true,
    category: 'history',
    args: obj({}),
  },
  {
    name: 'revert',
    description: 'Revert a specific audit-log entry by id.',
    mutates: true,
    category: 'history',
    args: obj({ auditId: str('Audit-log entry id to revert.') }, ['auditId']),
  },

  // ── Databases ─────────────────────────────────────────────────────────────
  {
    name: 'list_databases',
    description: 'List the databases this GUI can switch between.',
    mutates: false,
    category: 'database',
    args: obj({}),
  },
  {
    name: 'switch_database',
    description: 'Switch the active database.',
    mutates: true,
    category: 'database',
    args: obj({ id: str('Database identifier to switch to.') }, ['id']),
  },
  {
    name: 'create_database',
    description: 'Create a new blank database.',
    mutates: true,
    category: 'database',
    args: obj({ name: str('Name for the new database.') }, ['name']),
  },
];

const BY_NAME: ReadonlyMap<string, LatticeFunctionDef> = new Map(
  REGISTRY.map((fn) => [fn.name, fn]),
);

/** Look up a function definition by name. */
export function getFunction(name: string): LatticeFunctionDef | undefined {
  return BY_NAME.get(name);
}

/** All registered function names. */
export function functionNames(): string[] {
  return REGISTRY.map((fn) => fn.name);
}

/** Only the functions that mutate data. */
export function mutatingFunctions(): LatticeFunctionDef[] {
  return REGISTRY.filter((fn) => fn.mutates);
}
