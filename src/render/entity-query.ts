import type { Row, Filter } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import type { EntityFileSource, SourceQueryOptions } from '../schema/entity-context.js';

// ---------------------------------------------------------------------------
// SQL clause builder for source query options
// ---------------------------------------------------------------------------

const SAFE_COL_RE = /^[a-zA-Z0-9_]+$/;

/**
 * Build the effective filter list from {@link SourceQueryOptions}.
 * Prepends the soft-delete filter when `softDelete` is `true` and no
 * explicit `deleted_at` filter already exists.
 */
function effectiveFilters(opts: SourceQueryOptions): Filter[] {
  const filters = opts.filters ? [...opts.filters] : [];
  if (opts.softDelete && !filters.some((f) => f.col === 'deleted_at')) {
    filters.unshift({ col: 'deleted_at', op: 'isNull' });
  }
  return filters;
}

/**
 * Append WHERE, ORDER BY, and LIMIT clauses to a base SQL string.
 * All column names are validated against `[a-zA-Z0-9_]`.
 *
 * @param baseSql  - The SELECT ... WHERE fk = ? base query
 * @param params   - Mutable parameter array — new values are pushed
 * @param opts     - Source query options
 * @param tableAlias - Optional table alias prefix for filter columns (e.g. "r")
 */
function appendQueryOptions(
  baseSql: string,
  params: unknown[],
  opts: SourceQueryOptions,
  tableAlias?: string,
): string {
  let sql = baseSql;
  const prefix = tableAlias ? `${tableAlias}.` : '';

  for (const f of effectiveFilters(opts)) {
    if (!SAFE_COL_RE.test(f.col)) continue; // skip invalid column names
    switch (f.op) {
      case 'eq':
        sql += ` AND ${prefix}"${f.col}" = ?`;
        params.push(f.val);
        break;
      case 'ne':
        sql += ` AND ${prefix}"${f.col}" != ?`;
        params.push(f.val);
        break;
      case 'gt':
        sql += ` AND ${prefix}"${f.col}" > ?`;
        params.push(f.val);
        break;
      case 'gte':
        sql += ` AND ${prefix}"${f.col}" >= ?`;
        params.push(f.val);
        break;
      case 'lt':
        sql += ` AND ${prefix}"${f.col}" < ?`;
        params.push(f.val);
        break;
      case 'lte':
        sql += ` AND ${prefix}"${f.col}" <= ?`;
        params.push(f.val);
        break;
      case 'like':
        sql += ` AND ${prefix}"${f.col}" LIKE ?`;
        params.push(f.val);
        break;
      case 'in': {
        const arr = f.val as unknown[];
        if (arr.length === 0) {
          sql += ' AND 0'; // empty IN → no matches
        } else {
          sql += ` AND ${prefix}"${f.col}" IN (${arr.map(() => '?').join(', ')})`;
          params.push(...arr);
        }
        break;
      }
      case 'isNull':
        sql += ` AND ${prefix}"${f.col}" IS NULL`;
        break;
      case 'isNotNull':
        sql += ` AND ${prefix}"${f.col}" IS NOT NULL`;
        break;
    }
  }

  if (opts.orderBy) {
    if (typeof opts.orderBy === 'string') {
      if (SAFE_COL_RE.test(opts.orderBy)) {
        const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
        sql += ` ORDER BY ${prefix}"${opts.orderBy}" ${dir}`;
      }
    } else {
      // Array form: multi-column ORDER BY
      const clauses = opts.orderBy
        .filter((spec) => SAFE_COL_RE.test(spec.col))
        .map((spec) => `${prefix}"${spec.col}" ${spec.dir === 'desc' ? 'DESC' : 'ASC'}`);
      if (clauses.length > 0) {
        sql += ` ORDER BY ${clauses.join(', ')}`;
      }
    }
  }

  if (opts.limit !== undefined && opts.limit > 0) {
    sql += ` LIMIT ${String(Math.floor(opts.limit))}`;
  }

  return sql;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/**
 * Options for protected-entity filtering during source resolution.
 */
export interface ProtectionContext {
  /** Set of table names that are marked as protected entity contexts. */
  protectedTables: ReadonlySet<string>;
  /** The table name of the entity context currently being rendered. */
  currentTable: string;
}

/**
 * Resolve an {@link EntityFileSource} to rows for a given entity row.
 *
 * Prefers the adapter's async surface when present (Postgres pool); falls
 * back to the sync adapter (SQLite). User-provided `custom.query` functions
 * remain synchronous — they're invoked directly inside the async resolver
 * and their `Row[]` result is used as-is.
 *
 * When a {@link ProtectionContext} is provided, sources that reference a
 * protected table are filtered:
 * - Same table as `currentTable`: returns only the current entity's own row.
 * - Different protected table: returns `[]` (no cross-entity cleanup).
 *
 * @param source     - The source descriptor from an {@link EntityFileSpec}
 * @param entityRow  - The anchor entity row being rendered
 * @param entityPk   - The primary key column name for the entity's table
 * @param adapter    - The raw storage adapter for direct SQL access
 * @param protection - Optional protection context for filtering
 */
export async function resolveEntitySource(
  source: EntityFileSource,
  entityRow: Row,
  entityPk: string,
  adapter: StorageAdapter,
  protection?: ProtectionContext,
): Promise<Row[]> {
  switch (source.type) {
    case 'self':
      return [entityRow];

    case 'hasMany': {
      if (protection?.protectedTables.has(source.table)) {
        if (source.table === protection.currentTable) return [entityRow];
        return [];
      }
      const ref = source.references ?? entityPk;
      const pkVal = entityRow[ref];
      const params: unknown[] = [pkVal];
      let sql = `SELECT * FROM "${source.table}" WHERE "${source.foreignKey}" = ?`;
      sql = appendQueryOptions(sql, params, source);
      return allAsyncOrSync(adapter, sql, params);
    }

    case 'manyToMany': {
      if (protection?.protectedTables.has(source.remoteTable)) {
        if (source.remoteTable === protection.currentTable) return [entityRow];
        return [];
      }
      const pkVal = entityRow[entityPk];
      const remotePk = source.references ?? 'id';
      const params: unknown[] = [pkVal];

      // Build SELECT clause with optional junction columns
      let selectCols = 'r.*';
      if (source.junctionColumns?.length) {
        const jCols = source.junctionColumns
          .map((jc) => {
            if (typeof jc === 'string') {
              if (!SAFE_COL_RE.test(jc)) return null;
              return `j."${jc}"`;
            }
            if (!SAFE_COL_RE.test(jc.col) || !SAFE_COL_RE.test(jc.as)) return null;
            return `j."${jc.col}" AS "${jc.as}"`;
          })
          .filter(Boolean);
        if (jCols.length > 0) selectCols += ', ' + jCols.join(', ');
      }

      let sql = `SELECT ${selectCols} FROM "${source.remoteTable}" r
         JOIN "${source.junctionTable}" j ON j."${source.remoteKey}" = r."${remotePk}"
         WHERE j."${source.localKey}" = ?`;
      sql = appendQueryOptions(sql, params, source, 'r');
      return allAsyncOrSync(adapter, sql, params);
    }

    case 'belongsTo': {
      if (protection?.protectedTables.has(source.table)) {
        if (source.table === protection.currentTable) return [entityRow];
        return [];
      }
      const fkVal = entityRow[source.foreignKey];
      if (fkVal == null) return [];
      const hasOptions =
        Boolean(source.filters?.length) ||
        Boolean(source.softDelete) ||
        Boolean(source.orderBy) ||
        Boolean(source.limit);
      if (!hasOptions) {
        // Fast path: simple get
        const related = await getAsyncOrSync(
          adapter,
          `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`,
          [fkVal],
        );
        return related ? [related] : [];
      }
      const params: unknown[] = [fkVal];
      let sql = `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`;
      sql = appendQueryOptions(sql, params, source);
      const rows = await allAsyncOrSync(adapter, sql, params);
      const first = rows[0];
      return first ? [first] : [];
    }

    case 'custom':
      return source.query(entityRow, adapter);

    case 'enriched': {
      const enriched: Row = { ...entityRow };
      for (const [key, lookup] of Object.entries(source.include)) {
        const fieldName = `_${key}`;
        if (lookup.type === 'custom') {
          enriched[fieldName] = JSON.stringify(lookup.query(entityRow, adapter));
        } else {
          // Resolve using the same logic as top-level sources (with protection)
          const resolved = await resolveEntitySource(
            lookup,
            entityRow,
            entityPk,
            adapter,
            protection,
          );
          enriched[fieldName] = JSON.stringify(resolved);
        }
      }
      return [enriched];
    }
  }
}

/**
 * Truncate rendered content to a character budget.
 * Appends a notice when truncation occurs so readers know the output is incomplete.
 * Returns `content` unchanged when `budget` is undefined or not exceeded.
 */
export function truncateContent(content: string, budget: number | undefined): string {
  if (budget === undefined || content.length <= budget) return content;
  return content.slice(0, budget) + '\n\n*[truncated — context budget exceeded]*';
}
