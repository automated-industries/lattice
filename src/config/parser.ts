import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import type {
  LatticeConfig,
  LatticeEntityDef,
  LatticeFieldDef,
  LatticeEntityContextDef,
  LatticeEntityContextSourceDef,
} from './types.js';
import type {
  TableDefinition,
  RenderSpec,
  BelongsToRelation,
  BuiltinTemplateName,
  Row,
} from '../types.js';
import type {
  EntityContextDefinition,
  EntityFileSource,
} from '../schema/entity-context.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Output of a successful config parse — ready to hand to Lattice. */
export interface ParsedConfig {
  /** Absolute path to the SQLite database file */
  dbPath: string;
  /** Table definitions in declaration order */
  tables: readonly { name: string; definition: TableDefinition }[];
  /** Entity context definitions in declaration order */
  entityContexts: readonly { table: string; definition: EntityContextDefinition }[];
}

/**
 * Read, parse, and validate a `lattice.config.yml` file.
 *
 * Paths inside the config (e.g. `db`, `outputFile`) are resolved relative to
 * the config file's directory.
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
 * `configDir` is used to resolve relative `db` and `outputFile` paths.
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
  const dbPath = resolve(configDir, config.db);

  const tables: { name: string; definition: TableDefinition }[] = [];
  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    const definition = entityToTableDef(entityName, entityDef, configDir);
    tables.push({ name: entityName, definition });
  }

  const entityContexts = parseEntityContexts(config.entityContexts);

  return { dbPath, tables, entityContexts };
}

function entityToTableDef(
  entityName: string,
  entity: LatticeEntityDef,
  configDir: string,
): TableDefinition {
  const rawFields = (entity as { fields?: unknown }).fields;
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    throw new Error(`Lattice: entity "${entityName}" must have a "fields" object`);
  }

  const columns: Record<string, string> = {};
  const relations: Record<string, BelongsToRelation> = {};
  let pkFromField: string | undefined;

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    columns[fieldName] = fieldToSqliteSpec(field);

    if (field.primaryKey) {
      pkFromField = fieldName;
    }

    if (field.ref) {
      // Derive relation name: strip trailing `_id` from the field name.
      const relName = fieldName.endsWith('_id') ? fieldName.slice(0, -3) : fieldName;
      relations[relName] = {
        type: 'belongsTo',
        table: field.ref,
        foreignKey: fieldName,
      };
    }
  }

  // Entity-level primaryKey overrides field-level detection
  const primaryKey: string | string[] | undefined = entity.primaryKey ?? pkFromField;

  const render = parseEntityRender(entity.render);

  // outputFile is resolved relative to configDir at runtime
  const outputFile = resolve(configDir, entity.outputFile);

  return {
    columns,
    render,
    outputFile,
    ...(primaryKey !== undefined ? { primaryKey } : {}),
    ...(Object.keys(relations).length > 0 ? { relations } : {}),
  };
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
          .map((row) =>
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
