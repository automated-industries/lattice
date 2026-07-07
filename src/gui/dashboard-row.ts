import type { Row } from '../types.js';

/**
 * Row builders for the native `dashboards` entity — the Analytics-view unit.
 * Mirrors the artifact row builders in `file-row.ts`, but dashboards have a
 * fixed native shape (no customized-schema defaults to satisfy) so the
 * builders are synchronous and dependency-free.
 */

/**
 * Parse the table names a dashboard page reads out of its authored HTML.
 * The authoring contract gives pages exactly two data entrypoints —
 * `lattice.query('<table>' …)` and `lattice.get('<table>' …)` — so a scan for
 * their string-literal first arguments recovers the source tables. Best-effort
 * by design (a dynamically-built table name is invisible); returns unique
 * names in first-seen order, or null when none are found.
 */
/** One `lattice.sql(...)` call found in an authored dashboard. */
export interface DashboardQuery {
  /** The runtime SQL (JS-string escapes resolved), or the raw source for a dynamic one. */
  sql: string;
  /** True when the query is assembled at runtime (a backtick template with `${…}`), so it
   *  can't be statically executed and the caller should skip it. */
  dynamic: boolean;
}

/** Resolve the common JS single-char string escapes so the extracted SQL matches what the
 *  browser will actually run (`\'`→`'`, `\\`→`\`, `\n`→newline, …). */
function unescapeJsString(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c,
  );
}

/**
 * Extract the `lattice.sql('SELECT …')` statements embedded in an authored dashboard —
 * the queries that pull the page's live data — in document order (a dashboard may run
 * several). Used by the dashboard QA pass to execute + validate what the page will run.
 * Best-effort text scan, but ESCAPE-AWARE: the string body may contain the delimiter quote
 * escaped (`lattice.sql('… \\'x\\' …')`), which is resolved to the runtime SQL. A query
 * built at runtime — a backtick template literal with a `${…}` hole — is returned flagged
 * `dynamic` (its values aren't known statically); a literal `${` inside a normal '/" SQL
 * string is just data and stays a static, runnable query.
 */
export function extractDashboardSql(html: string): DashboardQuery[] {
  const out: DashboardQuery[] = [];
  // Capture the opening JS quote, then a body that allows escaped chars (`\\.`) and any
  // non-delimiter char, lazily up to the matching close quote.
  const re = /\blattice\s*\.\s*sql\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const m of html.matchAll(re)) {
    const quote = m[1] ?? "'";
    const raw = m[2] ?? '';
    const dynamic = quote === '`' && raw.includes('${');
    const sql = (dynamic ? raw : unescapeJsString(raw)).trim();
    if (sql) out.push({ sql, dynamic });
  }
  return out;
}

export function extractSourceTables(html: string): string[] | null {
  const seen = new Set<string>();
  const re = /\blattice\s*\.\s*(?:query|get)\s*\(\s*(['"`])([^'"`]+)\1/g;
  for (const m of html.matchAll(re)) {
    const name = (m[2] ?? '').trim();
    if (name) seen.add(name);
  }
  // lattice.sql reads: scan each SQL string literal for FROM/JOIN table
  // identifiers (best-effort — a parenthesized subquery source is recursed
  // into by the same scan since the whole literal is searched).
  const sqlRe = /\blattice\s*\.\s*sql\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const m of html.matchAll(sqlRe)) {
    const sql = m[2] ?? '';
    const idRe = /\b(?:from|join)\s+("?)([a-zA-Z_][a-zA-Z0-9_]*)\1/gi;
    for (const t of sql.matchAll(idRe)) {
      const name = (t[2] ?? '').trim();
      if (name) seen.add(name);
    }
  }
  return seen.size > 0 ? [...seen] : null;
}

/**
 * Build a complete `dashboards` row for an assistant-authored dashboard: the
 * standalone HTML page lives in `html` (rendered in a sandboxed inline frame),
 * the authoring `spec` is kept as a non-executable description of what the
 * dashboard shows, and `source_tables` records which tables the page reads
 * (see {@link extractSourceTables}). The caller persists it via `createRow`
 * with the trusted-authoring flag — the `html` column is refused on every
 * other write path.
 */
export function dashboardRow(title: string, html: string, spec: string): { row: Row; id: string } {
  const id = crypto.randomUUID();
  const sources = extractSourceTables(html);
  const row: Row = {
    id,
    title: title.trim() || 'Untitled dashboard',
    html,
    spec,
    source_tables: sources ? JSON.stringify(sources) : null,
  };
  return { row, id };
}
