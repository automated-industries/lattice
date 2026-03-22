import type {
  Row,
  TableDefinition,
  RenderHooks,
  BuiltinTemplateName,
  RenderSpec,
} from '../types.js';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import { interpolate } from './interpolate.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compile a `RenderSpec` into a plain `(rows: Row[]) => string` function.
 *
 * Called at `define()`-time. The returned closure captures references to
 * `schema` and `adapter` which are used lazily at render-time (after `init()`).
 *
 * - If `render` is already a function, it is returned as-is (with `beforeRender`
 *   applied if hooks are present on the spec).
 * - If `render` is a `BuiltinTemplateName` string or `TemplateRenderSpec`, the
 *   corresponding built-in template is compiled.
 */
export function compileRender(
  def: TableDefinition,
  tableName: string,
  schema: SchemaManager,
  adapter: StorageAdapter,
): (rows: Row[]) => string {
  const { renderFn, templateName, hooks } = _normalizeSpec(def.render);

  if (renderFn) {
    // Plain function — wrap with beforeRender hook if present
    if (hooks?.beforeRender) {
      const bh = hooks.beforeRender;
      return (rows: Row[]) => renderFn(bh(rows));
    }
    return renderFn;
  }

  // Built-in template
  return (rows: Row[]) => {
    const processed = hooks?.beforeRender ? hooks.beforeRender(rows) : rows;
    const enriched = processed.map((row) => _enrichRow(row, def, schema, adapter));

    switch (templateName) {
      case 'default-list':
        return _renderList(enriched, hooks?.formatRow);

      case 'default-table':
        return _renderTable(enriched);

      case 'default-detail':
        return _renderDetail(enriched, tableName, schema, hooks?.formatRow);

      case 'default-json':
        return JSON.stringify(processed, null, 2);

      default:
        return '';
    }
  };
}

// ---------------------------------------------------------------------------
// Internal — spec normalisation
// ---------------------------------------------------------------------------

interface _NormalizedSpec {
  renderFn?: (rows: Row[]) => string;
  templateName?: BuiltinTemplateName;
  hooks?: RenderHooks | undefined;
}

function _normalizeSpec(render: RenderSpec): _NormalizedSpec {
  if (typeof render === 'function') {
    return { renderFn: render };
  }
  if (typeof render === 'string') {
    return { templateName: render };
  }
  const spec = render;
  return { templateName: spec.template, hooks: spec.hooks };
}

// ---------------------------------------------------------------------------
// Internal — belongsTo enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a row with resolved `belongsTo` relation data so that `{{rel.field}}`
 * interpolation works.  `hasMany` relations are skipped (v0.3).
 *
 * The enriched property name is the relation key (e.g. `'author'`), and its
 * value is the full related row object.  Errors (missing table, bad FK) are
 * swallowed silently so rendering never throws.
 */
function _enrichRow(
  row: Row,
  def: TableDefinition,
  schema: SchemaManager,
  adapter: StorageAdapter,
): Row {
  if (!def.relations) return row;

  const enriched: Row = { ...row };

  for (const [relName, rel] of Object.entries(def.relations)) {
    if (rel.type !== 'belongsTo') continue;

    const fkValue = row[rel.foreignKey];
    if (fkValue == null) continue;

    try {
      const refCol = rel.references ?? schema.getPrimaryKey(rel.table)[0] ?? 'id';
      const relRow = adapter.get(
        `SELECT * FROM "${rel.table}" WHERE "${refCol}" = ?`,
        [fkValue],
      );
      if (relRow) {
        enriched[relName] = relRow;
      }
    } catch {
      // Related table not available — skip enrichment for this relation
    }
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Internal — built-in renderers
// ---------------------------------------------------------------------------

function _applyFormatRow(
  row: Row,
  formatRow: ((row: Row) => string) | string | undefined,
): string {
  if (formatRow == null) {
    return Object.entries(row)
      .map(([k, v]) => `${k}: ${v == null ? '' : String(v as string | number | boolean)}`)
      .join(', ');
  }
  if (typeof formatRow === 'function') return formatRow(row);
  return interpolate(formatRow, row);
}

/** One bullet point per row: `- <formatted content>` */
function _renderList(
  rows: Row[],
  formatRow: ((row: Row) => string) | string | undefined,
): string {
  if (rows.length === 0) return '';
  return rows.map((row) => `- ${_applyFormatRow(row, formatRow)}`).join('\n');
}

/** GitHub-flavoured Markdown table */
function _renderTable(rows: Row[]): string {
  if (rows.length === 0) return '';
  const firstRow = rows[0];
  if (!firstRow) return '';
  const headers = Object.keys(firstRow);
  const headerRow = `| ${headers.join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyRows = rows
    .map((row) => `| ${headers.map((h) => { const v = row[h]; return v == null ? '' : String(v as string | number | boolean); }).join(' | ')} |`)
    .join('\n');
  return [headerRow, separatorRow, bodyRows].join('\n');
}

/**
 * One Markdown section per row.
 *
 * The section heading is the PK value(s) joined by `:`.
 * The section body is either the output of `formatRow` or a `key: value`
 * listing of all columns.
 *
 * Sections are separated by `---`.
 */
function _renderDetail(
  rows: Row[],
  tableName: string,
  schema: SchemaManager,
  formatRow: ((row: Row) => string) | string | undefined,
): string {
  if (rows.length === 0) return '';
  const pkCols = schema.getPrimaryKey(tableName);

  return rows
    .map((row) => {
      const pkVal = pkCols.map((col) => { const v = row[col]; return v == null ? '' : String(v as string | number | boolean); }).join(':');
      const heading = `## ${pkVal}`;

      let body: string;
      if (formatRow != null) {
        body =
          typeof formatRow === 'function'
            ? formatRow(row)
            : interpolate(formatRow, row);
      } else {
        body = Object.entries(row)
          .map(([k, v]) => `${k}: ${v == null ? '' : String(v as string | number | boolean)}`)
          .join('\n');
      }

      return `${heading}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}
