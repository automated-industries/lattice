/**
 * Computed-table compiler + registration.
 *
 * A computed table is a live, READ-ONLY SQL VIEW over one base table,
 * declared in the workspace config (`computed:`). This module compiles a
 * {@link ComputedTableDef} into dialect-specific DDL:
 *
 * - The view projects the base primary key `AS "id"` first, then each field
 *   in declaration order.
 * - Soft-deleted base rows are filtered (`"b"."deleted_at" IS NULL` when the
 *   base carries that column). Each unique belongsTo path prefix becomes ONE
 *   LEFT JOIN with a deterministic alias (`j1`, `j2`, … assigned in
 *   sorted-path order, so recompiles are byte-stable); a joined table's
 *   `deleted_at IS NULL` lives in the JOIN's ON clause, so an invisible
 *   parent nulls the field without dropping the base row.
 * - `aggregate` fields compile to correlated subqueries over the junction.
 * - AI fields LEFT JOIN the `__lattice_ai_map` / `__lattice_ai_cell`
 *   bookkeeping tables (see `computed-fill.ts`) — reads never invoke a model.
 *   A transform's join matches on an `input_key` computed in SQL from the
 *   declared inputs IN ORDER, so any source change makes the join miss and
 *   the field reads NULL until the next fill pass (never stale).
 * - With `cloud.rowVisible`, every relation gains the same
 *   `lattice_row_visible(...)` predicate the cell-masking views use, so a
 *   scoped member's reads stay row-filtered.
 *
 * Everything interpolated into SQL is either a validated bare identifier
 * (see `identifier.ts`), an escaped string literal produced here, or the
 * re-serialized output of the sandboxed expression parser (`calc-expr.ts`).
 * Raw config text never reaches the SQL string.
 */

import type { ComputedTableDef, ComputedFieldDef } from '../config/types.js';
import type { BelongsToRelation, Migration, TableDefinition } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { assertExternalIdentifier } from './identifier.js';
import { pkSqlExpr } from '../db/pk.js';
import { parseCalcExpr, emitCalcExpr } from './calc-expr.js';
import type { CalcExpr } from './calc-expr.js';
import {
  AI_MAP_TABLE,
  AI_CELL_TABLE,
  COMPUTED_STATE_TABLE,
  ensureAiTables,
  recordComputedTableError,
  purgeStaleAiFields,
} from './computed-fill.js';

// ---------------------------------------------------------------------------
// Schema lookup
// ---------------------------------------------------------------------------

/** What the compiler needs to know about one referencable table. */
export interface ComputedSchemaTable {
  /** Column names present on the table. */
  columns: ReadonlySet<string>;
  /** Declared belongsTo relations, keyed by relation name. */
  relations: Readonly<Record<string, BelongsToRelation>>;
  /** Normalized primary-key columns. */
  primaryKey: readonly string[];
  /** Whether the table carries the soft-delete `deleted_at` column. */
  hasDeletedAt: boolean;
  /** Canonical Lattice field types, when known (display metadata only). */
  fieldTypes?: Readonly<Record<string, string>>;
}

/** table name → shape; built from the parsed config / live schema registry. */
export type ComputedSchema = ReadonlyMap<string, ComputedSchemaTable>;

// ---------------------------------------------------------------------------
// Compiled output
// ---------------------------------------------------------------------------

/** One compiled AI-derived field, including the SQL its fill pass runs. */
export interface CompiledAiField {
  /** Cache key: `<table>.<field>`. */
  key: string;
  /** Bare field name. */
  field: string;
  kind: 'ai_classify' | 'ai_transform';
  /** Declared input paths, in config order (order is part of the cache identity). */
  inputs: readonly string[];
  /** Compiled SQL expression per input, aligned with `inputs`. */
  inputSql: readonly string[];
  /** ai_transform only: the SQL `input_key` expression the view joins on. */
  inputKeySql?: string;
  /** ai_transform only: `CAST("b"."<pk>" AS TEXT)`. */
  rowIdSql?: string;
  /**
   * SELECT returning this field's unfilled work (no LIMIT — the fill engine
   * appends one). Classifier: never-seen DISTINCT input values. Transform:
   * join-miss rows with `row_id`, the SQL-computed `input_key`, and each
   * input value as `input_<i>` — the fill engine reads the key from the
   * database so it can never disagree with the view's join expression.
   */
  pendingSql: string;
  prompt: string;
  labels?: readonly string[];
  model: 'default' | 'cheapest';
}

export interface CompiledComputedTable {
  viewName: string;
  /** SELECT body (a preview runs it with LIMIT). */
  selectSql: string;
  /** `DROP VIEW IF EXISTS` + `CREATE VIEW`, dialect-specific. */
  createSql: string;
  /** `['id', ...fieldNames]` in declaration order. */
  columns: string[];
  /** Field → canonical Lattice display type (includes the projected `id`). */
  fieldTypes: Record<string, string>;
  /** Base + every joined / junction / remote table (bookkeeping tables excluded). */
  sources: string[];
  aiFields: CompiledAiField[];
  /** Stable hash of `createSql` — the idempotence guard for Postgres DDL. */
  contentHash: string;
}

/** Thrown by {@link computedTableOrder} when computed→computed bases form a cycle. */
export class ComputedTableCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`computed tables form a base cycle: ${cycle.join(' → ')}`);
    this.name = 'ComputedTableCycleError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(ident: string): string {
  return `"${ident}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Deterministic FNV-1a hash (hex) of the DDL — stable across processes. */
function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function err(table: string, message: string): Error {
  return new Error(`Lattice: computed table "${table}": ${message}`);
}

/**
 * Cloud-compile options. On a secured team cloud a Postgres view executes with
 * its OWNER's rights, so a computed view must (a) row-filter per viewer with
 * `lattice_row_visible(...)` predicates and (b) read every source column THROUGH
 * that table's cell-masking view when one exists — otherwise the computed view
 * exposes the RAW value of a column the owner masked from this member's role, a
 * column-level cross-tenant leak that the normal `<t>_v` masked read path would
 * have caught.
 */
export interface CloudCompileOptions {
  rowVisible: true;
  /**
   * Source tables that carry a cell-masking view (`<t>_v`, generated from
   * `__lattice_column_policy`; see cloud/audience.ts). A computed field reading a
   * column of such a table is compiled to read it through `<t>_v`, which encodes
   * BOTH per-column masking (a masked cell reads NULL for a member) AND row
   * visibility — so a table read through its masking view needs no separate
   * `lattice_row_visible` predicate (the view already applies it).
   */
  maskedTables?: ReadonlySet<string>;
}

/** True when `table` has a cell-masking `<t>_v` view we must read through. */
function isMaskedTable(cloud: CloudCompileOptions | undefined, table: string): boolean {
  return cloud?.maskedTables?.has(table) ?? false;
}

/**
 * The relation a source table is read through: its `<t>_v` masking view when the
 * table has one (row visibility + column masking, both keyed on the member via
 * SECURITY DEFINER helpers, so nesting inside an owner-owned computed view still
 * binds to the real viewer), else the base table.
 */
function sourceRelation(cloud: CloudCompileOptions | undefined, table: string): string {
  return isMaskedTable(cloud, table) ? q(`${table}_v`) : q(table);
}

// ---------------------------------------------------------------------------
// Topological ordering
// ---------------------------------------------------------------------------

/**
 * Order computed-table definitions so every base compiles before the tables
 * built on it (dependencies first). Only bases that are themselves computed
 * tables participate; entity bases are leaves. Throws
 * {@link ComputedTableCycleError} on a cycle, naming it.
 */
export function computedTableOrder(defs: Record<string, ComputedTableDef>): string[] {
  const names = new Set(Object.keys(defs));
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, path: string[]): void => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      const start = path.indexOf(name);
      throw new ComputedTableCycleError([...path.slice(start), name]);
    }
    state.set(name, 'visiting');
    const def = defs[name];
    if (def && names.has(def.base)) visit(def.base, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };

  for (const name of names) visit(name, []);
  return order;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface ResolvedRef {
  /** Relation-name chain from the base (empty for a base column). */
  prefix: readonly string[];
  /** Table reached at each prefix step (aligned with `prefix`). */
  prefixTables: readonly string[];
  /** Table the final column lives on. */
  table: string;
  column: string;
}

/** Resolve a bare column or dotted belongsTo path against the base table. */
function resolveRefPath(
  schema: ComputedSchema,
  name: string,
  baseTable: string,
  path: readonly string[],
  what: string,
): ResolvedRef {
  const segs = [...path];
  const column = segs.pop();
  if (column === undefined || column.length === 0 || segs.some((s) => s.length === 0)) {
    throw err(name, `${what}: empty reference`);
  }
  let table = baseTable;
  const prefix: string[] = [];
  const prefixTables: string[] = [];
  for (const seg of segs) {
    const shape = schema.get(table);
    const rel = shape?.relations[seg];
    if (!rel) {
      throw err(name, `${what}: "${table}" has no belongsTo relation "${seg}"`);
    }
    if (!schema.has(rel.table)) {
      throw err(name, `${what}: relation "${seg}" points at unknown table "${rel.table}"`);
    }
    prefix.push(seg);
    prefixTables.push(rel.table);
    table = rel.table;
  }
  const shape = schema.get(table);
  if (!shape?.columns.has(column)) {
    throw err(name, `${what}: "${table}" has no column "${column}"`);
  }
  return { prefix, prefixTables, table, column };
}

/** Table shape guaranteed present (validated by the resolution pass). */
function shapeOf(schema: ComputedSchema, table: string): ComputedSchemaTable {
  const shape = schema.get(table);
  if (!shape) throw invariant(`lost table "${table}"`);
  return shape;
}

/**
 * An internal-consistency failure: pass 2 asked for something pass 1 must
 * have produced. Unreachable for validated definitions.
 */
function invariant(message: string): Error {
  return new Error(`Lattice: computed-table compiler invariant: ${message}`);
}

/**
 * Compile one computed-table definition into dialect-specific view DDL plus
 * the metadata later slices need (columns, display types, AI fill SQL).
 * Pure: validates everything it touches and throws a descriptive error on
 * any unknown table, relation, or column. `schema` must already contain any
 * computed table used as `base` (compile in {@link computedTableOrder}).
 */
export function compileComputedTable(
  name: string,
  def: ComputedTableDef,
  schema: ComputedSchema,
  dialect: 'sqlite' | 'postgres',
  cloud?: CloudCompileOptions,
): CompiledComputedTable {
  assertExternalIdentifier(name, 'table');
  if (schema.has(name)) {
    throw err(name, `name collides with an existing table`);
  }
  const base = schema.get(def.base);
  if (!base) {
    throw err(name, `unknown base table "${def.base}"`);
  }
  const fieldNames = Object.keys(def.fields);
  if (fieldNames.length === 0) {
    throw err(name, `must declare at least one field`);
  }
  for (const field of fieldNames) {
    assertExternalIdentifier(field, 'column');
    if (field === 'id') {
      throw err(name, `field "id" collides with the projected base primary key`);
    }
  }
  const pkCols = base.primaryKey.length > 0 ? base.primaryKey : ['id'];
  const basePk = pkCols[0] ?? 'id';
  if (pkCols.length !== 1) {
    throw err(
      name,
      `base "${def.base}" has a composite primary key — a single-column key is required`,
    );
  }
  if (!base.columns.has(basePk)) {
    throw err(name, `base "${def.base}" is missing its primary key column "${basePk}"`);
  }

  // ── Pass 1: resolve every reference, collecting belongsTo join prefixes ──
  const prefixTables = new Map<string, string>(); // 'a.b' → table at that prefix
  const noteRef = (ref: ResolvedRef): void => {
    ref.prefixTables.forEach((table, i) => {
      prefixTables.set(ref.prefix.slice(0, i + 1).join('.'), table);
    });
  };
  const resolve = (path: string, what: string): ResolvedRef => {
    const ref = resolveRefPath(schema, name, def.base, path.split('.'), what);
    noteRef(ref);
    return ref;
  };

  const aliasRefs = new Map<string, ResolvedRef>(); // field → resolved alias source
  const calcExprs = new Map<string, CalcExpr>(); // field → parsed expression
  const inputRefs = new Map<string, ResolvedRef[]>(); // AI field → resolved inputs

  for (const [field, fdef] of Object.entries(def.fields)) {
    switch (fdef.kind) {
      case 'alias':
        aliasRefs.set(field, resolve(fdef.source, `field "${field}"`));
        break;
      case 'calc': {
        let expr: CalcExpr;
        try {
          expr = parseCalcExpr(fdef.expr, (path) => {
            try {
              resolve(path.join('.'), `field "${field}"`);
              return true;
            } catch {
              return false;
            }
          });
        } catch (e) {
          throw err(name, `field "${field}": ${(e as Error).message}`);
        }
        calcExprs.set(field, expr);
        break;
      }
      case 'ai_classify':
        validateAiField(name, field, fdef.prompt, fdef.labels);
        inputRefs.set(field, [resolve(fdef.input, `field "${field}"`)]);
        break;
      case 'ai_transform': {
        validateAiField(name, field, fdef.prompt);
        if (fdef.inputs.length === 0) {
          throw err(name, `field "${field}": ai_transform needs at least one input`);
        }
        inputRefs.set(
          field,
          fdef.inputs.map((p) => resolve(p, `field "${field}"`)),
        );
        break;
      }
      case 'aggregate':
        // Validated (and emitted) in pass 2 — aggregates are self-contained
        // correlated subqueries and add no view-level joins.
        break;
      default: {
        const kind = String((fdef as { kind?: unknown }).kind);
        throw err(name, `field "${field}": unknown kind "${kind}"`);
      }
    }
  }

  // ── Deterministic join aliases: sorted-path order → j1, j2, … ─────────────
  const sortedPrefixes = [...prefixTables.keys()].sort();
  const joinAlias = new Map<string, string>();
  sortedPrefixes.forEach((prefix, i) => joinAlias.set(prefix, `j${String(i + 1)}`));

  const aliasForKey = (key: string): string => {
    if (key === '') return 'b';
    const alias = joinAlias.get(key);
    if (alias === undefined) throw invariant(`no join alias for path "${key}"`);
    return alias;
  };
  const aliasFor = (prefix: readonly string[]): string => aliasForKey(prefix.join('.'));
  const columnSql = (ref: ResolvedRef): string => `${q(aliasFor(ref.prefix))}.${q(ref.column)}`;

  const rowVisible = (table: string, pk: readonly string[], alias: string): string =>
    `lattice_row_visible(${sqlString(table)}, ${pkSqlExpr(pk, `${q(alias)}.`)})`;

  // belongsTo LEFT JOINs, in sorted-prefix order.
  const relationJoins: string[] = [];
  for (const prefix of sortedPrefixes) {
    const segs = prefix.split('.');
    const relName = segs.pop() ?? '';
    const parentKey = segs.join('.');
    const parentTable = parentKey === '' ? def.base : (prefixTables.get(parentKey) ?? def.base);
    const rel = shapeOf(schema, parentTable).relations[relName];
    if (!rel) throw invariant(`relation "${relName}" vanished from "${parentTable}"`);
    const child = shapeOf(schema, rel.table);
    const refCol = rel.references ?? child.primaryKey[0] ?? 'id';
    assertExternalIdentifier(rel.foreignKey, 'column');
    assertExternalIdentifier(refCol, 'column');
    const alias = aliasForKey(prefix);
    const on: string[] = [
      `${q(alias)}.${q(refCol)} = ${q(aliasForKey(parentKey))}.${q(rel.foreignKey)}`,
    ];
    if (child.hasDeletedAt) on.push(`${q(alias)}."deleted_at" IS NULL`);
    // A masked table is read through its `<t>_v` view, which already row-filters —
    // so the predicate would be redundant (and double-filtering). Only add it when
    // reading the base table directly.
    if (cloud && !isMaskedTable(cloud, rel.table)) {
      on.push(rowVisible(rel.table, child.primaryKey, alias));
    }
    relationJoins.push(
      `LEFT JOIN ${sourceRelation(cloud, rel.table)} ${q(alias)} ON ${on.join(' AND ')}`,
    );
  }

  // Base filters — shared by the view WHERE and the AI pending queries.
  const baseFilters: string[] = [];
  if (base.hasDeletedAt) baseFilters.push(`"b"."deleted_at" IS NULL`);
  if (cloud && !isMaskedTable(cloud, def.base)) baseFilters.push(rowVisible(def.base, pkCols, 'b'));

  const fromLines = [`FROM ${sourceRelation(cloud, def.base)} "b"`, ...relationJoins];
  const rowIdSql = `CAST("b".${q(basePk)} AS TEXT)`;
  const usSql = dialect === 'sqlite' ? 'CHAR(31)' : 'CHR(31)';

  // ── Pass 2: emit each field's projection (plus AI joins / subqueries) ─────
  const selectCols: string[] = [`"b".${q(basePk)} AS "id"`];
  const aiJoins: string[] = [];
  const aiFields: CompiledAiField[] = [];
  const fieldTypes: Record<string, string> = {
    id: base.fieldTypes?.[basePk] ?? 'text',
  };
  const aggregateTables: string[] = [];
  let mapIdx = 0;
  let cellIdx = 0;

  for (const [field, fdef] of Object.entries(def.fields)) {
    switch (fdef.kind) {
      case 'alias': {
        const ref = aliasRefs.get(field);
        if (!ref) throw invariant(`alias field "${field}" was not resolved`);
        selectCols.push(`${columnSql(ref)} AS ${q(field)}`);
        fieldTypes[field] = shapeOf(schema, ref.table).fieldTypes?.[ref.column] ?? 'text';
        break;
      }
      case 'calc': {
        const expr = calcExprs.get(field);
        if (!expr) throw invariant(`calc field "${field}" was not parsed`);
        const sql = emitCalcExpr(expr, {
          dialect,
          columnSql: (path) =>
            columnSql(resolveRefPath(schema, name, def.base, path, `field "${field}"`)),
        });
        selectCols.push(`${sql} AS ${q(field)}`);
        fieldTypes[field] = fdef.type ?? 'text';
        break;
      }
      case 'ai_classify': {
        const key = `${name}.${field}`;
        const inputRef = inputRefs.get(field)?.[0];
        if (!inputRef) throw invariant(`classify field "${field}" was not resolved`);
        const inSql = columnSql(inputRef);
        mapIdx++;
        const alias = `m${String(mapIdx)}`;
        aiJoins.push(
          `LEFT JOIN ${q(AI_MAP_TABLE)} ${q(alias)} ON ${q(alias)}."field_key" = ${sqlString(key)} ` +
            `AND ${q(alias)}."input_value" = CAST(${inSql} AS TEXT)`,
        );
        selectCols.push(`${q(alias)}."label" AS ${q(field)}`);
        fieldTypes[field] = 'text';
        const pendingSql =
          `SELECT DISTINCT CAST(${inSql} AS TEXT) AS "input_value" ` +
          `${fromLines.join(' ')} WHERE ${[...baseFilters, `${inSql} IS NOT NULL`].join(' AND ')} ` +
          `AND NOT EXISTS (SELECT 1 FROM ${q(AI_MAP_TABLE)} "mx" WHERE "mx"."field_key" = ${sqlString(key)} ` +
          `AND "mx"."input_value" = CAST(${inSql} AS TEXT))`;
        aiFields.push({
          key,
          field,
          kind: 'ai_classify',
          inputs: [fdef.input],
          inputSql: [inSql],
          pendingSql,
          prompt: fdef.prompt,
          labels: [...fdef.labels],
          model: fdef.model ?? 'default',
        });
        break;
      }
      case 'ai_transform': {
        const key = `${name}.${field}`;
        const refs = inputRefs.get(field);
        if (!refs) throw invariant(`transform field "${field}" was not resolved`);
        const inSqls = refs.map((r) => columnSql(r));
        const inputKeySql = inSqls
          .map((s) => `COALESCE(CAST(${s} AS TEXT), '')`)
          .join(` || ${usSql} || `);
        cellIdx++;
        const alias = `c${String(cellIdx)}`;
        aiJoins.push(
          `LEFT JOIN ${q(AI_CELL_TABLE)} ${q(alias)} ON ${q(alias)}."field_key" = ${sqlString(key)} ` +
            `AND ${q(alias)}."row_id" = ${rowIdSql} AND ${q(alias)}."input_key" = ${inputKeySql}`,
        );
        selectCols.push(`${q(alias)}."output" AS ${q(field)}`);
        fieldTypes[field] = 'text';
        const pendingCols = [
          `${rowIdSql} AS "row_id"`,
          `${inputKeySql} AS "input_key"`,
          ...inSqls.map((s, i) => `${s} AS ${q(`input_${String(i)}`)}`),
        ];
        const pendingSql =
          `SELECT ${pendingCols.join(', ')} ${fromLines.join(' ')} ` +
          `LEFT JOIN ${q(AI_CELL_TABLE)} "cx" ON "cx"."field_key" = ${sqlString(key)} ` +
          `AND "cx"."row_id" = ${rowIdSql} AND "cx"."input_key" = ${inputKeySql} ` +
          `WHERE ${[...baseFilters, `"cx"."row_id" IS NULL`].join(' AND ')}`;
        aiFields.push({
          key,
          field,
          kind: 'ai_transform',
          inputs: [...fdef.inputs],
          inputSql: inSqls,
          inputKeySql,
          rowIdSql,
          pendingSql,
          prompt: fdef.prompt,
          model: fdef.model ?? 'default',
        });
        break;
      }
      case 'aggregate': {
        const { sql, junction, remote, remoteColumnType } = compileAggregate(
          name,
          field,
          fdef,
          def.base,
          basePk,
          schema,
          dialect,
          cloud,
        );
        selectCols.push(`${sql} AS ${q(field)}`);
        fieldTypes[field] =
          fdef.fn === 'count'
            ? 'integer'
            : fdef.fn === 'sum' || fdef.fn === 'avg'
              ? 'real'
              : fdef.fn === 'concat'
                ? 'text'
                : remoteColumnType;
        aggregateTables.push(junction, remote);
        break;
      }
    }
  }

  const whereLine = baseFilters.length > 0 ? `\nWHERE ${baseFilters.join(' AND ')}` : '';
  const selectSql =
    `SELECT ${selectCols.join(', ')}\n` + [...fromLines, ...aiJoins].join('\n') + whereLine;
  const createSql = `DROP VIEW IF EXISTS ${q(name)};\nCREATE VIEW ${q(name)} AS\n${selectSql};`;

  const sources: string[] = [];
  for (const t of [def.base, ...prefixTables.values(), ...aggregateTables]) {
    if (!sources.includes(t)) sources.push(t);
  }

  return {
    viewName: name,
    selectSql,
    createSql,
    columns: ['id', ...fieldNames],
    fieldTypes,
    sources,
    aiFields,
    contentHash: fnv1aHex(createSql),
  };
}

function validateAiField(name: string, field: string, prompt: unknown, labels?: unknown): void {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw err(name, `field "${field}": prompt must be a non-empty string`);
  }
  if (labels !== undefined) {
    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.some((l) => typeof l !== 'string' || l.trim().length === 0)
    ) {
      throw err(name, `field "${field}": labels must be a non-empty array of non-empty strings`);
    }
  }
}

function compileAggregate(
  name: string,
  field: string,
  fdef: Extract<ComputedFieldDef, { kind: 'aggregate' }>,
  baseTable: string,
  basePk: string,
  schema: ComputedSchema,
  dialect: 'sqlite' | 'postgres',
  cloud?: CloudCompileOptions,
): { sql: string; junction: string; remote: string; remoteColumnType: string } {
  const what = `field "${field}"`;
  const [junctionName = '', remotePart = '', ...extra] = fdef.via.split('.');
  if (junctionName.length === 0 || remotePart.length === 0 || extra.length > 0) {
    throw err(
      name,
      `${what}: via must be "<junctionTable>.<remoteRelationOrTable>" (got ${JSON.stringify(fdef.via)})`,
    );
  }
  const junction = schema.get(junctionName);
  if (!junction) {
    throw err(name, `${what}: unknown junction table "${junctionName}"`);
  }

  // FK back to the base: the junction must declare exactly one belongsTo
  // relation pointing at the base table.
  const baseRels = Object.values(junction.relations).filter((r) => r.table === baseTable);
  const baseRel = baseRels[0];
  if (!baseRel) {
    throw err(
      name,
      `${what}: junction "${junctionName}" has no belongsTo relation to base "${baseTable}"`,
    );
  }
  if (baseRels.length > 1) {
    throw err(
      name,
      `${what}: junction "${junctionName}" has multiple relations to base "${baseTable}" — ambiguous`,
    );
  }
  const baseFk = baseRel.foreignKey;
  assertExternalIdentifier(baseFk, 'column');

  // Remote side: a relation NAME on the junction, or a table name with a
  // single unambiguous relation pointing at it.
  let remoteRel: BelongsToRelation | undefined = junction.relations[remotePart];
  if (!remoteRel) {
    const byTable = Object.values(junction.relations).filter((r) => r.table === remotePart);
    if (byTable.length === 1) remoteRel = byTable[0];
    else if (byTable.length > 1) {
      throw err(
        name,
        `${what}: junction "${junctionName}" has multiple relations to "${remotePart}" — name the relation instead`,
      );
    }
  }
  if (!remoteRel) {
    throw err(name, `${what}: junction "${junctionName}" has no relation "${remotePart}"`);
  }
  const remote = schema.get(remoteRel.table);
  if (!remote) {
    throw err(
      name,
      `${what}: relation "${remotePart}" points at unknown table "${remoteRel.table}"`,
    );
  }
  const remoteRef = remoteRel.references ?? remote.primaryKey[0] ?? 'id';
  assertExternalIdentifier(remoteRel.foreignKey, 'column');
  assertExternalIdentifier(remoteRef, 'column');

  // Aggregated column.
  if (fdef.fn === 'count') {
    if (fdef.column !== undefined) {
      throw err(name, `${what}: count aggregates every junction row — remove "column"`);
    }
  } else {
    if (typeof fdef.column !== 'string' || fdef.column.length === 0) {
      throw err(name, `${what}: fn "${fdef.fn}" requires a "column" on the remote table`);
    }
    assertExternalIdentifier(fdef.column, 'column');
    if (!remote.columns.has(fdef.column)) {
      throw err(name, `${what}: "${remoteRel.table}" has no column "${fdef.column}"`);
    }
  }

  const col = fdef.column !== undefined ? `"x2".${q(fdef.column)}` : '';
  const agg =
    fdef.fn === 'count'
      ? 'COUNT(*)'
      : fdef.fn === 'concat'
        ? dialect === 'sqlite'
          ? `GROUP_CONCAT(${col}, ', ')`
          : `STRING_AGG(CAST(${col} AS TEXT), ', ')`
        : `${fdef.fn.toUpperCase()}(${col})`;

  const joinOn: string[] = [`"x2".${q(remoteRef)} = "x1".${q(remoteRel.foreignKey)}`];
  if (remote.hasDeletedAt) joinOn.push(`"x2"."deleted_at" IS NULL`);
  // A masked source is read through its `<t>_v` view (column masking + row
  // visibility), so its `lattice_row_visible` predicate would be redundant.
  if (cloud && !isMaskedTable(cloud, remoteRel.table)) {
    joinOn.push(
      `lattice_row_visible(${sqlString(remoteRel.table)}, ${pkSqlExpr(remote.primaryKey, '"x2".')})`,
    );
  }
  const where: string[] = [`"x1".${q(baseFk)} = "b".${q(basePk)}`];
  if (junction.hasDeletedAt) where.push(`"x1"."deleted_at" IS NULL`);
  if (cloud && !isMaskedTable(cloud, junctionName)) {
    where.push(
      `lattice_row_visible(${sqlString(junctionName)}, ${pkSqlExpr(junction.primaryKey, '"x1".')})`,
    );
  }

  const sql =
    `(SELECT ${agg} FROM ${sourceRelation(cloud, junctionName)} "x1" ` +
    `JOIN ${sourceRelation(cloud, remoteRel.table)} "x2" ON ${joinOn.join(' AND ')} ` +
    `WHERE ${where.join(' AND ')})`;

  return {
    sql,
    junction: junctionName,
    remote: remoteRel.table,
    remoteColumnType:
      (fdef.column !== undefined ? remote.fieldTypes?.[fdef.column] : undefined) ?? 'text',
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The registration seam the core exposes to this module — kept structural so
 * `lattice.ts` can pass a closure-backed host without a runtime import cycle.
 */
export interface ComputedTableHost {
  adapter: StorageAdapter;
  /** Apply version-guarded migrations (the Postgres DDL path). */
  migrate(migrations: Migration[]): Promise<void>;
  introspectColumns(table: string): Promise<string[]>;
  /**
   * Batch-introspect several tables' columns in ONE round-trip (table → ordered
   * columns). Optional: when absent, registration falls back to a per-table
   * {@link introspectColumns} loop. Providing it collapses the post-create
   * introspection of K computed views into a single `information_schema` query,
   * so a pooled-cloud open never pays K serial round-trips just to read columns.
   */
  introspectAllColumns?(tables: string[]): Promise<Map<string, Set<string>>>;
  /** Register the already-existing view in the live schema registry. Issues NO DDL. */
  register(table: string, def: TableDefinition, columns: readonly string[]): void;
}

export interface RegisterComputedTablesOptions {
  /** Lookup for every referencable table (entities + already-registered tables). */
  schema: ComputedSchema;
  dialect: 'sqlite' | 'postgres';
  /**
   * Scoped cloud member open: the role cannot DDL, so register purely by
   * introspection — no view DDL, no bookkeeping-table creation, and a view
   * this member cannot see is skipped rather than treated as a failure.
   */
  introspectOnly?: boolean;
  /**
   * Cloud compile: emit per-relation `lattice_row_visible` predicates and read
   * masked source tables through their cell-masking `<t>_v` view (see
   * {@link CloudCompileOptions}).
   */
  cloud?: CloudCompileOptions;
  /**
   * Runtime (ops-layer) registration: execute the view DDL directly (drop +
   * recreate) on Postgres too, instead of the content-hash migration the open
   * path uses. A runtime edit can be REVERTED to a prior definition whose
   * content hash was already applied once — a version-guarded migration would
   * skip that DDL and silently leave the view on the newer definition.
   */
  directDdl?: boolean;
}

export interface ComputedRegistrationResult {
  /** Successfully compiled + registered computed tables, in topo order. */
  registered: string[];
  /** Introspect-only opens where the view is not (yet) visible to this role. */
  skipped: string[];
  /** Per-table failures. A failure never aborts the open or the other tables. */
  errors: { table: string; error: string }[];
  /** Compiled artifacts, for the fill engine / preview / ops layers. */
  compiled: Map<string, CompiledComputedTable>;
}

/** The content-hash migration version guarding one table's view DDL. */
function migrationVersion(name: string, compiled: CompiledComputedTable): string {
  return `internal:computed-table:${name}:v1:${compiled.contentHash}`;
}

/**
 * Which of `versions` are already recorded in the migrations ledger — ONE
 * round-trip for the whole batch, so a converged pooled-Postgres open never
 * pays a per-table migrate call just to discover there is nothing to do.
 */
async function appliedMigrationVersions(
  adapter: StorageAdapter,
  versions: readonly string[],
): Promise<Set<string>> {
  if (versions.length === 0) return new Set();
  const rows = await allAsyncOrSync(
    adapter,
    `SELECT version FROM __lattice_migrations WHERE version IN (${versions
      .map(() => '?')
      .join(', ')})`,
    [...versions],
  );
  return new Set(rows.map((r) => String(r.version)));
}

/**
 * Introspect every created view's columns in as few round-trips as the host
 * allows: ONE batched `information_schema` query when it exposes
 * {@link ComputedTableHost.introspectAllColumns}, else a per-table fallback. The
 * result maps each view name to its ordered column list (a view absent from the
 * catalog — e.g. one this role can't see — is simply missing from the map).
 */
async function introspectComputedColumns(
  host: ComputedTableHost,
  viewNames: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (viewNames.length === 0) return out;
  if (host.introspectAllColumns) {
    const all = await host.introspectAllColumns([...viewNames]);
    for (const name of viewNames) {
      const cols = all.get(name);
      if (cols) out.set(name, [...cols]);
    }
    return out;
  }
  for (const name of viewNames) out.set(name, await host.introspectColumns(name));
  return out;
}

/**
 * Compile every computed-table definition in topological order, execute the
 * view DDL, introspect the result, and register it with the host.
 *
 * DDL is planned dependency-aware: when a table's view must be (re)created —
 * SQLite and the runtime `directDdl` path always recreate; Postgres recreates
 * when the definition's content-hash migration has not been applied — every
 * TRANSITIVE dependent (a computed table based on it) is dropped first in
 * reverse-topological order and force-recreated afterwards in topological
 * order. Postgres refuses `DROP VIEW` while dependents exist, so without the
 * plan a changed base failed to re-register AND took its dependents with it
 * on the next open; and a dependent whose own hash is unchanged must be
 * recreated DIRECTLY (its migration version is already recorded — a
 * version-guarded migrate would skip the CREATE and leave the view missing).
 * (`CREATE OR REPLACE VIEW` is deliberately not used — it fails whenever the
 * column list changes.)
 *
 * A definition that fails to compile (or whose DDL fails) must NOT brick the
 * open: it is skipped, recorded under field `'*'` in
 * `__lattice_computed_state`, reported in the returned result, and the
 * remaining tables continue. This function itself never throws for a
 * per-table failure.
 *
 * After registration, stored AI outputs whose `prompt_hash` no longer matches
 * the current definition are purged ({@link purgeStaleAiFields}), so a
 * definition changed through ANY path (ops layer, hand-edited YAML,
 * member-hydrated config) never keeps serving values derived from a prompt or
 * label set that no longer exists.
 */
export async function registerComputedTables(
  host: ComputedTableHost,
  defs: Record<string, ComputedTableDef>,
  opts: RegisterComputedTablesOptions,
): Promise<ComputedRegistrationResult> {
  const result: ComputedRegistrationResult = {
    registered: [],
    skipped: [],
    errors: [],
    compiled: new Map(),
  };
  if (Object.keys(defs).length === 0) return result;

  const introspectOnly = opts.introspectOnly === true;
  const schema = new Map<string, ComputedSchemaTable>(opts.schema);

  /** Record one table's failure — in the result and (owner paths) the state table. */
  const recordFailure = async (name: string, e: unknown): Promise<void> => {
    let message = (e as Error).message;
    if (!introspectOnly) {
      try {
        await recordComputedTableError(host.adapter, name, message);
      } catch (stateErr) {
        // The failure itself is still surfaced through the returned report;
        // note the bookkeeping write's failure alongside it.
        message = `${message} (state record also failed: ${(stateErr as Error).message})`;
      }
    }
    result.errors.push({ table: name, error: message });
  };

  let erroredBefore = new Set<string>();
  if (!introspectOnly) {
    // The state table must exist before any per-table failure can be recorded.
    await ensureAiTables(host.adapter);
    // Which tables carry a recorded registration error from a PRIOR open — one
    // bounded read for all of them, so the per-table success cleanup below
    // never issues an unconditional DELETE per table (pooled-connection cost).
    const errorRows = await allAsyncOrSync(
      host.adapter,
      `SELECT "table_name" FROM "${COMPUTED_STATE_TABLE}" WHERE "field" = '*'`,
    );
    erroredBefore = new Set(errorRows.map((r) => String(r.table_name)));
  }

  // Tolerant ordering: config parsing already rejects cycles, but a caller
  // composing defs directly must not brick the open either — cycle members
  // are recorded as errors and the remaining tables still register.
  const excluded = new Set<string>();
  let order: string[] = [];
  for (;;) {
    try {
      order = computedTableOrder(
        Object.fromEntries(Object.entries(defs).filter(([n]) => !excluded.has(n))),
      );
      break;
    } catch (e) {
      if (e instanceof ComputedTableCycleError) {
        for (const table of new Set(e.cycle)) {
          result.errors.push({ table, error: e.message });
          if (!introspectOnly) await recordComputedTableError(host.adapter, table, e.message);
          excluded.add(table);
        }
        continue;
      }
      throw e;
    }
  }

  // ── Pass 1: compile everything (dependencies first). A compile failure is
  // recorded and the table drops out of the DDL plan; its dependents still
  // compile against the projected columns, so one bad definition never takes
  // the whole chain down at this stage.
  const compiledByName = new Map<string, CompiledComputedTable>();
  for (const name of order) {
    const def = defs[name];
    if (!def) continue;
    try {
      const compiled = compileComputedTable(name, def, schema, opts.dialect, opts.cloud);
      compiledByName.set(name, compiled);
      // Later computed tables may use this one as their base.
      schema.set(name, {
        columns: new Set(compiled.columns),
        relations: {},
        primaryKey: ['id'],
        hasDeletedAt: false,
        fieldTypes: compiled.fieldTypes,
      });
    } catch (e) {
      await recordFailure(name, e);
    }
  }

  // ── DDL plan: which views must be (re)created this open, expanded to every
  // transitive dependent of a changed table (their views go down with the
  // base's drop, so they must be recreated even when their own hash is
  // unchanged). `applied` is consulted again in pass 2 to decide migrate
  // (record the new version) vs direct CREATE (version already recorded).
  const needsDdl = new Set<string>();
  let applied = new Set<string>();
  if (!introspectOnly) {
    if (opts.dialect === 'sqlite' || opts.directDdl === true) {
      // Unconditional recreate: SQLite view DDL is cheap (and SQLite always
      // takes this path); the runtime ops path takes it on Postgres too — see
      // {@link RegisterComputedTablesOptions.directDdl}.
      for (const name of compiledByName.keys()) needsDdl.add(name);
    } else {
      applied = await appliedMigrationVersions(
        host.adapter,
        [...compiledByName.entries()].map(([n, c]) => migrationVersion(n, c)),
      );
      for (const [name, compiled] of compiledByName) {
        if (!applied.has(migrationVersion(name, compiled))) needsDdl.add(name);
      }
      // Dependent closure over base edges within this batch.
      for (;;) {
        let grew = false;
        for (const name of compiledByName.keys()) {
          const base = defs[name]?.base;
          if (base !== undefined && !needsDdl.has(name) && needsDdl.has(base)) {
            needsDdl.add(name);
            grew = true;
          }
        }
        if (!grew) break;
      }
    }

    // ── Drop phase: dependents before bases, so Postgres never refuses a
    // base's DROP over a dependent view. A failed drop (e.g. a user-created
    // view we don't manage still depends on it) is recorded for THAT table,
    // which then drops out of the create phase — never aborting the rest.
    for (const name of [...order].reverse()) {
      if (!needsDdl.has(name)) continue;
      try {
        await runAsyncOrSync(host.adapter, `DROP VIEW IF EXISTS ${q(name)}`);
      } catch (e) {
        await recordFailure(name, e);
        needsDdl.delete(name);
        compiledByName.delete(name);
      }
    }
  }

  // ── Pass 2a: create the views (per the plan), per table in topological order,
  // each fault-isolated. A create failure is recorded for THAT table and drops it
  // from the register phase; the rest continue.
  const clearedErrors: string[] = [];
  const toRegister: string[] = []; // survived DDL, still in topological order
  for (const name of order) {
    const def = defs[name];
    const compiled = compiledByName.get(name);
    if (!def || !compiled) continue;
    if (!introspectOnly && needsDdl.has(name)) {
      try {
        if (
          opts.dialect === 'sqlite' ||
          opts.directDdl === true ||
          applied.has(migrationVersion(name, compiled))
        ) {
          // Direct CREATE: the drop phase already ran. The `applied` branch is
          // a dependent dropped by the plan whose own hash is unchanged — its
          // migration version is already recorded, so a migrate would SKIP the
          // CREATE and leave the view missing.
          await runAsyncOrSync(
            host.adapter,
            `CREATE VIEW ${q(compiled.viewName)} AS\n${compiled.selectSql}`,
          );
        } else {
          // Changed definition: run + record the content-hash migration (its
          // embedded DROP is a no-op — the drop phase already ran).
          await host.migrate([
            { version: migrationVersion(name, compiled), sql: compiled.createSql },
          ]);
        }
      } catch (e) {
        await recordFailure(name, e);
        continue;
      }
    }
    toRegister.push(name);
  }

  // ── Pass 2b: introspect EVERY surviving view's columns in as few round-trips
  // as the host allows (one batched information_schema query on the cloud path),
  // instead of one serial introspect per table.
  const introspected = await introspectComputedColumns(
    host,
    toRegister.map((n) => compiledByName.get(n)?.viewName ?? n),
  );

  // ── Pass 2c: register — per table in topological order, each fault-isolated.
  for (const name of toRegister) {
    const def = defs[name];
    const compiled = compiledByName.get(name);
    if (!def || !compiled) continue;
    try {
      const cols = introspected.get(compiled.viewName) ?? [];
      if (cols.length === 0) {
        if (introspectOnly) {
          // The member's role can't see this view (grants are issued by the
          // owner-side ops layer) — skip without failing the open.
          result.skipped.push(name);
          continue;
        }
        throw err(name, `view was created but could not be introspected`);
      }

      host.register(
        name,
        {
          columns: Object.fromEntries(cols.map((c) => [c, 'TEXT'])),
          fieldTypes: compiled.fieldTypes,
          render: () => '',
          ...(def.description !== undefined ? { description: def.description } : {}),
        },
        cols,
      );

      result.compiled.set(name, compiled);
      result.registered.push(name);
      if (!introspectOnly && erroredBefore.has(name)) clearedErrors.push(name);
    } catch (e) {
      await recordFailure(name, e);
    }
  }

  if (!introspectOnly) {
    // Clear prior registration errors for every table that succeeded — one
    // batched DELETE, and only when something was actually recorded.
    if (clearedErrors.length > 0) {
      await runAsyncOrSync(
        host.adapter,
        `DELETE FROM "${COMPUTED_STATE_TABLE}" WHERE "field" = '*' AND "table_name" IN (${clearedErrors
          .map(() => '?')
          .join(', ')})`,
        clearedErrors,
      );
    }
    // Definition-hash invalidation: purge materialized AI values whose stored
    // prompt_hash no longer matches the (possibly config-edited) definition.
    await purgeStaleAiFields(
      host.adapter,
      result.registered.flatMap((n) => result.compiled.get(n)?.aiFields ?? []),
    );
  }

  return result;
}
