import type { Lattice } from '../lattice.js';
import type { TableDefinition } from '../types.js';
import { assertExternalIdentifier } from '../schema/identifier.js';

/**
 * Dialect-neutral schema representation for objects shared across a
 * Lattice Team. The spec is what travels over the wire (and is stored
 * on the cloud in `__lattice_shared_objects.schema_spec_json`); each
 * local lattice renders it back to dialect-appropriate DDL at apply
 * time.
 *
 * Phase 3 covers the primitive column types Lattice's own schemas use:
 * TEXT, INTEGER, REAL, BLOB, JSONB. Less-common SQL types (NUMERIC,
 * VARCHAR(N), TIMESTAMP, etc.) get normalised to the closest primitive
 * — VARCHAR/CHAR → TEXT, BIGINT/SMALLINT → INTEGER, NUMERIC/DECIMAL/
 * FLOAT/DOUBLE → REAL, BYTEA → BLOB, JSON → JSONB. Information lost in
 * the round-trip (precision, length limits) was never enforced by
 * Lattice anyway.
 *
 * `relations` is descriptive metadata only — Phase 3 strips hasMany
 * relations entirely and keeps belongsTo for future GUI/UI use, but
 * doesn't enforce FK integrity on shared rows (each end may live on a
 * different lattice). Phase 4 may revisit this once linked rows are in
 * scope.
 */

export type Dialect = 'sqlite' | 'postgres';

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'JSONB';

export interface ColumnSpec {
  type: ColumnType;
  notNull?: boolean;
  pk?: true;
  default?: string;
}

export interface SchemaSpec {
  columns: Record<string, ColumnSpec>;
  primaryKey: string | string[];
  tableConstraints?: string[];
  relations?: Record<string, { kind: 'belongsTo'; table: string; foreignKey: string }>;
  schemaVersion: number;
}

const TYPE_MAP: Record<string, ColumnType> = {
  TEXT: 'TEXT',
  VARCHAR: 'TEXT',
  CHAR: 'TEXT',
  STRING: 'TEXT',
  INTEGER: 'INTEGER',
  INT: 'INTEGER',
  BIGINT: 'INTEGER',
  SMALLINT: 'INTEGER',
  TINYINT: 'INTEGER',
  REAL: 'REAL',
  FLOAT: 'REAL',
  DOUBLE: 'REAL',
  NUMERIC: 'REAL',
  DECIMAL: 'REAL',
  BLOB: 'BLOB',
  BYTEA: 'BLOB',
  JSON: 'JSONB',
  JSONB: 'JSONB',
};

/**
 * Parse a Lattice column declaration (e.g. `"TEXT NOT NULL"`,
 * `"INTEGER PRIMARY KEY"`, `"TEXT DEFAULT 'open'"`) into a dialect-
 * neutral ColumnSpec. Strips dialect-specific tokens (`AUTOINCREMENT`,
 * `BIGSERIAL`) that don't survive the round-trip.
 */
export function parseColumnType(sql: string): ColumnSpec {
  const trimmed = sql.trim();
  // Strip parenthesised modifiers from the type token (e.g. VARCHAR(50)
  // → VARCHAR) before lookup. Anything inside `(...)` is dropped — Lattice
  // doesn't enforce length/precision anyway.
  const typeMatch = /^(\w+)(?:\s*\([^)]*\))?/i.exec(trimmed);
  const typeToken = typeMatch?.[1]?.toUpperCase() ?? '';
  const baseType: ColumnType = TYPE_MAP[typeToken] ?? 'TEXT';
  const spec: ColumnSpec = { type: baseType };
  if (/\bNOT\s+NULL\b/i.test(trimmed)) spec.notNull = true;
  if (/\bPRIMARY\s+KEY\b/i.test(trimmed)) spec.pk = true;
  // Best-effort DEFAULT capture: matches the token (or quoted string)
  // following DEFAULT, up to the next constraint keyword. Doesn't try
  // to handle DEFAULT (datetime('now')) or other function calls — those
  // are dialect-specific and pass through unchanged.
  const defaultMatch = /\bDEFAULT\s+(\([^)]+\)|'[^']*'|"[^"]*"|[^\s]+)/i.exec(trimmed);
  if (defaultMatch?.[1]) {
    spec.default = defaultMatch[1];
  }
  return spec;
}

/**
 * Render a ColumnSpec to dialect-appropriate column DDL.
 *
 * JSONB collapses to TEXT on SQLite (no native JSON type), but the
 * Postgres adapter accepts the JSONB keyword natively. Other types
 * (TEXT/INTEGER/REAL/BLOB) survive on both dialects unchanged.
 */
export function renderColumnType(spec: ColumnSpec, dialect: Dialect): string {
  let sql: string = spec.type;
  if (spec.type === 'JSONB' && dialect === 'sqlite') sql = 'TEXT';
  if (spec.type === 'BLOB' && dialect === 'postgres') sql = 'BYTEA';
  if (spec.notNull) sql += ' NOT NULL';
  if (spec.pk) sql += ' PRIMARY KEY';
  if (spec.default !== undefined) sql += ` DEFAULT ${spec.default}`;
  return sql;
}

/**
 * Render a ColumnSpec for an ALTER TABLE ADD COLUMN on an *existing* table.
 * SQLite and Postgres both reject adding a NOT NULL column without a default
 * ("Cannot add a NOT NULL column with default value NULL"), so such columns
 * are added nullable — the constraint can't be retroactively enforced on
 * existing rows anyway, and cloud-synced rows still carry their values.
 */
export function renderAddColumnType(spec: ColumnSpec, dialect: Dialect): string {
  if (spec.notNull && spec.default === undefined) {
    return renderColumnType({ ...spec, notNull: false }, dialect);
  }
  return renderColumnType(spec, dialect);
}

/**
 * Serialise a Lattice TableDefinition (plus the resolved PK column
 * list) into a SchemaSpec. `pkCols` comes from the SchemaManager's
 * `getPrimaryKey(table)` since TableDefinition.primaryKey can be left
 * undefined (defaulting to `['id']`).
 */
export function serializeSchema(
  def: TableDefinition,
  pkCols: string[],
  schemaVersion = 1,
): SchemaSpec {
  const columns: Record<string, ColumnSpec> = {};
  for (const [name, sql] of Object.entries(def.columns)) {
    columns[name] = parseColumnType(sql);
  }
  const primaryKey: string | string[] = pkCols.length === 1 ? (pkCols[0] ?? 'id') : pkCols;
  const spec: SchemaSpec = { columns, primaryKey, schemaVersion };
  if (def.tableConstraints && def.tableConstraints.length > 0) {
    spec.tableConstraints = [...def.tableConstraints];
  }
  if (def.relations) {
    const rels: Record<string, { kind: 'belongsTo'; table: string; foreignKey: string }> = {};
    for (const [key, rel] of Object.entries(def.relations)) {
      // Phase 3 propagates belongsTo only — hasMany is rendered metadata,
      // not schema, and isn't useful on the receiver side until it has
      // both ends of the relation. Strip rather than confuse Phase 4.
      if (rel.type === 'belongsTo') {
        rels[key] = { kind: 'belongsTo', table: rel.table, foreignKey: rel.foreignKey };
      }
    }
    if (Object.keys(rels).length > 0) spec.relations = rels;
  }
  return spec;
}

/**
 * Deserialise a SchemaSpec to a Lattice TableDefinition for the given
 * dialect. The returned def is suitable for `lattice.defineLate(table, def)`.
 *
 * The `render` and `outputFile` fields are stubbed since shared tables
 * don't render to context files on the receiver side — that's the
 * sharer's local concern.
 */
export function deserializeSchema(spec: SchemaSpec, dialect: Dialect): TableDefinition {
  const columns: Record<string, string> = {};
  for (const [name, colSpec] of Object.entries(spec.columns)) {
    columns[name] = renderColumnType(colSpec, dialect);
  }
  const def: TableDefinition = {
    columns,
    render: () => '',
    outputFile: `.lattice-teams/shared/${spec.schemaVersion.toString()}.md`,
  };
  // Lattice defaults to `['id']` when primaryKey is undefined. Pass the
  // explicit value only when it differs from the default, to keep
  // TableDefinitions clean.
  const isDefaultPk =
    spec.primaryKey === 'id' ||
    (Array.isArray(spec.primaryKey) && spec.primaryKey.length === 1 && spec.primaryKey[0] === 'id');
  if (!isDefaultPk) {
    def.primaryKey = spec.primaryKey;
  }
  if (spec.tableConstraints) def.tableConstraints = [...spec.tableConstraints];
  // Relations are intentionally dropped — see `serializeSchema` note.
  return def;
}

/**
 * Compare a cloud SchemaSpec against a local table's existing columns
 * + PK. Returns a list of column names that need to be ADDed locally
 * to bring it in line with the cloud — or throws TeamsSchemaConflictError
 * when the PK shape differs.
 *
 * - **PK mismatch** (different name(s), different count) → throw.
 * - **Cloud has new columns** local doesn't → returned as additive.
 * - **Local has extras** the cloud doesn't mention → preserved silently.
 *   When Phase 4 pushes a row, the payload is filtered to the cloud's
 *   columns; the local extras stay NULL on pulled rows.
 */
export function diffSchemaForAdditive(
  table: string,
  spec: SchemaSpec,
  localColumns: string[],
  localPk: string[],
): { addColumns: string[] } {
  const cloudPk = Array.isArray(spec.primaryKey) ? spec.primaryKey : [spec.primaryKey];
  const sortedCloudPk = [...cloudPk].sort();
  const sortedLocalPk = [...localPk].sort();
  if (sortedCloudPk.length !== sortedLocalPk.length) {
    throw new TeamsSchemaConflictError(
      table,
      `Cloud PK has ${sortedCloudPk.length.toString()} column(s) (${sortedCloudPk.join(', ')}); local has ${sortedLocalPk.length.toString()} (${sortedLocalPk.join(', ')})`,
    );
  }
  for (let i = 0; i < sortedCloudPk.length; i++) {
    if (sortedCloudPk[i] !== sortedLocalPk[i]) {
      throw new TeamsSchemaConflictError(
        table,
        `PK column mismatch — cloud: [${sortedCloudPk.join(', ')}], local: [${sortedLocalPk.join(', ')}]`,
      );
    }
  }
  const addColumns: string[] = [];
  for (const colName of Object.keys(spec.columns)) {
    if (!localColumns.includes(colName)) addColumns.push(colName);
  }
  return { addColumns };
}

export class TeamsSchemaConflictError extends Error {
  constructor(
    public readonly table: string,
    public readonly reason: string,
  ) {
    super(`Schema conflict on table "${table}": ${reason}`);
    this.name = 'TeamsSchemaConflictError';
  }
}

const VALID_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'JSONB',
]);

// A column DEFAULT is interpolated verbatim into DDL (`... DEFAULT <x>`), so on
// the external path it must match a conservative safe grammar: NULL, a number,
// a single-quoted string literal with no embedded quote, a bare keyword/
// function name (e.g. CURRENT_TIMESTAMP), or a parenthesised expression
// (e.g. `(datetime('now'))`) made only of characters that cannot terminate
// the statement or open a comment.
//
// The parenthesised form intentionally admits expression-shaped content (it has
// to, to allow `(datetime('now'))`). That is safe in DEFAULT position: it cannot
// stack a statement (no `;`/`--`) and a DEFAULT clause is a value expression, not
// a row-returning context — so it is not an injection or exfiltration primitive.
const SAFE_DEFAULT_RES: readonly RegExp[] = [
  /^NULL$/i,
  /^-?\d+(\.\d+)?$/,
  /^'[^']*'$/,
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  /^\([A-Za-z0-9_'(), .]*\)$/,
];
function isSafeDefault(value: string): boolean {
  return SAFE_DEFAULT_RES.some((re) => re.test(value.trim()));
}

// A table constraint is interpolated verbatim into the CREATE TABLE body. Allow
// only the character set used by UNIQUE / PRIMARY KEY / FOREIGN KEY constraints;
// reject anything (`;`, `-`, `*`, `=`, …) that could stack a statement or open a
// comment.
const SAFE_CONSTRAINT_RE = /^[A-Za-z0-9_ ,()"'.]+$/;

/**
 * Validate a SchemaSpec that may have arrived from outside the trust boundary,
 * before any of its names, types, defaults, or constraints are rendered into
 * DDL. Throws on the first violation (Rule 16 — fail loudly, never silently
 * strip). Legitimate specs (valid identifiers, the five primitive types,
 * simple string/number defaults) pass unchanged.
 */
export function validateExternalSchemaSpec(table: string, spec: SchemaSpec): void {
  assertExternalIdentifier(table, 'table');
  for (const [colName, colSpec] of Object.entries(spec.columns)) {
    assertExternalIdentifier(colName, 'column');
    if (!VALID_COLUMN_TYPES.has(colSpec.type)) {
      throw new Error(`Invalid column type for "${colName}": ${JSON.stringify(colSpec.type)}`);
    }
    if (colSpec.default !== undefined && !isSafeDefault(colSpec.default)) {
      throw new Error(`Unsafe column default for "${colName}": ${JSON.stringify(colSpec.default)}`);
    }
  }
  // PK columns are also rendered into DDL (`PRIMARY KEY ("…")`); hold them to
  // the same external standard as the column names they must reference.
  const pkCols = Array.isArray(spec.primaryKey) ? spec.primaryKey : [spec.primaryKey];
  for (const pk of pkCols) {
    assertExternalIdentifier(pk, 'column');
  }
  if (spec.tableConstraints) {
    for (const c of spec.tableConstraints) {
      if (!SAFE_CONSTRAINT_RE.test(c)) {
        throw new Error(`Unsafe table constraint: ${JSON.stringify(c)}`);
      }
    }
  }
}

/**
 * Apply a SchemaSpec to a Lattice instance: register the table via
 * `defineLate` if missing, or `addColumn` any additive cloud-only
 * columns if it already exists. Returns true when changes were made.
 * Throws `TeamsSchemaConflictError` on PK mismatch.
 *
 * Used by both the local-side `TeamsClient` (mirroring cloud-shared
 * schemas onto the user's lattice) and the cloud-side share handler
 * (which materialises the table on the cloud lattice so it can hold
 * mirrored rows for link/upsert/delete propagation).
 */
export async function applySchemaSpec(
  db: Lattice,
  table: string,
  spec: SchemaSpec,
): Promise<boolean> {
  // A SchemaSpec reaching this point may have arrived from outside the trust
  // boundary (a Team object-share request, or a peer's cloud). Every name,
  // type, default, and constraint below is interpolated verbatim into DDL, so
  // validate the whole spec before any of it is rendered.
  validateExternalSchemaSpec(table, spec);
  let cols: string[];
  try {
    cols = await db.introspectColumns(table);
  } catch {
    cols = [];
  }
  if (cols.length === 0) {
    const def = deserializeSchema(spec, db.getDialect());
    await db.defineLate(table, def);
    return true;
  }
  const pk = db.getPrimaryKey(table);
  const { addColumns } = diffSchemaForAdditive(table, spec, cols, pk);
  for (const colName of addColumns) {
    const colSpec = spec.columns[colName];
    if (!colSpec) continue;
    const sqlType = renderAddColumnType(colSpec, db.getDialect());
    await db.addColumn(table, colName, sqlType);
  }
  return addColumns.length > 0;
}
