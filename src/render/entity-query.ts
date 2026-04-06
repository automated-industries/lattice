import type { Row, Filter } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';
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
 * All queries use the synchronous better-sqlite3 adapter — no async required.
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
export function resolveEntitySource(
  source: EntityFileSource,
  entityRow: Row,
  entityPk: string,
  adapter: StorageAdapter,
  protection?: ProtectionContext,
): Row[] {
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
      return adapter.all(sql, params);
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
      return adapter.all(sql, params);
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
          const resolved = resolveEntitySource(lookup, entityRow, entityPk, adapter, protection);
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

// ---------------------------------------------------------------------------
// Batch entity source resolution (v1.4+)
// ---------------------------------------------------------------------------

/** Maximum parameters per SQLite IN clause to stay under SQLITE_MAX_VARIABLE_NUMBER. */
const BATCH_CHUNK_SIZE = 500;

/**
 * Result of a batch prefetch. Maps `filename → entityPkValue → Row[]`.
 * Sources that cannot be batched are listed in `unbatched`.
 */
export interface BatchPrefetchResult {
  results: Map<string, Map<string, Row[]>>;
  unbatched: Set<string>;
}

/**
 * Group an array of rows by a key column, returning a Map from key value to rows.
 */
function groupBy(rows: Row[], keyCol: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const val = row[keyCol];
    const key = val != null ? String(val as string | number) : '';
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(row);
  }
  return map;
}

/**
 * Build filter + orderBy clauses from SourceQueryOptions (no LIMIT — applied post-group).
 * Returns SQL fragment starting with " AND ..." and pushes params.
 */
function buildBatchClauses(
  params: unknown[],
  opts: SourceQueryOptions,
  tableAlias?: string,
): string {
  let sql = '';
  const prefix = tableAlias ? `${tableAlias}.` : '';

  for (const f of effectiveFilters(opts)) {
    if (!SAFE_COL_RE.test(f.col)) continue;
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
          sql += ' AND 0';
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
      const clauses = opts.orderBy
        .filter((spec) => SAFE_COL_RE.test(spec.col))
        .map((spec) => `${prefix}"${spec.col}" ${spec.dir === 'desc' ? 'DESC' : 'ASC'}`);
      if (clauses.length > 0) {
        sql += ` ORDER BY ${clauses.join(', ')}`;
      }
    }
  }

  // NOTE: limit is intentionally omitted — applied per-entity after grouping.
  return sql;
}

/**
 * Execute a batched query with an IN clause, chunking to stay under SQLite's
 * parameter limit. Returns all rows across all chunks.
 */
function batchQuery(
  adapter: StorageAdapter,
  buildSql: (placeholders: string) => string,
  inValues: unknown[],
  extraParams: unknown[],
): Row[] {
  if (inValues.length === 0) return [];
  const allRows: Row[] = [];
  for (let i = 0; i < inValues.length; i += BATCH_CHUNK_SIZE) {
    const chunk = inValues.slice(i, i + BATCH_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const sql = buildSql(placeholders);
    allRows.push(...adapter.all(sql, [...chunk, ...extraParams]));
  }
  return allRows;
}

/**
 * Pre-fetch rows for all batchable entity sources in a single pass.
 *
 * For each file in the entity context, this runs one (or a few chunked) queries
 * instead of one per entity. Results are grouped by entity PK value so the
 * render loop can look them up in O(1).
 *
 * Sources of type `custom` and `enriched` cannot be batched and are returned
 * in the `unbatched` set for per-entity fallback.
 */
export function batchPrefetchEntitySources(
  files: Record<string, { source: EntityFileSource; limit?: number | undefined }>,
  allEntityRows: Row[],
  entityPk: string,
  adapter: StorageAdapter,
  protection?: ProtectionContext,
): BatchPrefetchResult {
  const results = new Map<string, Map<string, Row[]>>();
  const unbatched = new Set<string>();

  // Collect all entity PK values
  const allPkValues = allEntityRows.map((r) => r[entityPk]);

  for (const [filename, spec] of Object.entries(files)) {
    const source = spec.source;

    if (source.type === 'self') {
      // No query needed — handled inline
      continue;
    }

    if (source.type === 'custom' || source.type === 'enriched') {
      unbatched.add(filename);
      continue;
    }

    if (source.type === 'hasMany') {
      if (protection?.protectedTables.has(source.table)) {
        // Protected: per-entity fallback for same-table self-only, or empty for cross-table
        unbatched.add(filename);
        continue;
      }
      const ref = source.references ?? entityPk;
      const pkValues = allEntityRows.map((r) => r[ref]);
      const extraParams: unknown[] = [];
      const clauses = buildBatchClauses(extraParams, source);

      const rows = batchQuery(
        adapter,
        (ph) => `SELECT * FROM "${source.table}" WHERE "${source.foreignKey}" IN (${ph})${clauses}`,
        pkValues,
        extraParams,
      );

      const grouped = groupBy(rows, source.foreignKey);
      // Apply per-entity limit if set
      if (source.limit !== undefined && source.limit > 0) {
        for (const [key, arr] of grouped) {
          if (arr.length > source.limit) grouped.set(key, arr.slice(0, source.limit));
        }
      }
      results.set(filename, grouped);
      continue;
    }

    if (source.type === 'manyToMany') {
      if (protection?.protectedTables.has(source.remoteTable)) {
        unbatched.add(filename);
        continue;
      }
      const remotePk = source.references ?? 'id';
      const extraParams: unknown[] = [];
      const clauses = buildBatchClauses(extraParams, source, 'r');

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

      const batchKeyCol = '__lattice_batch_key';
      const rows = batchQuery(
        adapter,
        (ph) =>
          `SELECT ${selectCols}, j."${source.localKey}" AS "${batchKeyCol}" FROM "${source.remoteTable}" r` +
          ` JOIN "${source.junctionTable}" j ON j."${source.remoteKey}" = r."${remotePk}"` +
          ` WHERE j."${source.localKey}" IN (${ph})${clauses}`,
        allPkValues,
        extraParams,
      );

      // Strip the synthetic batch key column before grouping
      const grouped = new Map<string, Row[]>();
      for (const row of rows) {
        const batchVal = row[batchKeyCol];
        const key = batchVal != null ? String(batchVal as string | number) : '';
        // Remove synthetic column without dynamic delete
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [batchKeyCol]: _batchKey, ...clean } = row;
        let arr = grouped.get(key);
        if (!arr) {
          arr = [];
          grouped.set(key, arr);
        }
        arr.push(clean);
      }
      if (source.limit !== undefined && source.limit > 0) {
        for (const [key, arr] of grouped) {
          if (arr.length > source.limit) grouped.set(key, arr.slice(0, source.limit));
        }
      }
      results.set(filename, grouped);
      continue;
    }

    // belongsTo — only remaining batchable type
    if (protection?.protectedTables.has(source.table)) {
      unbatched.add(filename);
      continue;
    }
    // Collect distinct FK values across all entities
    const fkValues = [
      ...new Set(allEntityRows.map((r) => r[source.foreignKey]).filter((v) => v != null)),
    ];
    if (fkValues.length === 0) {
      results.set(filename, new Map());
      continue;
    }

    const refCol = source.references ?? 'id';
    const extraParams: unknown[] = [];
    const clauses = buildBatchClauses(extraParams, source);

    const rows = batchQuery(
      adapter,
      (ph) => `SELECT * FROM "${source.table}" WHERE "${refCol}" IN (${ph})${clauses}`,
      fkValues,
      extraParams,
    );

    // Build FK value → row lookup (belongsTo returns at most one row per FK)
    const lookup = new Map<string, Row>();
    for (const row of rows) {
      const refVal = row[refCol] as string | number | null | undefined;
      lookup.set(refVal != null ? String(refVal) : '', row);
    }

    // Map each entity's FK value to the matching row(s)
    const grouped = new Map<string, Row[]>();
    for (const entityRow of allEntityRows) {
      const fkVal = entityRow[source.foreignKey];
      const pkVal = entityRow[entityPk] as string | number | null | undefined;
      const pkStr = pkVal != null ? String(pkVal) : '';
      if (fkVal == null) {
        grouped.set(pkStr, []);
      } else {
        const related = lookup.get(String(fkVal as string | number));
        grouped.set(pkStr, related ? [related] : []);
      }
    }
    results.set(filename, grouped);
  }

  return { results, unbatched };
}
