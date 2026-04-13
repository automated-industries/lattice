import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type {
  Row,
  BuiltinTemplateName,
  ReverseSeedResult,
  ReverseSeedTableResult,
  ReverseSeedDetection,
} from '../types.js';

// ---------------------------------------------------------------------------
// Built-in template parsers
// ---------------------------------------------------------------------------

/**
 * Parse a `default-table` rendered markdown table back into rows.
 *
 * Expected format:
 * ```
 * | col1 | col2 | col3 |
 * | --- | --- | --- |
 * | val1 | val2 | val3 |
 * ```
 */
function parseDefaultTable(content: string): Record<string, unknown>[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 3) return []; // need header + separator + at least one data row

  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = headerLine
    .split('|')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (headers.length === 0) return [];

  // Skip separator line (index 1)
  const rows: Record<string, unknown>[] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.includes('|')) continue;
    const values = line
      .split('|')
      .map((v) => v.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // strip empty first/last from leading/trailing |

    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const val = values[j] ?? '';
      const header = headers[j];
      if (header) row[header] = coerceValue(val);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a `default-list` rendered bullet list back into rows.
 *
 * Expected format (without formatRow):
 * ```
 * - key1: val1, key2: val2
 * - key1: val3, key2: val4
 * ```
 */
function parseDefaultList(content: string): Record<string, unknown>[] {
  const lines = content.split('\n').filter((l) => l.trim().startsWith('- '));
  const rows: Record<string, unknown>[] = [];

  for (const line of lines) {
    const body = line.replace(/^-\s*/, '');
    const row = parseKeyValuePairs(body);
    if (Object.keys(row).length > 0) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Parse a `default-detail` rendered section list back into rows.
 *
 * Expected format (without formatRow):
 * ```
 * ## PK_VALUE
 *
 * key1: value1
 * key2: value2
 *
 * ---
 *
 * ## PK_VALUE2
 * ...
 * ```
 */
function parseDefaultDetail(content: string): Record<string, unknown>[] {
  // Split on section dividers
  const sections = content.split(/\n\n---\n\n/);
  const rows: Record<string, unknown>[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    const row: Record<string, unknown> = {};

    for (const line of lines) {
      const trimmedLine = line.trim();
      // Skip headings — they repeat PK values already in the key-value pairs
      if (trimmedLine.startsWith('## ') || trimmedLine.length === 0) continue;

      const colonIdx = trimmedLine.indexOf(': ');
      if (colonIdx > 0) {
        const key = trimmedLine.slice(0, colonIdx);
        const val = trimmedLine.slice(colonIdx + 2);
        row[key] = coerceValue(val);
      }
    }

    if (Object.keys(row).length > 0) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Parse `default-json` rendered content back into rows.
 */
function parseDefaultJson(content: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated `key: value` string into an object.
 * Handles the format produced by `_applyFormatRow` with no formatRow hook.
 */
function parseKeyValuePairs(text: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  // Split on `, ` but be careful with values that might contain commas
  // The format is: `key: val, key: val` — keys never contain `: `
  const parts = text.split(', ');
  for (const part of parts) {
    const colonIdx = part.indexOf(': ');
    if (colonIdx > 0) {
      const key = part.slice(0, colonIdx);
      const val = part.slice(colonIdx + 2);
      row[key] = coerceValue(val);
    }
  }
  return row;
}

/** Coerce string values to appropriate JS types. */
function coerceValue(val: string): unknown {
  if (val === '') return '';
  if (val === 'null' || val === 'NULL') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  // Try number
  const num = Number(val);
  if (!isNaN(num) && val.trim() === String(num)) return num;
  return val;
}

/** Get the parser for a built-in template name. */
function getTemplateParser(
  templateName: BuiltinTemplateName,
): ((content: string) => Record<string, unknown>[]) | null {
  switch (templateName) {
    case 'default-table':
      return parseDefaultTable;
    case 'default-list':
      return parseDefaultList;
    case 'default-detail':
      return parseDefaultDetail;
    case 'default-json':
      return parseDefaultJson;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Reverse-seed engine: recovers database rows from rendered files when a
 * table is empty but files still exist on disk.
 *
 * Only activates when `count(table) === 0` and the output directory contains
 * rendered files for that table. Never overwrites existing DB data.
 */
export class ReverseSeedEngine {
  private readonly _schema: SchemaManager;
  private readonly _adapter: StorageAdapter;

  constructor(schema: SchemaManager, adapter: StorageAdapter) {
    this._schema = schema;
    this._adapter = adapter;
  }

  /**
   * Detect missing data: rendered files exist on disk but the corresponding
   * database rows are absent. Does NOT modify the database.
   *
   * - **Entity contexts**: checks each entity directory against DB rows.
   *   Returns one detection per missing entity (per-agent, per-skill granularity).
   * - **Regular tables** (no entity context): checks if the table is entirely
   *   empty while a rendered file exists. Returns one table-level detection.
   *
   * @param outputDir - Root output directory where rendered files live.
   * @returns List of missing entities/tables that need reverse-seed attention.
   */
  detect(outputDir: string): ReverseSeedDetection[] {
    const detections: ReverseSeedDetection[] = [];
    const entityContextTables = new Set<string>();

    // Check entity contexts first — per-entity granularity
    for (const [table, ecDef] of this._schema.getEntityContexts()) {
      entityContextTables.add(table);
      const tableDef = this._schema.getTables().get(table);
      if (tableDef?.reverseSeed === false) continue;

      const directoryRoot = ecDef.directoryRoot ?? table;
      const rootPath = join(outputDir, directoryRoot);
      if (!existsSync(rootPath)) continue;

      // Build set of slugs that exist in the DB
      let dbRows: Row[];
      try {
        dbRows = this._schema.queryTable(this._adapter, table);
      } catch {
        continue;
      }
      const dbSlugs = new Set(dbRows.map((row) => ecDef.slug(row)));

      // Scan directories on disk and compare
      let entries: string[];
      try {
        entries = readdirSync(rootPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const entityDir = join(rootPath, entry);
        try {
          if (!statSync(entityDir).isDirectory()) continue;
        } catch {
          continue;
        }

        // If this directory's slug has no corresponding DB row → missing entity
        if (!dbSlugs.has(entry)) {
          detections.push({ table, entity: entry, filePath: entityDir });
        }
      }
    }

    // Check regular tables (no entity context) — table-level granularity
    for (const [name, def] of this._schema.getTables()) {
      if (def.reverseSeed === false) continue;
      // Skip tables that have entity contexts — those are handled above per-entity
      if (entityContextTables.has(name)) continue;

      const countRow = this._adapter.get(`SELECT COUNT(*) AS n FROM "${name}"`);
      const count = Number(countRow?.n ?? 0);
      if (count > 0) continue;

      const filePath = join(outputDir, def.outputFile);
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, 'utf8');
        if (content.trim()) {
          detections.push({ table: name, filePath });
        }
      } catch {
        // Can't read — skip
      }
    }

    return detections;
  }

  /**
   * Check all registered tables and entity contexts for reverse-seed
   * opportunities. For each empty table with existing rendered files,
   * parse the files and insert rows.
   *
   * @param outputDir - Root output directory where rendered files live.
   * @returns Summary of what was recovered.
   */
  process(outputDir: string): ReverseSeedResult {
    const result: ReverseSeedResult = {
      tables: [],
      totalRowsRecovered: 0,
      warnings: [],
    };

    // Process regular tables
    for (const [name, def] of this._schema.getTables()) {
      // Check opt-out
      if (def.reverseSeed === false) continue;

      // Check if table is empty
      const countRow = this._adapter.get(`SELECT COUNT(*) AS n FROM "${name}"`);
      const count = Number(countRow?.n ?? 0);
      if (count > 0) continue;

      // Determine parser
      let parser: ((content: string) => Record<string, unknown>[]) | null = null;

      if (typeof def.reverseSeed === 'object') {
        parser = def.reverseSeed.parser;
      } else if (def._renderTemplateName) {
        parser = getTemplateParser(def._renderTemplateName);
      }

      if (!parser) {
        // No parser available — skip silently unless reverseSeed was explicitly true
        if (def.reverseSeed === true) {
          result.warnings.push(
            `Table "${name}": reverseSeed enabled but no parser available (custom render function without parser)`,
          );
        }
        continue;
      }

      // Check if rendered file exists
      const filePath = join(outputDir, def.outputFile);
      if (!existsSync(filePath)) continue;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        result.warnings.push(`Table "${name}": could not read file ${filePath}`);
        continue;
      }

      if (!content.trim()) continue;

      // Parse and insert
      const tableResult = this._seedFromParsedRows(name, content, parser, result.warnings);
      if (tableResult) {
        result.tables.push(tableResult);
        result.totalRowsRecovered += tableResult.rowsRecovered;
      }
    }

    // Process entity contexts — per-entity granularity.
    // Recovers individual missing entities, not just entirely empty tables.
    for (const [table, ecDef] of this._schema.getEntityContexts()) {
      const tableDef = this._schema.getTables().get(table);
      if (tableDef?.reverseSeed === false) continue;

      // Determine parser for entity contexts
      let entityParser: ((content: string) => Record<string, unknown>[]) | null = null;
      if (typeof tableDef?.reverseSeed === 'object') {
        entityParser = tableDef.reverseSeed.parser;
      }

      // Find the self-source file spec
      let selfFilename: string | null = null;
      for (const [filename, spec] of Object.entries(ecDef.files)) {
        if (spec.source.type === 'self') {
          selfFilename = filename;
          break;
        }
      }

      if (!selfFilename && !entityParser) continue;

      // Scan entity directories
      const directoryRoot = ecDef.directoryRoot ?? table;
      const rootPath = join(outputDir, directoryRoot);
      if (!existsSync(rootPath)) continue;

      let entries: string[];
      try {
        entries = readdirSync(rootPath);
      } catch {
        continue;
      }

      // Build set of existing slugs in DB to find missing entities
      let dbRows: Row[];
      try {
        dbRows = this._schema.queryTable(this._adapter, table);
      } catch {
        continue;
      }
      const dbSlugs = new Set(dbRows.map((row) => ecDef.slug(row)));

      let rowsRecovered = 0;

      this._adapter.run('BEGIN');
      try {
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const entityDir = join(rootPath, entry);
          try {
            if (!statSync(entityDir).isDirectory()) continue;
          } catch {
            continue;
          }

          // Skip entities that already exist in the DB
          if (dbSlugs.has(entry)) continue;

          const targetFile = selfFilename ?? Object.keys(ecDef.files)[0];
          if (!targetFile) continue;

          const filePath = join(entityDir, targetFile);
          if (!existsSync(filePath)) continue;

          let content: string;
          try {
            content = readFileSync(filePath, 'utf8');
          } catch {
            result.warnings.push(`Entity "${table}/${entry}": could not read ${filePath}`);
            continue;
          }

          if (!content.trim()) continue;

          let rows: Record<string, unknown>[];
          try {
            if (entityParser) {
              rows = entityParser(content);
            } else {
              rows = [parseEntityProfileContent(content)];
            }
          } catch (err) {
            result.warnings.push(
              `Entity "${table}/${entry}": parse error — ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }

          for (const row of rows) {
            if (Object.keys(row).length === 0) continue;
            const inserted = this._insertOrIgnore(table, row);
            if (inserted) rowsRecovered++;
          }
        }

        this._adapter.run('COMMIT');
      } catch (err) {
        this._adapter.run('ROLLBACK');
        result.warnings.push(
          `Entity context "${table}": transaction error — ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (rowsRecovered > 0) {
        result.tables.push({ table, rowsRecovered });
        result.totalRowsRecovered += rowsRecovered;
      }
    }

    return result;
  }

  /**
   * Parse file content and seed rows into a table.
   */
  private _seedFromParsedRows(
    table: string,
    content: string,
    parser: (content: string) => Record<string, unknown>[],
    warnings: string[],
  ): ReverseSeedTableResult | null {
    let rows: Record<string, unknown>[];
    try {
      rows = parser(content);
    } catch (err) {
      warnings.push(
        `Table "${table}": parse error — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    if (rows.length === 0) return null;

    let rowsRecovered = 0;

    this._adapter.run('BEGIN');
    try {
      for (const row of rows) {
        if (Object.keys(row).length === 0) continue;
        const inserted = this._insertOrIgnore(table, row);
        if (inserted) rowsRecovered++;
      }
      this._adapter.run('COMMIT');
    } catch (err) {
      this._adapter.run('ROLLBACK');
      warnings.push(
        `Table "${table}": insert error — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    return rowsRecovered > 0 ? { table, rowsRecovered } : null;
  }

  /**
   * Insert a row using INSERT OR IGNORE semantics.
   * Filters to valid columns and returns true if a row was actually inserted.
   */
  private _insertOrIgnore(table: string, row: Record<string, unknown>): boolean {
    // Get actual columns from the table
    const validColumns = new Set(this._adapter.introspectColumns(table));

    // Filter row to valid columns only
    const filtered: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      if (validColumns.has(key)) {
        filtered[key] = val;
      }
    }

    if (Object.keys(filtered).length === 0) return false;

    const cols = Object.keys(filtered)
      .map((c) => `"${c}"`)
      .join(', ');
    const placeholders = Object.keys(filtered)
      .map(() => '?')
      .join(', ');
    const values = Object.values(filtered);

    const before = this._adapter.get(`SELECT COUNT(*) AS n FROM "${table}"`);
    const countBefore = Number(before?.n ?? 0);

    this._adapter.run(
      `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${placeholders})`,
      values,
    );

    const after = this._adapter.get(`SELECT COUNT(*) AS n FROM "${table}"`);
    const countAfter = Number(after?.n ?? 0);

    return countAfter > countBefore;
  }
}

// ---------------------------------------------------------------------------
// Entity content parser
// ---------------------------------------------------------------------------

/**
 * Best-effort parser for entity profile content.
 * Handles markdown with headings and `key: value` lines,
 * as well as read-only headers and frontmatter.
 */
function parseEntityProfileContent(content: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, headings, dividers, read-only markers, frontmatter delimiters
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed === '---' ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('>')
    ) {
      continue;
    }

    const colonIdx = trimmed.indexOf(': ');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).replace(/^\*\*/, '').replace(/\*\*$/, '');
      const val = trimmed.slice(colonIdx + 2);
      row[key] = coerceValue(val);
    }
  }

  return row;
}

// Export parsers for testing
export { parseDefaultTable, parseDefaultList, parseDefaultDetail, parseDefaultJson };
