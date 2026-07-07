import type { Lattice } from '../lattice.js';
import { allAsyncOrSync } from '../db/adapter.js';

/**
 * The read-only SQL surface that dashboards use (`window.lattice.sql`) and that the
 * dashboard QA pass runs a generated query through. Factored here so BOTH the HTTP route
 * (`POST /api/analytics/sql`) and the QA share ONE validation + execution path — a query
 * the QA judged is executed exactly as the live dashboard will execute it.
 *
 * Defense in depth, all preserved from the route:
 *  1. statement-shape gate — a single SELECT/WITH statement only;
 *  2. identifier deny-list — credential + conversation + bookkeeping tables refused;
 *  3. executed as THIS connection's role (cloud RLS/grants scope rows) and, on Postgres,
 *     inside a READ ONLY transaction so a data-modifying CTE cannot slip a write through;
 *  4. results wrapped + capped server-side (no unbounded egress).
 */

/** Max rows returned to a dashboard query (a truncation flag signals more). */
export const DASHBOARD_SQL_CAP = 1000;

export interface DashboardSqlResult {
  rows: unknown[];
  truncated: boolean;
}

/** Validate a dashboard SQL string into a runnable statement, or return why not. */
export function validateDashboardSql(
  input: string,
): { ok: true; sql: string } | { ok: false; error: string } {
  const raw = input.trim().replace(/;+\s*$/, '');
  if (!raw) return { ok: false, error: 'sql (string) is required' };
  // Shape gate: first keyword must be select/with, and — after stripping string
  // literals + comments — no statement separator may remain.
  const noStrings = raw
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const first = /^[a-z]+/i.exec(noStrings.trimStart())?.[0]?.toLowerCase() ?? '';
  if (first !== 'select' && first !== 'with') {
    return { ok: false, error: 'only a single SELECT (or WITH … SELECT) statement is allowed' };
  }
  if (noStrings.includes(';')) {
    return { ok: false, error: 'multiple statements are not allowed' };
  }
  if (/\b(secrets|chat_threads|chat_messages)\b|_lattice/i.test(noStrings)) {
    return { ok: false, error: 'this query references a protected table' };
  }
  return { ok: true, sql: raw };
}

/**
 * Run a validated dashboard SELECT read-only and capped. Returns the rows (+ a truncated
 * flag) or an `{ error }` — validation failures and execution failures both come back as
 * `{ error }`, never thrown, so the QA can treat "the query errors" as a finding and the
 * route can map it to a 400.
 */
export async function runDashboardSql(
  db: Lattice,
  input: string,
): Promise<DashboardSqlResult | { error: string }> {
  const v = validateDashboardSql(input);
  if (!v.ok) return { error: v.error };
  const wrapped = `SELECT * FROM (${v.sql}) AS __lattice_sql LIMIT ${String(DASHBOARD_SQL_CAP + 1)}`;
  try {
    let rows: unknown[];
    const adapter = db.adapter;
    if (db.getDialect() === 'postgres' && adapter.withClient) {
      // READ ONLY transaction: the server itself refuses any write a data-modifying
      // CTE might smuggle past the keyword gate.
      rows = await adapter.withClient(async (tx) => {
        await tx.run('BEGIN TRANSACTION READ ONLY');
        try {
          return (await tx.all(wrapped)) as unknown[];
        } finally {
          await tx.run('ROLLBACK');
        }
      });
    } else {
      // SQLite has no data-modifying CTEs; the shape gate is sufficient.
      rows = (await allAsyncOrSync(adapter, wrapped)) as unknown[];
    }
    const truncated = rows.length > DASHBOARD_SQL_CAP;
    return { rows: truncated ? rows.slice(0, DASHBOARD_SQL_CAP) : rows, truncated };
  } catch (err) {
    return { error: `query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
