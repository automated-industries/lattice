/**
 * SQL dialects for the external-database connector. A dialect knows how to (a)
 * introspect a schema (tables → columns → primary keys), (b) map a native column
 * type to a Lattice column spec, and (c) build a bounded page query. v5.0 ships
 * Postgres-family support only; the interface is structured so MySQL/Snowflake can
 * slot in later without touching the connector.
 *
 * All introspection/page SQL is parameterized or built from identifiers this
 * module quotes — never string-interpolated user values.
 */

/** A SQL fragment plus its bound parameters (Postgres `$1` placeholders). */
export interface SqlQuery {
  sql: string;
  params: unknown[];
}

/** Options for a bounded page over one external table. */
export interface PageOpts {
  schema: string;
  table: string;
  /** Explicitly projected columns (never `SELECT *` — bounded reads). */
  columns: string[];
  /** Single-column key to keyset-paginate on, or null to offset-paginate. */
  keyCol: string | null;
  /** Last key value seen (keyset only); undefined for the first page. */
  afterKey?: unknown;
  /** Row offset (offset pagination only). */
  offset: number;
  /** Page size. */
  limit: number;
}

export interface SqlDialect {
  readonly id: 'postgres';
  /** True when this dialect handles the given connection string. */
  detect(connectionString: string): boolean;
  /** Quote an identifier (table/column/schema) for this dialect. */
  quoteIdent(id: string): string;
  /** List base tables in a schema → rows `{ name }`. */
  tablesSql(schema: string): SqlQuery;
  /** All columns for a schema → rows `{ table, name, type }` (ordinal order). */
  columnsSql(schema: string): SqlQuery;
  /** Primary-key columns for a schema → rows `{ table, col }` (key order). */
  primaryKeysSql(schema: string): SqlQuery;
  /**
   * FOREIGN KEY columns for a schema → rows `{ cname, table, col, ref_table,
   * ref_col }`. May emit multiple rows per composite constraint — the caller
   * groups by `cname` and keeps single-column FKs only (those are the ones that
   * map cleanly onto graph edges).
   */
  foreignKeysSql(schema: string): SqlQuery;
  /** Map a native column type to a Lattice column SQL spec (TEXT | INTEGER | REAL). */
  mapType(nativeType: string): 'TEXT' | 'INTEGER' | 'REAL';
  /** Build a bounded page query (keyset when keyCol set, else offset). */
  pageSql(opts: PageOpts): SqlQuery;
}

/** Postgres-family dialect (AWS RDS Postgres, Supabase, generic Postgres). */
export const PostgresDialect: SqlDialect = {
  id: 'postgres',

  detect(connectionString: string): boolean {
    return /^postgres(ql)?:\/\//i.test(connectionString.trim());
  },

  quoteIdent(id: string): string {
    // Standard SQL identifier quoting: wrap in double quotes, escape embedded ".
    return '"' + id.replace(/"/g, '""') + '"';
  },

  tablesSql(schema: string): SqlQuery {
    return {
      sql: `SELECT table_name AS name FROM information_schema.tables
              WHERE table_schema = $1 AND table_type = 'BASE TABLE'
              ORDER BY table_name`,
      params: [schema],
    };
  },

  columnsSql(schema: string): SqlQuery {
    return {
      sql: `SELECT table_name AS "table", column_name AS name, data_type AS type
              FROM information_schema.columns
              WHERE table_schema = $1
              ORDER BY table_name, ordinal_position`,
      params: [schema],
    };
  },

  primaryKeysSql(schema: string): SqlQuery {
    return {
      sql: `SELECT tc.table_name AS "table", kcu.column_name AS col
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name
               AND kcu.table_schema = tc.table_schema
             WHERE tc.table_schema = $1
               AND tc.constraint_type = 'PRIMARY KEY'
             ORDER BY tc.table_name, kcu.ordinal_position`,
      params: [schema],
    };
  },

  foreignKeysSql(schema: string): SqlQuery {
    return {
      sql: `SELECT tc.constraint_name AS cname, kcu.table_name AS "table",
                   kcu.column_name AS col, ccu.table_name AS ref_table,
                   ccu.column_name AS ref_col
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name
               AND kcu.constraint_schema = tc.constraint_schema
              JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
               AND ccu.constraint_schema = tc.constraint_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema = $1
             ORDER BY tc.constraint_name`,
      params: [schema],
    };
  },

  mapType(nativeType: string): 'TEXT' | 'INTEGER' | 'REAL' {
    const t = nativeType.toLowerCase();
    if (/^(smallint|integer|bigint|int2|int4|int8|serial|bigserial|boolean|bool)$/.test(t)) {
      return 'INTEGER';
    }
    if (/^(numeric|decimal|real|double precision|float|float4|float8|money)$/.test(t)) {
      return 'REAL';
    }
    // Everything else (text/varchar/char/uuid/json/jsonb/array/bytea/timestamp/
    // date/time/enum/geometry/…) is stored as TEXT — JSON/array/bytea are
    // JSON.stringified and timestamps stored as ISO strings at map time, keeping
    // the imported table identical on SQLite- and Postgres-backed Lattice.
    return 'TEXT';
  },

  pageSql(opts: PageOpts): SqlQuery {
    const cols = opts.columns.map((c) => this.quoteIdent(c)).join(', ');
    const rel = `${this.quoteIdent(opts.schema)}.${this.quoteIdent(opts.table)}`;
    const limit = Math.max(1, Math.floor(opts.limit));
    if (opts.keyCol) {
      // Keyset (seek) pagination on a single-column key — stable + O(1) per page.
      const k = this.quoteIdent(opts.keyCol);
      if (opts.afterKey === undefined || opts.afterKey === null) {
        return {
          sql: `SELECT ${cols} FROM ${rel} ORDER BY ${k} ASC LIMIT ${String(limit)}`,
          params: [],
        };
      }
      return {
        sql: `SELECT ${cols} FROM ${rel} WHERE ${k} > $1 ORDER BY ${k} ASC LIMIT ${String(limit)}`,
        params: [opts.afterKey],
      };
    }
    // No single key (composite/no PK) — offset pagination, ordered by all
    // projected columns for a deterministic page sequence. Bounded by the
    // connector's MAX_PAGES backstop.
    const offset = Math.max(0, Math.floor(opts.offset));
    const orderBy = opts.columns.map((c) => this.quoteIdent(c)).join(', ');
    return {
      sql: `SELECT ${cols} FROM ${rel} ORDER BY ${orderBy} LIMIT ${String(limit)} OFFSET ${String(offset)}`,
      params: [],
    };
  },
};

const DIALECTS: SqlDialect[] = [PostgresDialect];

/**
 * Resolve the dialect for a connection string. v5.0 supports Postgres-family
 * only; a non-Postgres URL throws a clear, actionable error — never a silent
 * fallback.
 */
export function dialectFor(connectionString: string): SqlDialect {
  const d = DIALECTS.find((x) => x.detect(connectionString));
  if (!d) {
    throw new Error(
      'Only Postgres-family databases (AWS RDS Postgres, Supabase, generic Postgres) ' +
        'are supported in this release. The connection string must start with postgres:// or postgresql://.',
    );
  }
  return d;
}
