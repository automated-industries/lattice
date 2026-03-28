import type { Row, Filter } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { EntityFileSource, SourceQueryOptions, OrderBySpec } from '../schema/entity-context.js';

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
  if (opts.softDelete && !filters.some(f => f.col === 'deleted_at')) {
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
      const clauses = (opts.orderBy as OrderBySpec[])
        .filter(spec => SAFE_COL_RE.test(spec.col))
        .map(spec => `${prefix}"${spec.col}" ${spec.dir === 'desc' ? 'DESC' : 'ASC'}`);
      if (clauses.length > 0) {
        sql += ` ORDER BY ${clauses.join(', ')}`;
      }
    }
  }

  if (opts.limit !== undefined && opts.limit > 0) {
    sql += ` LIMIT ${Math.floor(opts.limit)}`;
  }

  return sql;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an {@link EntityFileSource} to rows for a given entity row.
 *
 * All queries use the synchronous better-sqlite3 adapter — no async required.
 *
 * @param source     - The source descriptor from an {@link EntityFileSpec}
 * @param entityRow  - The anchor entity row being rendered
 * @param entityPk   - The primary key column name for the entity's table
 * @param adapter    - The raw storage adapter for direct SQL access
 */
export function resolveEntitySource(
  source: EntityFileSource,
  entityRow: Row,
  entityPk: string,
  adapter: StorageAdapter,
): Row[] {
  switch (source.type) {
    case 'self':
      return [entityRow];

    case 'hasMany': {
      const ref = source.references ?? entityPk;
      const pkVal = entityRow[ref];
      const params: unknown[] = [pkVal];
      let sql = `SELECT * FROM "${source.table}" WHERE "${source.foreignKey}" = ?`;
      sql = appendQueryOptions(sql, params, source);
      return adapter.all(sql, params);
    }

    case 'manyToMany': {
      const pkVal = entityRow[entityPk];
      const remotePk = source.references ?? 'id';
      const params: unknown[] = [pkVal];

      // Build SELECT clause with optional junction columns
      let selectCols = 'r.*';
      if (source.junctionColumns?.length) {
        const jCols = source.junctionColumns.map(jc => {
          if (typeof jc === 'string') {
            if (!SAFE_COL_RE.test(jc)) return null;
            return `j."${jc}"`;
          }
          if (!SAFE_COL_RE.test(jc.col) || !SAFE_COL_RE.test(jc.as)) return null;
          return `j."${jc.col}" AS "${jc.as}"`;
        }).filter(Boolean);
        if (jCols.length > 0) selectCols += ', ' + jCols.join(', ');
      }

      let sql = `SELECT ${selectCols} FROM "${source.remoteTable}" r
         JOIN "${source.junctionTable}" j ON j."${source.remoteKey}" = r."${remotePk}"
         WHERE j."${source.localKey}" = ?`;
      sql = appendQueryOptions(sql, params, source, 'r');
      return adapter.all(sql, params);
    }

    case 'belongsTo': {
      const fkVal = entityRow[source.foreignKey];
      if (fkVal == null) return [];
      const hasOptions = source.filters?.length || source.softDelete || source.orderBy || source.limit;
      if (!hasOptions) {
        // Fast path: simple get (preserves v0.5 adapter.get() contract)
        const related = adapter.get(
          `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`,
          [fkVal],
        );
        return related ? [related] : [];
      }
      const params: unknown[] = [fkVal];
      let sql = `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`;
      sql = appendQueryOptions(sql, params, source);
      const rows = adapter.all(sql, params);
      return rows.length > 0 ? [rows[0]!] : [];
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
          // Resolve using the same logic as top-level sources
          const resolved = resolveEntitySource(lookup, entityRow, entityPk, adapter);
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
