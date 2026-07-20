import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { getDbCredential } from '../framework/user-config.js';
import type {
  LatticeConfig,
  LatticeEntityDef,
  LatticeFieldDef,
  LatticeEntityContextDef,
  LatticeEntityContextSourceDef,
  ComputedTableDef,
  ComputedFieldDef,
  LatticeFieldType,
} from './types.js';
import type {
  TableDefinition,
  RenderSpec,
  BelongsToRelation,
  BuiltinTemplateName,
  Row,
} from '../types.js';
import type { EntityContextDefinition, EntityFileSource } from '../schema/entity-context.js';
import { assertExternalIdentifier } from '../schema/identifier.js';
import {
  compileComputedTable,
  computedTableOrder,
  ComputedTableCycleError,
} from '../schema/computed-table.js';
import type { ComputedSchemaTable } from '../schema/computed-table.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Output of a successful config parse — ready to hand to Lattice. */
export interface ParsedConfig {
  /** Absolute path to the SQLite database file */
  dbPath: string;
  /**
   * Optional friendly display name for the database. Surfaces in the
   * GUI's database switcher and Database Settings page. When absent,
   * callers fall back to the basename of the config file.
   */
  name?: string;
  /** Table definitions in declaration order */
  tables: readonly { name: string; definition: TableDefinition }[];
  /** Entity context definitions in declaration order */
  entityContexts: readonly { table: string; definition: EntityContextDefinition }[];
  /** Computed-table (read-only SQL projection) definitions in declaration order */
  computedTables: readonly { name: string; definition: ComputedTableDef }[];
}

/**
 * Read, parse, and validate a `lattice.config.yml` file.
 *
 * The `db` path is resolved relative to the config file's directory.
 * `outputFile` values are kept as-is (they are relative to the `outputDir`
 * passed to `render()`, not to the config file location).
 *
 * @throws If the file cannot be read, the YAML is malformed, or required
 *         keys are missing.
 */
export function parseConfigFile(configPath: string): ParsedConfig {
  const absPath = resolve(configPath);
  const configDir = dirname(absPath);

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (e) {
    throw new Error(`Lattice: cannot read config file at "${absPath}": ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new Error(`Lattice: YAML parse error in "${absPath}": ${(e as Error).message}`);
  }

  return buildParsedConfig(parsed, absPath, configDir);
}

/**
 * Parse and validate a raw YAML string as a Lattice config.
 *
 * `configDir` is used to resolve the `db` path. `outputFile` values are kept
 * as-is (relative to the `outputDir` passed to `render()`).
 * Typically this should be the directory that contains `lattice.config.yml`.
 *
 * Useful for testing without touching the filesystem.
 */
export function parseConfigString(yamlContent: string, configDir: string): ParsedConfig {
  let parsed: unknown;
  try {
    parsed = parse(yamlContent);
  } catch (e) {
    throw new Error(`Lattice: YAML parse error: ${(e as Error).message}`);
  }
  return buildParsedConfig(parsed, '<string>', configDir);
}

// ---------------------------------------------------------------------------
// Internal — validation + conversion
// ---------------------------------------------------------------------------

function buildParsedConfig(raw: unknown, sourceName: string, configDir: string): ParsedConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Lattice: config "${sourceName}" must be a YAML object with "db" and "entities" keys`,
    );
  }

  const cfg = raw as Record<string, unknown>;

  if (typeof cfg.db !== 'string') {
    throw new Error(`Lattice: config.db must be a string path (got ${typeof cfg.db})`);
  }
  if (!cfg.entities || typeof cfg.entities !== 'object' || Array.isArray(cfg.entities)) {
    throw new Error(`Lattice: config.entities must be an object`);
  }

  const config = raw as LatticeConfig;
  const dbPath = resolveDbPath(config.db, configDir);
  // Optional `name:` key — friendly DB name used by the GUI. Silently
  // ignored when not a non-empty string so older configs keep parsing.
  const name =
    typeof cfg.name === 'string' && cfg.name.trim().length > 0 ? cfg.name.trim() : undefined;

  const tables: { name: string; definition: TableDefinition }[] = [];
  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    const definition = entityToTableDef(entityName, entityDef);
    tables.push({ name: entityName, definition });
  }

  const entityContexts = parseEntityContexts(config.entityContexts);

  const computedTables = parseComputedTables(cfg.computed, tables);

  return name !== undefined
    ? { dbPath, name, tables, entityContexts, computedTables }
    : { dbPath, tables, entityContexts, computedTables };
}

/**
 * Resolve the `db:` field from a config file. Supports:
 *
 *   - `${LATTICE_DB:<label>}` — look up the connection URL stored under
 *     `<label>` in `~/.lattice/db-credentials.enc`. Throws if absent.
 *   - `postgres://...` / `postgresql://...` — passed through verbatim.
 *   - `file:...` / `:memory:` — passed through verbatim (the SQLite
 *     adapter strips the `file:` prefix itself).
 *   - any other plain path — resolved relative to the config file
 *     directory (current behaviour).
 *
 * Keeps connection passwords out of the YAML file: the GUI's DB-config
 * panel writes the URL to db-credentials.enc and replaces the YAML's
 * `db:` line with the label reference, so VCS-tracked configs don't
 * leak secrets.
 */
/** Loose detector: does this value even look like a `${LATTICE_DB:…}` reference?
 *  Used so a SHAPED-but-malformed reference is rejected loudly instead of being
 *  silently treated as a filesystem path (the empty-local-DB class of bug). */
export function isDbRefShaped(raw: string): boolean {
  return /^\s*\$\{LATTICE_DB:/.test(raw);
}
/** Strict parse of a `${LATTICE_DB:<label>}` reference (the single source of the
 *  label charset). Returns null when not strictly valid. */
export function parseDbRef(raw: string): { label: string } | null {
  const m = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(raw.trim());
  return m ? { label: m[1] ?? '' } : null;
}

export function resolveDbPath(raw: string, configDir: string): string {
  if (isDbRefShaped(raw)) {
    const ref = parseDbRef(raw);
    if (!ref) {
      // Shaped like a ${LATTICE_DB:…} reference but the label is invalid (e.g. it
      // contains a space). Throw — do NOT fall through to path resolution, which
      // would create a literal `${LATTICE_DB:…}` file (and on Windows the `:`
      // truncates it to a 0-byte file → a silent empty local DB, no error).
      throw new Error(
        `Lattice: malformed \${LATTICE_DB:…} reference ${JSON.stringify(
          raw.trim(),
        )} — the label may contain only [A-Za-z0-9._-] (no spaces). This usually means a workspace was created with an unsanitized name.`,
      );
    }
    const url = getDbCredential(ref.label);
    if (!url) {
      throw new Error(
        `Lattice: config references \${LATTICE_DB:${ref.label}} but no credential is saved for "${ref.label}". Save one via the GUI's Database panel or set LATTICE_DB_${ref.label}.`,
      );
    }
    return url;
  }
  if (/^postgres(ql)?:\/\//i.test(raw) || raw.startsWith('file:') || raw === ':memory:') {
    return raw;
  }
  // Belt-and-suspenders: an unexpanded `${…}` is never a real path — refuse it
  // rather than materializing a junk file.
  if (raw.includes('${')) {
    throw new Error(
      `Lattice: refusing to treat ${JSON.stringify(
        raw.trim(),
      )} as a database path — it looks like a malformed variable reference, not a file path.`,
    );
  }
  return resolve(configDir, raw);
}

function entityToTableDef(entityName: string, entity: LatticeEntityDef): TableDefinition {
  const rawFields = (entity as { fields?: unknown }).fields;
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    throw new Error(`Lattice: entity "${entityName}" must have a "fields" object`);
  }

  const columns: Record<string, string> = {};
  const fieldTypes: Record<string, string> = {};
  const columnAudience: Record<string, string> = {};
  const computedFields: Record<string, ComputedFieldDef> = {};
  const relations: Record<string, BelongsToRelation> = {};
  let pkFromField: string | undefined;

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    // Backwards-compat: the 3.x per-field `ref:` shorthand is still accepted and
    // converted to a `belongsTo` in-memory (relation name = field name with a
    // trailing `_id` stripped), so an existing 3.0+ config keeps opening. This is
    // SILENT — the GUI's open-time heal (see config-upgrade) rewrites the on-disk
    // YAML to the explicit `relations:` form so configs migrate forward; a future
    // major may then drop this conversion. An explicit `relations:` entry below
    // takes precedence over a shorthand-derived one on a name collision.
    if (typeof field.ref === 'string' && field.ref.length > 0) {
      const relName = fieldName.endsWith('_id') ? fieldName.slice(0, -3) : fieldName;
      relations[relName] = { type: 'belongsTo', table: field.ref, foreignKey: fieldName };
    }

    columns[fieldName] = fieldToSqliteSpec(field);
    // Retain the canonical field type so the GUI can display it instead of the
    // lossy SQL spec (e.g. show `datetime`, not `TEXT NOT NULL DEFAULT …`).
    fieldTypes[fieldName] = field.type;

    // Per-column audience (Stage-0 scaffolding). Only record an explicit value;
    // an omitted audience means "row-audience" (today's behavior) and is left
    // out of the map so it stays empty for every existing schema.
    if (typeof field.audience === 'string' && field.audience.trim()) {
      columnAudience[fieldName] = field.audience.trim();
    }

    if (field.primaryKey) {
      pkFromField = fieldName;
    }

    // A computed field carries `computed:` — a serializable derivation spec (alias /
    // calc / ai_classify / ai_transform / aggregate). Validate it with the SAME
    // validator the retired computed-table path used (one validator, both paths) and
    // collect it for the recompute engine. The physical column is still a normal
    // column (its `type:` above); `computed` only marks it as derived.
    const rawComputed = (field as { computed?: unknown }).computed;
    if (rawComputed !== undefined) {
      computedFields[fieldName] = narrowComputedField(entityName, fieldName, rawComputed);
    }
  }

  // Explicit entity-level `relations:` block — the supported replacement for
  // the removed per-field `ref:` shorthand. Each entry is a `belongsTo`
  // relation declaring a foreign key on THIS entity. Validate loudly: a
  // malformed entry must fail to parse rather than silently produce no
  // relation (which would, e.g., let a junction table escape detection).
  const rawRelations = (entity as { relations?: unknown }).relations;
  if (rawRelations !== undefined) {
    if (typeof rawRelations !== 'object' || rawRelations === null || Array.isArray(rawRelations)) {
      throw new Error(
        `Lattice: entity "${entityName}" has a "relations" value that must be an object mapping ` +
          `relation names to belongsTo specs (got ${
            Array.isArray(rawRelations) ? 'array' : typeof rawRelations
          }).`,
      );
    }
    for (const [relName, relRaw] of Object.entries(rawRelations as Record<string, unknown>)) {
      if (typeof relRaw !== 'object' || relRaw === null || Array.isArray(relRaw)) {
        throw new Error(
          `Lattice: relation "${entityName}.${relName}" must be an object ` +
            `{ type: belongsTo, table, foreignKey, references? }.`,
        );
      }
      const rel = relRaw as Record<string, unknown>;
      if (rel.type !== 'belongsTo') {
        throw new Error(
          `Lattice: relation "${entityName}.${relName}" must have type "belongsTo" (got ${
            typeof rel.type === 'string' ? `"${rel.type}"` : typeof rel.type
          }). Only belongsTo relations are declared in config; other relations are derived.`,
        );
      }
      if (typeof rel.table !== 'string' || rel.table.trim().length === 0) {
        throw new Error(
          `Lattice: relation "${entityName}.${relName}" must name a non-empty "table".`,
        );
      }
      if (typeof rel.foreignKey !== 'string' || rel.foreignKey.trim().length === 0) {
        throw new Error(
          `Lattice: relation "${entityName}.${relName}" must name a non-empty "foreignKey".`,
        );
      }
      if (
        rel.references !== undefined &&
        (typeof rel.references !== 'string' || rel.references.trim().length === 0)
      ) {
        throw new Error(
          `Lattice: relation "${entityName}.${relName}" has an invalid "references" — it must be ` +
            `a non-empty column name when present.`,
        );
      }
      relations[relName] = {
        type: 'belongsTo',
        table: rel.table,
        foreignKey: rel.foreignKey,
        ...(rel.references !== undefined ? { references: rel.references } : {}),
      };
    }
  }

  // Entity-level primaryKey overrides field-level detection
  const primaryKey: string | string[] | undefined = entity.primaryKey ?? pkFromField;

  const render = parseEntityRender(entity.render);

  // outputFile is kept as-is (relative to the outputDir passed to render()).
  // Do NOT resolve it against configDir here — path.join(outputDir, relativeFile)
  // in the render engine produces the correct path. Resolving here would create
  // an absolute path that, when joined with outputDir, produces a doubled path
  // like /outputDir/configDir/relative instead of /outputDir/relative.
  const outputFile = entity.outputFile;

  const rawDescription = (entity as { description?: unknown }).description;
  const description =
    typeof rawDescription === 'string' && rawDescription.trim() ? rawDescription.trim() : undefined;

  return {
    columns,
    render,
    outputFile,
    ...(Object.keys(fieldTypes).length > 0 ? { fieldTypes } : {}),
    ...(Object.keys(columnAudience).length > 0 ? { columnAudience } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(primaryKey !== undefined ? { primaryKey } : {}),
    ...(Object.keys(relations).length > 0 ? { relations } : {}),
    ...(Object.keys(computedFields).length > 0 ? { computedFields } : {}),
  };
}

// ---------------------------------------------------------------------------
// Computed tables (`computed:` section)
// ---------------------------------------------------------------------------

const COMPUTED_FIELD_KINDS = ['alias', 'calc', 'ai_classify', 'ai_transform', 'aggregate'] as const;

const AGGREGATE_FNS = new Set(['count', 'sum', 'avg', 'min', 'max', 'concat']);

const FIELD_TYPE_NAMES: ReadonlySet<string> = new Set([
  'uuid',
  'text',
  'integer',
  'int',
  'real',
  'float',
  'boolean',
  'bool',
  'datetime',
  'date',
  'blob',
]);

/** Build the compiler's table lookup from the parsed entity definitions. */
function computedSchemaFromTables(
  tables: readonly { name: string; definition: TableDefinition }[],
): Map<string, ComputedSchemaTable> {
  const schema = new Map<string, ComputedSchemaTable>();
  for (const { name, definition } of tables) {
    const columns = new Set(Object.keys(definition.columns));
    const relations: Record<string, BelongsToRelation> = {};
    for (const [relName, rel] of Object.entries(definition.relations ?? {})) {
      if (rel.type === 'belongsTo') relations[relName] = rel;
    }
    const pk = definition.primaryKey;
    const primaryKey = pk === undefined ? ['id'] : Array.isArray(pk) ? pk : [pk];
    schema.set(name, {
      columns,
      relations,
      primaryKey,
      hasDeletedAt: columns.has('deleted_at'),
      ...(definition.fieldTypes ? { fieldTypes: definition.fieldTypes } : {}),
    });
  }
  return schema;
}

/**
 * Parse + validate the `computed:` section. Validation is LOUD and happens at
 * parse time — the same failure contract as a malformed relation: names must
 * pass the external-identifier grammar (reserved `__lattice_` prefixes
 * rejected) and not collide with entities; every field kind and shape is
 * checked; then each definition is compiled (in topological base order, with
 * cycle detection) against the declared entities, so unresolved references,
 * malformed expressions, and bad aggregate specs all throw here.
 *
 * Scope of the parse-time check: STRUCTURE (references, expression grammar,
 * aggregate shape), not dialect semantics. Parse compiles for one dialect and
 * never executes DDL, so an error only the live engine can raise (e.g.
 * Postgres rejecting an expression's operand types) surfaces at OPEN instead —
 * fault-isolated there, never bricking it. See the inline note below.
 */
function parseComputedTables(
  rawComputed: unknown,
  tables: readonly { name: string; definition: TableDefinition }[],
): readonly { name: string; definition: ComputedTableDef }[] {
  if (rawComputed === undefined || rawComputed === null) return [];
  if (typeof rawComputed !== 'object' || Array.isArray(rawComputed)) {
    throw new Error(
      `Lattice: config.computed must be an object mapping computed-table names to definitions`,
    );
  }

  const entityNames = new Set(tables.map((t) => t.name));
  const defs: Record<string, ComputedTableDef> = {};
  const declared: { name: string; definition: ComputedTableDef }[] = [];

  for (const [name, rawDef] of Object.entries(rawComputed as Record<string, unknown>)) {
    assertExternalIdentifier(name, 'table');
    if (entityNames.has(name)) {
      throw new Error(`Lattice: computed table "${name}" collides with entity "${name}"`);
    }
    const definition = narrowComputedDef(name, rawDef);
    defs[name] = definition;
    declared.push({ name, definition });
  }
  if (declared.length === 0) return [];

  // Structural validation: compile every definition (dependencies first)
  // against the declared entities, reusing the compiler as the single owner of
  // reference / expression / aggregate SHAPE checks. This is deliberately NOT
  // equivalent to the open-time compile: parse compiles for the 'sqlite'
  // dialect only and never executes DDL, so a dialect-semantic failure (e.g.
  // Postgres refusing an integer column as a boolean operand in AND) passes
  // parse and surfaces at open — where it is fault-isolated per table, never
  // bricking the open. Parse is also STRICTER about columns: it sees only the
  // declared fields, while the open also sees introspected physical columns.
  // Compiled output is discarded — the real compile runs at init against the
  // live schema.
  let order: string[];
  try {
    order = computedTableOrder(defs);
  } catch (e) {
    if (e instanceof ComputedTableCycleError) throw new Error(`Lattice: ${e.message}`);
    throw e;
  }
  const schema = computedSchemaFromTables(tables);
  for (const name of order) {
    const definition = defs[name];
    if (!definition) continue;
    const compiled = compileComputedTable(name, definition, schema, 'sqlite');
    schema.set(name, {
      columns: new Set(compiled.columns),
      relations: {},
      primaryKey: ['id'],
      hasDeletedAt: false,
      fieldTypes: compiled.fieldTypes,
    });
  }

  return declared;
}

/**
 * Narrow one raw computed-table entry to a typed definition. Owns the
 * definition's SHAPE validation (kinds, required keys, model tier) for both a
 * YAML `computed:` entry and a definition arriving over the GUI's HTTP layer —
 * one validator, so the two paths can never accept different shapes.
 */
export function narrowComputedDef(name: string, raw: unknown): ComputedTableDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Lattice: computed table "${name}" must be an object { base, fields, description? }`,
    );
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.base !== 'string' || d.base.trim().length === 0) {
    throw new Error(`Lattice: computed table "${name}" must name a non-empty "base" table`);
  }
  if (d.description !== undefined && typeof d.description !== 'string') {
    throw new Error(`Lattice: computed table "${name}" has a non-string "description"`);
  }
  if (!d.fields || typeof d.fields !== 'object' || Array.isArray(d.fields)) {
    throw new Error(`Lattice: computed table "${name}" must have a "fields" object`);
  }
  const fields: Record<string, ComputedFieldDef> = {};
  for (const [fieldName, rawField] of Object.entries(d.fields as Record<string, unknown>)) {
    fields[fieldName] = narrowComputedField(name, fieldName, rawField);
  }
  return {
    base: d.base,
    fields,
    ...(d.description !== undefined ? { description: d.description } : {}),
  };
}

/** Narrow one raw YAML field entry, rejecting unknown kinds and wrong shapes. */
function narrowComputedField(table: string, field: string, raw: unknown): ComputedFieldDef {
  const where = `computed field "${table}.${field}"`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Lattice: ${where} must be an object with a "kind"`);
  }
  const f = raw as Record<string, unknown>;
  const requireString = (key: string): string => {
    const v = f[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`Lattice: ${where} must have a non-empty string "${key}"`);
    }
    return v;
  };
  const model = (): { model?: 'default' | 'cheapest' } => {
    if (f.model === undefined) return {};
    if (f.model !== 'default' && f.model !== 'cheapest') {
      throw new Error(`Lattice: ${where} has invalid model — must be "default" or "cheapest"`);
    }
    return { model: f.model };
  };

  switch (f.kind) {
    case 'alias':
      return { kind: 'alias', source: requireString('source') };
    case 'calc': {
      const expr = requireString('expr');
      if (f.type !== undefined && (typeof f.type !== 'string' || !FIELD_TYPE_NAMES.has(f.type))) {
        throw new Error(`Lattice: ${where} has invalid calc type ${JSON.stringify(f.type)}`);
      }
      return {
        kind: 'calc',
        expr,
        ...(f.type !== undefined ? { type: f.type as LatticeFieldType } : {}),
      };
    }
    case 'ai_classify': {
      const input = requireString('input');
      const prompt = requireString('prompt');
      const labels = f.labels;
      if (
        !Array.isArray(labels) ||
        labels.length === 0 ||
        labels.some((l) => typeof l !== 'string' || l.trim().length === 0)
      ) {
        throw new Error(
          `Lattice: ${where} must have "labels": a non-empty array of non-empty strings`,
        );
      }
      return { kind: 'ai_classify', input, prompt, labels: labels as string[], ...model() };
    }
    case 'ai_transform': {
      const prompt = requireString('prompt');
      const inputs = f.inputs;
      if (
        !Array.isArray(inputs) ||
        inputs.length === 0 ||
        inputs.some((i) => typeof i !== 'string' || i.trim().length === 0)
      ) {
        throw new Error(
          `Lattice: ${where} must have "inputs": a non-empty array of column references`,
        );
      }
      return { kind: 'ai_transform', inputs: inputs as string[], prompt, ...model() };
    }
    case 'aggregate': {
      const via = requireString('via');
      if (typeof f.fn !== 'string' || !AGGREGATE_FNS.has(f.fn)) {
        throw new Error(
          `Lattice: ${where} has invalid fn — must be one of count, sum, avg, min, max, concat`,
        );
      }
      if (f.column !== undefined && typeof f.column !== 'string') {
        throw new Error(`Lattice: ${where} has a non-string "column"`);
      }
      return {
        kind: 'aggregate',
        via,
        fn: f.fn as 'count' | 'sum' | 'avg' | 'min' | 'max' | 'concat',
        ...(f.column !== undefined ? { column: f.column } : {}),
      };
    }
    default:
      throw new Error(
        `Lattice: ${where} has unknown kind ${JSON.stringify(f.kind)} — must be one of ${COMPUTED_FIELD_KINDS.join(', ')}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Field → SQLite column spec
// ---------------------------------------------------------------------------

function fieldToSqliteSpec(field: LatticeFieldDef): string {
  const parts: string[] = [fieldToSqliteBaseType(field.type)];

  if (field.primaryKey) {
    parts.push('PRIMARY KEY');
  } else if (field.required) {
    parts.push('NOT NULL');
  }

  if (field.default !== undefined) {
    const dv = field.default;
    if (typeof dv === 'string') {
      // Escape single quotes in the default value
      parts.push(`DEFAULT '${dv.replace(/'/g, "''")}'`);
    } else {
      parts.push(`DEFAULT ${String(dv)}`);
    }
  }

  return parts.join(' ');
}

/**
 * Map a `LatticeFieldType` to its SQLite storage class.
 *
 * @internal Exported for codegen reuse.
 */
export function fieldToSqliteBaseType(type: LatticeFieldDef['type']): string {
  switch (type) {
    case 'uuid':
    case 'text':
    case 'datetime':
    case 'date':
      return 'TEXT';
    case 'integer':
    case 'int':
    case 'boolean':
    case 'bool':
      return 'INTEGER';
    case 'real':
    case 'float':
      return 'REAL';
    case 'blob':
      return 'BLOB';
  }
}

// ---------------------------------------------------------------------------
// Render spec parsing
// ---------------------------------------------------------------------------

function parseEntityRender(render: LatticeEntityDef['render']): RenderSpec {
  if (!render) {
    // Default: compact list, one row per line
    return 'default-list';
  }

  if (typeof render === 'string') {
    // Plain builtin name
    return render as BuiltinTemplateName;
  }

  // Object form: { template, formatRow? }
  const spec = render;
  if (spec.formatRow) {
    return {
      template: spec.template as BuiltinTemplateName,
      hooks: { formatRow: spec.formatRow },
    };
  }
  return spec.template as BuiltinTemplateName;
}

// ---------------------------------------------------------------------------
// Entity context parsing
// ---------------------------------------------------------------------------

/**
 * Build a simple render function for a builtin template name.
 * Used for entity context files where we don't have schema/adapter context.
 */
function renderFnForTemplate(templateName: string): (rows: Row[]) => string {
  switch (templateName) {
    case 'default-list':
      return (rows: Row[]) => {
        if (rows.length === 0) return '';
        return rows
          .map(
            (row) =>
              `- ${Object.entries(row)
                .map(([k, v]) => `${k}: ${v == null ? '' : String(v as string | number | boolean)}`)
                .join(', ')}`,
          )
          .join('\n');
      };
    case 'default-table':
      return (rows: Row[]) => {
        if (rows.length === 0) return '';
        const firstRow = rows[0];
        if (!firstRow) return '';
        const headers = Object.keys(firstRow);
        const headerRow = `| ${headers.join(' | ')} |`;
        const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
        const bodyRows = rows
          .map(
            (row) =>
              `| ${headers
                .map((h) => {
                  const v = row[h];
                  return v == null ? '' : String(v as string | number | boolean);
                })
                .join(' | ')} |`,
          )
          .join('\n');
        return [headerRow, separatorRow, bodyRows].join('\n');
      };
    case 'default-detail':
      return (rows: Row[]) => {
        if (rows.length === 0) return '';
        return rows
          .map((row) => {
            const body = Object.entries(row)
              .map(([k, v]) => `${k}: ${v == null ? '' : String(v as string | number | boolean)}`)
              .join('\n');
            return `## ${String((Object.values(row)[0] ?? '') as string | number | boolean)}\n\n${body}`;
          })
          .join('\n\n---\n\n');
      };
    case 'default-json':
      return (rows: Row[]) => JSON.stringify(rows, null, 2);
    default:
      return (rows: Row[]) => JSON.stringify(rows, null, 2);
  }
}

/**
 * Convert a YAML source spec to an EntityFileSource.
 */
function parseEntitySource(sourceDef: LatticeEntityContextSourceDef): EntityFileSource {
  if (sourceDef === 'self') {
    return { type: 'self' };
  }
  // Object forms already match the EntityFileSource interface
  return sourceDef as EntityFileSource;
}

/**
 * Extract the field name from a `{{fieldName}}` template string.
 * Returns the raw string if it doesn't match the template pattern.
 */
function extractSlugField(slugTemplate: string): (row: Row) => string {
  const match = /^\{\{(\w+)\}\}$/.exec(slugTemplate);
  if (match?.[1]) {
    const field = match[1];
    return (row: Row) => row[field] as string;
  }
  // Fall back to using the whole string as a literal
  return () => slugTemplate;
}

/**
 * Parse the `entityContexts` section of a YAML config into
 * `EntityContextDefinition` objects.
 */
export function parseEntityContexts(
  entityContexts: Record<string, LatticeEntityContextDef> | undefined,
): readonly { table: string; definition: EntityContextDefinition }[] {
  if (!entityContexts) return [];

  const result: { table: string; definition: EntityContextDefinition }[] = [];

  for (const [tableName, ctxDef] of Object.entries(entityContexts)) {
    const slugFn = extractSlugField(ctxDef.slug);

    const files: EntityContextDefinition['files'] = {};
    for (const [filename, fileDef] of Object.entries(ctxDef.files)) {
      files[filename] = {
        source: parseEntitySource(fileDef.source),
        render: renderFnForTemplate(fileDef.template),
        ...(fileDef.budget !== undefined ? { budget: fileDef.budget } : {}),
        ...(fileDef.omitIfEmpty !== undefined ? { omitIfEmpty: fileDef.omitIfEmpty } : {}),
      };
    }

    const definition: EntityContextDefinition = {
      slug: slugFn,
      files,
      ...(ctxDef.directoryRoot !== undefined ? { directoryRoot: ctxDef.directoryRoot } : {}),
      ...(ctxDef.protectedFiles !== undefined ? { protectedFiles: ctxDef.protectedFiles } : {}),
      ...(ctxDef.index !== undefined
        ? {
            index: {
              outputFile: ctxDef.index.outputFile,
              render: renderFnForTemplate(ctxDef.index.render),
            },
          }
        : {}),
      ...(ctxDef.combined !== undefined ? { combined: ctxDef.combined } : {}),
    };

    result.push({ table: tableName, definition });
  }

  return result;
}
