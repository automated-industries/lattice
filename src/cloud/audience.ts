import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import { MEMBER_GROUP, pkSqlExpr } from './rls.js';

/**
 * Per-column audience → a generated cell-masking view (Stage 2 of the per-viewer
 * enrichment model). Postgres RLS is whole-row; column-level masking is layered
 * on with one generated view per entity: every column passes through, except a
 * column with a non-default `audience`, which becomes
 * `CASE WHEN <audience-predicate> THEN col END` — masked cells read as NULL, so
 * `SELECT *` keeps working and the column stays a real column (no side tables).
 *
 * The predicate calls the `session_user`-keyed `SECURITY DEFINER` helpers from
 * the RLS bootstrap (`lattice_has_role` / `lattice_is_subject` /
 * `lattice_source_visible`), so the mask binds to the real member even though the
 * view executes with its owner's rights. That identity choice is what lets an
 * owner-defined view filter per-viewer without re-broadening.
 *
 * The view is a rendered artifact, generated from schema metadata, never
 * hand-edited. Postgres-only; SQLite (single-user, local) needs no masking.
 */

// A column's audience is a '+'-joined set of clauses with OR semantics — the
// column is visible if ANY clause holds:
//   everyone | row-audience  → unmasked (visible to whoever can see the row)
//   role:<name>              → lattice_has_role('<name>')
//   subject:<col>            → lattice_is_subject("<col>")   (col holds the subject's role id)
//   source:<col>             → lattice_source_visible("<col>") (col holds the source's pk)
// An unknown clause throws at generation time — fail closed, never silently open.
const ROLE_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
const COL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** True when this audience means "no mask" (visible to whoever can see the row). */
export function isRowAudience(audience: string | undefined): boolean {
  const a = (audience ?? '').trim();
  return a === '' || a === 'everyone' || a === 'row-audience';
}

/**
 * Compile a column `audience` spec into a boolean SQL predicate over the helper
 * functions. Returns `'true'` for the row-audience / everyone case. Throws on an
 * unknown or malformed clause.
 */
export function audiencePredicate(audience: string): string {
  if (isRowAudience(audience)) return 'true';
  const clauses = audience
    .split('+')
    .map((c) => c.trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const clause of clauses) {
    if (clause === 'everyone' || clause === 'row-audience') return 'true';
    const idx = clause.indexOf(':');
    const kind = idx === -1 ? clause : clause.slice(0, idx);
    const arg = idx === -1 ? '' : clause.slice(idx + 1).trim();
    if (kind === 'role') {
      if (!ROLE_NAME_RE.test(arg)) throw new Error(`lattice: invalid role in audience "${clause}"`);
      parts.push(`lattice_has_role('${arg}')`);
    } else if (kind === 'subject') {
      if (!COL_RE.test(arg))
        throw new Error(`lattice: invalid subject column in audience "${clause}"`);
      parts.push(`lattice_is_subject("${arg}")`);
    } else if (kind === 'source') {
      if (!COL_RE.test(arg))
        throw new Error(`lattice: invalid source column in audience "${clause}"`);
      parts.push(`lattice_source_visible("${arg}")`);
    } else {
      throw new Error(`lattice: unknown audience clause "${clause}"`);
    }
  }
  return parts.length > 0 ? parts.map((p) => `(${p})`).join(' OR ') : 'true';
}

/** Whether a table needs a masking view at all (any column has a real audience). */
export function tableNeedsAudienceView(columnAudience: Record<string, string>): boolean {
  return Object.values(columnAudience).some((a) => !isRowAudience(a));
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * SQL to (re)generate a table's cell-masking view, point members at it, and make
 * the base table's columns unreachable to members so the mask can't be bypassed:
 *
 *  - `CREATE OR REPLACE VIEW <t>_v` — every column passes through, except
 *    audience columns which become `CASE WHEN <predicate> THEN col END`.
 *  - The view re-applies ROW visibility with `WHERE lattice_row_visible(t, pk)`.
 *    This is essential: the view runs with its OWNER's rights, so the base
 *    table's RLS would be evaluated as the owner (who sees everything). The
 *    `session_user`-keyed SECURITY DEFINER helper re-binds row filtering to the
 *    real member, so an owner-defined view still filters per viewer.
 *  - `GRANT SELECT` on the view + `REVOKE SELECT` on the base from members: a
 *    member reads only the masked, row-filtered view and cannot reach the raw
 *    column. (Member writes to such a table flow through the observation path —
 *    members keep INSERT/UPDATE/DELETE on the base under RLS; only SELECT moves
 *    to the view.)
 *
 * Idempotent. `columns` is the table's full column list (stable order); `pkCols`
 * its primary key, so the row filter matches the RLS policy's pk serialization.
 */
export function audienceViewSql(
  table: string,
  columns: readonly string[],
  pkCols: readonly string[],
  columnAudience: Record<string, string>,
): string {
  const view = quoteIdent(`${table}_v`);
  const base = quoteIdent(table);
  const lit = `'${table.replace(/'/g, "''")}'`;
  const selectCols = columns.map((col) => {
    const aud = columnAudience[col] ?? '';
    if (isRowAudience(aud)) return quoteIdent(col);
    const pred = audiencePredicate(aud);
    if (pred === 'true') return quoteIdent(col);
    return `CASE WHEN ${pred} THEN ${quoteIdent(col)} END AS ${quoteIdent(col)}`;
  });
  return [
    `CREATE OR REPLACE VIEW ${view} AS SELECT ${selectCols.join(', ')} FROM ${base}` +
      ` WHERE lattice_row_visible(${lit}, ${pkSqlExpr(pkCols, '')});`,
    `GRANT SELECT ON ${view} TO ${MEMBER_GROUP};`,
    `REVOKE SELECT ON ${base} FROM ${MEMBER_GROUP};`,
  ].join('\n');
}

/** Deterministic FNV-1a hash (hex) of the view spec, so the migration version
 *  key changes when the columns / pk / audience change (regenerating the view)
 *  and is stable otherwise. Avoids Date/random, which the runtime forbids. */
function audienceVersionHash(
  columns: readonly string[],
  pkCols: readonly string[],
  columnAudience: Record<string, string>,
): string {
  const spec = JSON.stringify([
    [...columns],
    [...pkCols],
    Object.keys(columnAudience)
      .sort()
      .map((k) => [k, columnAudience[k]]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < spec.length; i++) {
    h ^= spec.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Generate + install a table's cell-masking view (Postgres only; no-op on SQLite
 * and on a table with no audience columns). Versioned by a content hash of the
 * columns / pk / column-audience so a changed spec regenerates and an unchanged
 * one is skipped. Run AFTER the table + RLS exist (the view reuses the row
 * visibility helper and revokes the base SELECT that enableRlsForTable granted).
 */
export async function enableAudienceView(
  db: Lattice,
  table: string,
  columns: readonly string[],
  pkCols: readonly string[],
  columnAudience: Record<string, string>,
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  if (!tableNeedsAudienceView(columnAudience)) return;
  if (pkCols.length === 0) return; // unkeyable table — no row filter possible
  const migration: Migration = {
    version: `internal:audience:table:${table}:v1:${audienceVersionHash(columns, pkCols, columnAudience)}`,
    sql: audienceViewSql(table, columns, pkCols, columnAudience),
  };
  await db.migrate([migration]);
}
