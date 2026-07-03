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
export function extractSourceTables(html: string): string[] | null {
  const seen = new Set<string>();
  const re = /\blattice\s*\.\s*(?:query|get)\s*\(\s*(['"`])([^'"`]+)\1/g;
  for (const m of html.matchAll(re)) {
    const name = (m[2] ?? '').trim();
    if (name) seen.add(name);
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
