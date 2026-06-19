import type { StorageAdapter } from '../db/adapter.js';
import { getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import { pageClause } from '../schema/manager.js';
import type { PageOptions } from '../schema/manager.js';
import type {
  Row,
  QueryOptions,
  CountOptions,
  Filter,
  FilterExpr,
  FilterOp,
  QueryProjection,
  AggregateOptions,
  AggregateResult,
  AggregateSpec,
  QueryPageOptions,
  QueryPageResult,
} from '../types.js';

/** Structural shape of `Lattice`'s `PkLookup` (avoids a circular import). */
type PkLookup = string | Record<string, unknown>;

/**
 * Thrown by a bounded read (`QueryOptions.maxRows` or `defaultMaxRows`) when more
 * rows match than the cap allows and no explicit `limit` was given — forcing the
 * caller to paginate instead of silently loading an unbounded result set.
 */
export class BoundedReadError extends Error {
  constructor(
    readonly table: string,
    readonly maxRows: number,
  ) {
    super(
      `Query on "${table}" exceeded the bounded-read cap of ${String(maxRows)} rows. ` +
        `Add an explicit limit/offset (or queryPage) to paginate, or raise maxRows.`,
    );
    this.name = 'BoundedReadError';
  }
}

/** A clause is the leaf form of a FilterExpr (has a `col`); groups have or/and. */
function isFilterClause(f: FilterExpr): f is Filter {
  return 'col' in f;
}

/** Recursively collect every column referenced by a filter expression tree. */
export function collectFilterCols(filters: FilterExpr[] | undefined): string[] {
  const out: string[] = [];
  for (const f of filters ?? []) {
    if (isFilterClause(f)) out.push(f.col);
    else if ('or' in f) out.push(...collectFilterCols(f.or));
    else out.push(...collectFilterCols(f.and));
  }
  return out;
}

/**
 * The generic READ surface extracted from the `Lattice` facade — the
 * most-called methods (`query` / `get` / `count` / `getActive` / `countActive`
 * / `getByNaturalKey`) plus the private filter-clause builder they share. The
 * facade keeps a thin delegator for each public method (it performs the
 * `init()` guard and forwards here).
 *
 * The DECRYPTION ASYMMETRY is load-bearing and preserved exactly:
 *   - `query()` and `get()` DECRYPT sealed/encrypted columns before returning.
 *   - `getActive()` and `getByNaturalKey()` return the RAW (non-decrypted)
 *     stored row.
 * The injected `decryptRow`/`decryptRows` deps are therefore invoked ONLY by
 * `query`/`get`, never by getActive/getByNaturalKey/count/countActive — matching
 * the facade's behavior today.
 *
 * Dependencies that live on the facade (the adapter, identifier validation, the
 * column-cache accessor, the composite-PK WHERE builder, the unknown-column
 * guard, and the row decryptors) are injected so this module never reaches into
 * `Lattice` internals. It imports ONLY types from the facade's modules, so it
 * never participates in an import cycle through `lattice.ts`.
 */
export interface QueryCoreDeps {
  adapter: StorageAdapter;
  /** Validate a table (and any dynamic column) identifier before SQL interpolation. */
  assertIdent: (table: string, ...cols: string[]) => void;
  /** Actual columns of `table` (from PRAGMA), populated after init(). */
  ensureColumnCache: (table: string) => Set<string>;
  /** WHERE clause + params for a PK lookup (single or composite key). */
  pkWhere: (table: string, id: PkLookup) => { clause: string; params: unknown[] };
  /**
   * Rejected Promise if any column is unknown for a registered table; null if
   * all valid (or the table is unregistered → pass through). Keeps the generic
   * type parameter + the exact Promise-or-null return shape so the query/count
   * call sites retain typing.
   */
  invalidColumnError: <T>(table: string, cols: string[]) => Promise<T> | null;
  /** Decrypt applicable columns in a single row (query→get path only). */
  decryptRow: (table: string, row: Row) => Row;
  /** Decrypt applicable columns across rows (query path only). */
  decryptRows: (table: string, rows: Row[]) => Row[];
  /**
   * Default bounded-read cap from `LatticeOptions.defaultMaxRows`. When set, a
   * `query()` with no explicit `limit` and no per-call `maxRows` is capped at
   * this many rows and throws `BoundedReadError` if more exist. `undefined`
   * preserves the unbounded default.
   */
  defaultMaxRows?: number | undefined;
}

export class QueryCore {
  private readonly adapter: StorageAdapter;
  private readonly assertIdent: QueryCoreDeps['assertIdent'];
  private readonly ensureColumnCache: QueryCoreDeps['ensureColumnCache'];
  private readonly pkWhere: QueryCoreDeps['pkWhere'];
  private readonly invalidColumnError: QueryCoreDeps['invalidColumnError'];
  private readonly decryptRow: QueryCoreDeps['decryptRow'];
  private readonly decryptRows: QueryCoreDeps['decryptRows'];
  private readonly defaultMaxRows: number | undefined;

  constructor(deps: QueryCoreDeps) {
    this.adapter = deps.adapter;
    this.assertIdent = deps.assertIdent;
    this.ensureColumnCache = deps.ensureColumnCache;
    this.pkWhere = deps.pkWhere;
    this.invalidColumnError = deps.invalidColumnError;
    this.decryptRow = deps.decryptRow;
    this.decryptRows = deps.decryptRows;
    this.defaultMaxRows = deps.defaultMaxRows;
  }

  async query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    this.assertIdent(table);

    if (opts.distinctOn !== undefined) return this.queryDistinct(table, opts);

    const projectionCols = this.projectionColumns(table, opts.projection);
    const colErr = this.invalidColumnError<Row[]>(table, [
      ...Object.keys(opts.where ?? {}),
      ...collectFilterCols(opts.filters),
      ...(opts.orderBy ? [opts.orderBy] : []),
      ...(projectionCols ?? []),
    ]);
    if (colErr) return colErr;

    const selectList = projectionCols ? projectionCols.map((c) => `"${c}"`).join(', ') : '*';
    let sql = `SELECT ${selectList} FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    // Equality where (backward compat shorthand)
    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [col, val] of Object.entries(opts.where)) {
        whereClauses.push(`"${col}" = ?`);
        params.push(val);
      }
    }

    // Advanced filters with full operator support (recursive or/and + jsonPath)
    if (opts.filters && opts.filters.length > 0) {
      const { clauses, params: fp } = this.buildFilters(opts.filters);
      whereClauses.push(...clauses);
      params.push(...fp);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    if (opts.orderBy) {
      const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
    }

    // Bounded-read: when no explicit limit is given but a maxRows cap applies,
    // fetch one extra row to detect overflow and throw rather than silently
    // returning a truncated-or-unbounded set.
    const cap = opts.limit === undefined ? (opts.maxRows ?? this.defaultMaxRows) : undefined;
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${opts.limit.toString()}`;
    } else if (cap !== undefined) {
      sql += ` LIMIT ${(cap + 1).toString()}`;
    }
    if (opts.offset !== undefined) {
      if (opts.limit === undefined && cap === undefined) sql += ' LIMIT -1';
      sql += ` OFFSET ${opts.offset.toString()}`;
    }

    const rows = await allAsyncOrSync(this.adapter, sql, params);
    if (cap !== undefined && rows.length > cap) {
      throw new BoundedReadError(table, cap);
    }
    // decryptRows only touches encrypted columns that are present, so a
    // projection that omits them naturally skips their decryption.
    return this.decryptRows(table, rows);
  }

  /**
   * Resolve a {@link QueryProjection} to an explicit ordered column list, or
   * `null` to select all columns. Invalid/unknown columns are filtered out so
   * the SELECT never names a nonexistent column; an empty include yields the PK
   * fallback `['*']` semantics (null) to avoid an empty SELECT.
   */
  private projectionColumns(table: string, projection?: QueryProjection): string[] | null {
    if (!projection) return null;
    const known = this.ensureColumnCache(table);
    if (Array.isArray(projection)) {
      const cols = projection.filter((c) => known.has(c));
      return cols.length > 0 ? cols : null;
    }
    if ('include' in projection) {
      const cols = projection.include.filter((c) => known.has(c));
      return cols.length > 0 ? cols : null;
    }
    const exclude = new Set(projection.exclude);
    const cols = [...known].filter((c) => !exclude.has(c));
    return cols.length > 0 ? cols : null;
  }

  /** Shared WHERE composition (equality `where` AND-ed with advanced filters). */
  private composeWhere(
    where: Record<string, unknown> | undefined,
    filters: FilterExpr[] | undefined,
  ): { clauses: string[]; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (where && Object.keys(where).length > 0) {
      for (const [c, v] of Object.entries(where)) {
        clauses.push(`"${c}" = ?`);
        params.push(v);
      }
    }
    if (filters && filters.length > 0) {
      const built = this.buildFilters(filters);
      clauses.push(...built.clauses);
      params.push(...built.params);
    }
    return { clauses, params };
  }

  /**
   * `distinctOn` path: one row per distinct value of the given column(s).
   * Postgres uses `DISTINCT ON`; SQLite emulates it with a `ROW_NUMBER()` window
   * (both pick the row determined by the order, then the primary key).
   */
  private async queryDistinct(table: string, opts: QueryOptions): Promise<Row[]> {
    const distinctCols = Array.isArray(opts.distinctOn)
      ? opts.distinctOn
      : opts.distinctOn
        ? [opts.distinctOn]
        : [];
    const projectionCols = this.projectionColumns(table, opts.projection);
    const colErr = this.invalidColumnError<Row[]>(table, [
      ...distinctCols,
      ...Object.keys(opts.where ?? {}),
      ...collectFilterCols(opts.filters),
      ...(opts.orderBy ? [opts.orderBy] : []),
      ...(projectionCols ?? []),
    ]);
    if (colErr) return colErr;

    const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
    const pkCol = [...this.ensureColumnCache(table)].includes('id')
      ? 'id'
      : (distinctCols[0] ?? 'id');
    const tieCol = opts.orderBy ?? pkCol;
    const selectList = projectionCols ? projectionCols.map((c) => `"${c}"`).join(', ') : '*';
    const { clauses, params } = this.composeWhere(opts.where, opts.filters);
    const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const distinctList = distinctCols.map((c) => `"${c}"`).join(', ');

    let rows: Row[];
    if (this.adapter.dialect === 'postgres') {
      // DISTINCT ON requires the ORDER BY to lead with the distinct columns.
      let sql = `SELECT DISTINCT ON (${distinctList}) ${selectList} FROM "${table}"${whereSql}`;
      sql += ` ORDER BY ${distinctList}, "${tieCol}" ${dir}`;
      if (opts.limit !== undefined) sql += ` LIMIT ${opts.limit.toString()}`;
      rows = await allAsyncOrSync(this.adapter, sql, params);
    } else {
      const inner =
        `SELECT *, ROW_NUMBER() OVER (PARTITION BY ${distinctList} ORDER BY "${tieCol}" ${dir}) AS __rn ` +
        `FROM "${table}"${whereSql}`;
      let sql = `SELECT ${selectList} FROM (${inner}) WHERE __rn = 1`;
      if (opts.orderBy) sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
      if (opts.limit !== undefined) sql += ` LIMIT ${opts.limit.toString()}`;
      rows = await allAsyncOrSync(this.adapter, sql, params);
      // Strip the helper column when SELECT * surfaced it.
      for (const r of rows) delete (r as Record<string, unknown>).__rn;
    }
    return this.decryptRows(table, rows);
  }

  /**
   * Keyset (cursor) pagination: stable, index-friendly paging that stays O(log n)
   * deep into a result set, unlike OFFSET. Orders by `(orderBy, pk)` for a total
   * order and walks it with an opaque cursor.
   */
  async queryPage(
    table: string,
    opts: QueryPageOptions,
    pkColumn: string,
  ): Promise<QueryPageResult> {
    this.assertIdent(table);
    const limit = Math.max(1, opts.limit ?? 50);
    const orderBy = opts.orderBy ?? pkColumn;
    const desc = opts.orderDir === 'desc';
    const dir = desc ? 'DESC' : 'ASC';
    const cmp = desc ? '<' : '>';

    const projectionCols = this.projectionColumns(table, opts.projection);
    const colErr = this.invalidColumnError<QueryPageResult>(table, [
      orderBy,
      ...Object.keys(opts.where ?? {}),
      ...collectFilterCols(opts.filters),
      ...(projectionCols ?? []),
    ]);
    if (colErr) return colErr;

    const { clauses, params } = this.composeWhere(opts.where, opts.filters);
    if (opts.cursor) {
      const cur = decodeCursor(opts.cursor);
      // (orderBy cmp ?) OR (orderBy = ? AND pk cmp ?) — total order via the pk tiebreak.
      clauses.push(`("${orderBy}" ${cmp} ? OR ("${orderBy}" = ? AND "${pkColumn}" ${cmp} ?))`);
      params.push(cur.o, cur.o, cur.p);
    }

    const selectList = projectionCols
      ? [...new Set([...projectionCols, orderBy, pkColumn])].map((c) => `"${c}"`).join(', ')
      : '*';
    let sql = `SELECT ${selectList} FROM "${table}"`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY "${orderBy}" ${dir}, "${pkColumn}" ${dir} LIMIT ${(limit + 1).toString()}`;

    const rows = await allAsyncOrSync(this.adapter, sql, params);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    let nextCursor: string | null = null;
    const last = page[page.length - 1];
    if (hasMore && last !== undefined) {
      nextCursor = encodeCursor(last[orderBy], last[pkColumn]);
    }
    return { rows: this.decryptRows(table, page), nextCursor, hasMore };
  }

  async count(table: string, opts: CountOptions = {}): Promise<number> {
    this.assertIdent(table);

    const colErr = this.invalidColumnError<number>(table, [
      ...Object.keys(opts.where ?? {}),
      ...collectFilterCols(opts.filters),
    ]);
    if (colErr) return colErr;

    let sql = `SELECT COUNT(*) as n FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [col, val] of Object.entries(opts.where)) {
        whereClauses.push(`"${col}" = ?`);
        params.push(val);
      }
    }

    if (opts.filters && opts.filters.length > 0) {
      const { clauses, params: fp } = this.buildFilters(opts.filters);
      whereClauses.push(...clauses);
      params.push(...fp);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const row = await getAsyncOrSync(this.adapter, sql, params);
    return Number(row?.n ?? 0);
  }

  async get(table: string, id: PkLookup): Promise<Row | null> {
    const { clause, params } = this.pkWhere(table, id);
    const row =
      (await getAsyncOrSync(this.adapter, `SELECT * FROM "${table}" WHERE ${clause}`, params)) ??
      null;
    return row ? this.decryptRow(table, row) : null;
  }

  /**
   * Get all non-deleted rows from a table, ordered by the given column.
   * Works on any table, not just defined ones.
   */
  async getActive(table: string, orderBy = 'name', opts: PageOptions = {}): Promise<Row[]> {
    const cols = this.ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const order = cols.has(orderBy) ? ` ORDER BY "${orderBy}"` : '';
    const page = pageClause(opts);
    return allAsyncOrSync(
      this.adapter,
      `SELECT * FROM "${table}"${where}${order}${page.sql}`,
      page.params,
    );
  }

  /**
   * Count non-deleted rows in a table.
   */
  async countActive(table: string): Promise<number> {
    const cols = this.ensureColumnCache(table);
    const hasDeletedAt = cols.has('deleted_at');
    const where = hasDeletedAt ? ` WHERE deleted_at IS NULL` : '';
    const row = await getAsyncOrSync(
      this.adapter,
      `SELECT COUNT(*) as cnt FROM "${table}"${where}`,
    );
    // Postgres returns COUNT(*) as a string; SQLite returns a number. Coerce
    // so the public Promise<number> contract holds across dialects.
    return Number(row?.cnt ?? 0);
  }

  /**
   * Lookup a single row by natural key (non-deleted).
   */
  async getByNaturalKey(
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
  ): Promise<Row | null> {
    this.assertIdent(table, naturalKeyCol);

    return (
      (await getAsyncOrSync(
        this.adapter,
        `SELECT * FROM "${table}" WHERE "${naturalKeyCol}" = ? AND deleted_at IS NULL`,
        [naturalKeyVal],
      )) ?? null
    );
  }

  /**
   * Convert filter expressions into SQL clause strings + bound params. Supports
   * recursive `or` / `and` groups and per-clause `jsonPath` extraction. An `in`
   * filter with an empty array is silently ignored (produces no clause). The
   * clauses are AND-ed by the caller (top level), so each returned string is a
   * self-contained predicate.
   */
  buildFilters(filters: FilterExpr[]): {
    clauses: string[];
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const f of filters) {
      const built = this.buildFilterExpr(f);
      if (built) {
        clauses.push(built.sql);
        params.push(...built.params);
      }
    }
    return { clauses, params };
  }

  /** Build a single (possibly grouped) filter expression. Null = no-op clause. */
  private buildFilterExpr(f: FilterExpr): { sql: string; params: unknown[] } | null {
    if ('or' in f) return this.buildGroup(f.or, 'OR');
    if ('and' in f) return this.buildGroup(f.and, 'AND');
    return this.buildClause(f);
  }

  private buildGroup(
    members: FilterExpr[],
    joiner: 'OR' | 'AND',
  ): { sql: string; params: unknown[] } | null {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const m of members) {
      const built = this.buildFilterExpr(m);
      if (built) {
        parts.push(built.sql);
        params.push(...built.params);
      }
    }
    if (parts.length === 0) return null;
    return { sql: `(${parts.join(` ${joiner} `)})`, params };
  }

  /** The column reference for a clause, applying jsonPath extraction if present. */
  private columnRef(f: Filter): string {
    if (f.jsonPath === undefined) return `"${f.col}"`;
    const path = Array.isArray(f.jsonPath) ? f.jsonPath : [f.jsonPath];
    // A numeric comparison needs a numeric-typed extraction so it isn't compared
    // lexicographically: Postgres `#>>` always yields text, and casting keeps the
    // two dialects' jsonPath comparisons identical.
    const numeric = isNumericComparison(f);
    if (this.adapter.dialect === 'postgres') {
      const pathLit = `{${path.join(',')}}`;
      const extract = `("${f.col}" #>> '${pathLit}')`;
      return numeric ? `(${extract})::numeric` : extract;
    }
    // SQLite json_extract(col, '$.a.b') — already returns typed JSON values; the
    // explicit REAL cast keeps numeric comparisons consistent with Postgres.
    const jsonpath = `$.${path.join('.')}`;
    const extract = `json_extract("${f.col}", '${jsonpath}')`;
    return numeric ? `CAST(${extract} AS REAL)` : extract;
  }

  private buildClause(f: Filter): { sql: string; params: unknown[] } | null {
    const col = this.columnRef(f);
    switch (f.op) {
      case 'eq':
        return { sql: `${col} = ?`, params: [f.val] };
      case 'ne':
        return { sql: `${col} != ?`, params: [f.val] };
      case 'gt':
        return { sql: `${col} > ?`, params: [f.val] };
      case 'gte':
        return { sql: `${col} >= ?`, params: [f.val] };
      case 'lt':
        return { sql: `${col} < ?`, params: [f.val] };
      case 'lte':
        return { sql: `${col} <= ?`, params: [f.val] };
      case 'like':
        return { sql: `${col} LIKE ?`, params: [f.val] };
      case 'in': {
        const list = f.val as unknown[];
        if (Array.isArray(list) && list.length > 0) {
          return { sql: `${col} IN (${list.map(() => '?').join(', ')})`, params: [...list] };
        }
        return null;
      }
      case 'isNull':
        return { sql: `${col} IS NULL`, params: [] };
      case 'isNotNull':
        return { sql: `${col} IS NOT NULL`, params: [] };
    }
  }

  /**
   * SQL-side aggregation: GROUP BY + COUNT/SUM/AVG/MIN/MAX with optional HAVING,
   * computed in the database so only the grouped result rows transfer (never
   * the underlying rows). Returns one object per group with the groupBy columns
   * and each aggregate under its `as` key.
   */
  async aggregate(table: string, opts: AggregateOptions): Promise<AggregateResult[]> {
    this.assertIdent(table);
    if (opts.aggregates.length === 0) {
      throw new Error('aggregate: at least one aggregate spec is required');
    }

    // Validate every referenced column (groupBy, aggregate cols, filters, where).
    const aggCols = opts.aggregates.map((a) => a.col).filter((c): c is string => !!c);
    const colErr = this.invalidColumnError<AggregateResult[]>(table, [
      ...(opts.groupBy ?? []),
      ...aggCols,
      ...Object.keys(opts.where ?? {}),
      ...collectFilterCols(opts.filters),
    ]);
    if (colErr) return colErr;

    const selectParts: string[] = [];
    for (const g of opts.groupBy ?? []) selectParts.push(`"${g}"`);
    for (const a of opts.aggregates) selectParts.push(`${aggExpr(a)} AS "${a.as}"`);

    let sql = `SELECT ${selectParts.join(', ')} FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];
    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [c, v] of Object.entries(opts.where)) {
        whereClauses.push(`"${c}" = ?`);
        params.push(v);
      }
    }
    if (opts.filters && opts.filters.length > 0) {
      const { clauses, params: fp } = this.buildFilters(opts.filters);
      whereClauses.push(...clauses);
      params.push(...fp);
    }
    if (whereClauses.length > 0) sql += ` WHERE ${whereClauses.join(' AND ')}`;
    if (opts.groupBy && opts.groupBy.length > 0) {
      sql += ` GROUP BY ${opts.groupBy.map((g) => `"${g}"`).join(', ')}`;
    }
    if (opts.having && opts.having.length > 0) {
      // HAVING must reference the aggregate EXPRESSION, not its SELECT alias —
      // Postgres rejects aliases in HAVING (SQLite tolerates them). Resolve each
      // `aggregate` key back to its `aggExpr(...)`.
      const byKey = new Map(opts.aggregates.map((a) => [a.as, a]));
      const havingParts: string[] = [];
      for (const h of opts.having) {
        const spec = byKey.get(h.aggregate);
        if (!spec) {
          throw new Error(
            `aggregate: HAVING references unknown aggregate "${h.aggregate}" (no matching 'as' key)`,
          );
        }
        const built = havingClause(aggExpr(spec), h);
        if (built) {
          havingParts.push(built.sql);
          params.push(...built.params);
        }
      }
      if (havingParts.length > 0) sql += ` HAVING ${havingParts.join(' AND ')}`;
    }
    if (opts.orderBy) {
      const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
    }
    if (opts.limit !== undefined) sql += ` LIMIT ${opts.limit.toString()}`;

    const rows = await allAsyncOrSync(this.adapter, sql, params);
    // Coerce aggregate outputs to numbers where appropriate (Postgres returns
    // SUM/COUNT as strings; AVG as a numeric string).
    return rows.map((r) => {
      const out: AggregateResult = { ...r };
      for (const a of opts.aggregates) {
        const v = out[a.as];
        if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) out[a.as] = Number(v);
      }
      return out;
    });
  }
}

/** Encode a keyset cursor from the last row's (orderBy, pk) values. Opaque base64. */
function encodeCursor(orderVal: unknown, pkVal: unknown): string {
  const payload = JSON.stringify({ o: orderVal ?? null, p: pkVal ?? null });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode a keyset cursor; throws on a malformed cursor (fail loud). */
function decodeCursor(cursor: string): { o: unknown; p: unknown } {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as { o: unknown; p: unknown };
    return { o: obj.o, p: obj.p };
  } catch {
    throw new Error(`queryPage: malformed cursor`);
  }
}

/** Whether a filter clause compares against a numeric operand (drives jsonPath casting). */
function isNumericComparison(f: Filter): boolean {
  if (f.op === 'in') return Array.isArray(f.val) && f.val.every((v) => typeof v === 'number');
  return typeof f.val === 'number';
}

/** Build the SQL aggregate expression for a spec (validated columns only). */
function aggExpr(a: AggregateSpec): string {
  const fn = a.fn.toUpperCase();
  if (a.fn === 'count' && !a.col) return 'COUNT(*)';
  const inner = a.col ? `"${a.col}"` : '*';
  const distinct = a.distinct ? 'DISTINCT ' : '';
  return `${fn}(${distinct}${inner})`;
}

/** Build a HAVING predicate on a resolved aggregate expression (e.g. `COUNT(*)`). */
function havingClause(
  col: string,
  h: { aggregate: string; op: FilterOp; val?: unknown },
): { sql: string; params: unknown[] } | null {
  switch (h.op) {
    case 'eq':
      return { sql: `${col} = ?`, params: [h.val] };
    case 'ne':
      return { sql: `${col} != ?`, params: [h.val] };
    case 'gt':
      return { sql: `${col} > ?`, params: [h.val] };
    case 'gte':
      return { sql: `${col} >= ?`, params: [h.val] };
    case 'lt':
      return { sql: `${col} < ?`, params: [h.val] };
    case 'lte':
      return { sql: `${col} <= ?`, params: [h.val] };
    case 'isNull':
      return { sql: `${col} IS NULL`, params: [] };
    case 'isNotNull':
      return { sql: `${col} IS NOT NULL`, params: [] };
    default:
      return null;
  }
}
