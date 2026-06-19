import type { StorageAdapter } from '../db/adapter.js';
import { getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import { pageClause } from '../schema/manager.js';
import type { PageOptions } from '../schema/manager.js';
import type { Row, QueryOptions, CountOptions, Filter } from '../types.js';

/** Structural shape of `Lattice`'s `PkLookup` (avoids a circular import). */
type PkLookup = string | Record<string, unknown>;

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
}

export class QueryCore {
  private readonly adapter: StorageAdapter;
  private readonly assertIdent: QueryCoreDeps['assertIdent'];
  private readonly ensureColumnCache: QueryCoreDeps['ensureColumnCache'];
  private readonly pkWhere: QueryCoreDeps['pkWhere'];
  private readonly invalidColumnError: QueryCoreDeps['invalidColumnError'];
  private readonly decryptRow: QueryCoreDeps['decryptRow'];
  private readonly decryptRows: QueryCoreDeps['decryptRows'];

  constructor(deps: QueryCoreDeps) {
    this.adapter = deps.adapter;
    this.assertIdent = deps.assertIdent;
    this.ensureColumnCache = deps.ensureColumnCache;
    this.pkWhere = deps.pkWhere;
    this.invalidColumnError = deps.invalidColumnError;
    this.decryptRow = deps.decryptRow;
    this.decryptRows = deps.decryptRows;
  }

  async query(table: string, opts: QueryOptions = {}): Promise<Row[]> {
    this.assertIdent(table);

    const colErr = this.invalidColumnError<Row[]>(table, [
      ...Object.keys(opts.where ?? {}),
      ...(opts.filters ?? []).map((f) => f.col),
      ...(opts.orderBy ? [opts.orderBy] : []),
    ]);
    if (colErr) return colErr;

    let sql = `SELECT * FROM "${table}"`;
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    // Equality where (backward compat shorthand)
    if (opts.where && Object.keys(opts.where).length > 0) {
      for (const [col, val] of Object.entries(opts.where)) {
        whereClauses.push(`"${col}" = ?`);
        params.push(val);
      }
    }

    // Advanced filters with full operator support
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
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${opts.limit.toString()}`;
    }
    if (opts.offset !== undefined) {
      if (opts.limit === undefined) sql += ' LIMIT -1';
      sql += ` OFFSET ${opts.offset.toString()}`;
    }

    const rows = await allAsyncOrSync(this.adapter, sql, params);
    return this.decryptRows(table, rows);
  }

  async count(table: string, opts: CountOptions = {}): Promise<number> {
    this.assertIdent(table);

    const colErr = this.invalidColumnError<number>(table, [
      ...Object.keys(opts.where ?? {}),
      ...(opts.filters ?? []).map((f) => f.col),
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
   * Convert Filter objects into SQL clause strings and bound params.
   * An `in` filter with an empty array is silently ignored (produces no clause).
   */
  buildFilters(filters: Filter[]): {
    clauses: string[];
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const f of filters) {
      const col = `"${f.col}"`;
      switch (f.op) {
        case 'eq':
          clauses.push(`${col} = ?`);
          params.push(f.val);
          break;
        case 'ne':
          clauses.push(`${col} != ?`);
          params.push(f.val);
          break;
        case 'gt':
          clauses.push(`${col} > ?`);
          params.push(f.val);
          break;
        case 'gte':
          clauses.push(`${col} >= ?`);
          params.push(f.val);
          break;
        case 'lt':
          clauses.push(`${col} < ?`);
          params.push(f.val);
          break;
        case 'lte':
          clauses.push(`${col} <= ?`);
          params.push(f.val);
          break;
        case 'like':
          clauses.push(`${col} LIKE ?`);
          params.push(f.val);
          break;
        case 'in': {
          const list = f.val as unknown[];
          if (Array.isArray(list) && list.length > 0) {
            clauses.push(`${col} IN (${list.map(() => '?').join(', ')})`);
            params.push(...list);
          }
          break;
        }
        case 'isNull':
          clauses.push(`${col} IS NULL`);
          break;
        case 'isNotNull':
          clauses.push(`${col} IS NOT NULL`);
          break;
      }
    }

    return { clauses, params };
  }
}
