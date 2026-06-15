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
} from './types.js';
import type {
  TableDefinition,
  RenderSpec,
  BelongsToRelation,
  BuiltinTemplateName,
  Row,
} from '../types.js';
import type { EntityContextDefinition, EntityFileSource } from '../schema/entity-context.js';

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

  return name !== undefined
    ? { dbPath, name, tables, entityContexts }
    : { dbPath, tables, entityContexts };
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

// One-to-many `ref:` fields are deprecated in favor of many-to-many junction
// tables (removed in 2.0). Warn once per unique entity.field per process so a
// repeatedly-parsed config (every openConfig / re-render) doesn't spam.
const warnedDeprecatedRefs = new Set<string>();
function warnDeprecatedRef(entity: string, field: string, target: string): void {
  const key = `${entity}.${field}`;
  if (warnedDeprecatedRefs.has(key)) return;
  warnedDeprecatedRefs.add(key);
  console.warn(
    `Lattice: one-to-many \`ref:\` on "${entity}.${field}" → "${target}" is deprecated ` +
      `in favor of many-to-many junction tables and will be removed in 2.0.`,
  );
}

function entityToTableDef(entityName: string, entity: LatticeEntityDef): TableDefinition {
  const rawFields = (entity as { fields?: unknown }).fields;
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    throw new Error(`Lattice: entity "${entityName}" must have a "fields" object`);
  }

  const columns: Record<string, string> = {};
  const fieldTypes: Record<string, string> = {};
  const columnAudience: Record<string, string> = {};
  const relations: Record<string, BelongsToRelation> = {};
  let pkFromField: string | undefined;

  for (const [fieldName, field] of Object.entries(entity.fields)) {
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

    if (field.ref) {
      // Derive relation name: strip trailing `_id` from the field name.
      const relName = fieldName.endsWith('_id') ? fieldName.slice(0, -3) : fieldName;
      relations[relName] = {
        type: 'belongsTo',
        table: field.ref,
        foreignKey: fieldName,
      };
      warnDeprecatedRef(entityName, fieldName, field.ref);
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
