import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import { MEMBER_GROUP, pkSqlExpr } from './rls.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';

/**
 * Per-column audience → a generated cell-masking view (Stage 2 of the per-viewer
 * enrichment model). Postgres RLS is whole-row; column-level masking is layered
 * on with one generated view per entity: every column passes through, except a
 * column with a non-default `audience`, which becomes
 * `CASE WHEN <audience-predicate> THEN col END` — masked cells read as NULL, so
 * `SELECT *` keeps working and the column stays a real column (no side tables).
 *
 * The `owner` predicate calls the `session_user`-keyed `SECURITY DEFINER` helper
 * `lattice_is_owner` from the RLS bootstrap, so the mask binds to the real member
 * even though the view executes with its owner's rights. That identity choice is
 * what lets an owner-defined view filter per-viewer without re-broadening.
 *
 * The view is a rendered artifact, generated from schema metadata, never
 * hand-edited. Postgres-only; SQLite (single-user, local) needs no masking.
 */

// A column's audience is one of:
//   everyone | row-audience  → unmasked (visible to whoever can see the row)
//   owner                    → lattice_is_owner(<table>, <pk>) (only the row owner; a
//                              DB-enforced "secret" column — needs the row context below)
// Anything else throws at generation time — fail closed, never silently open.

/** Row context the `owner` clause needs (the table literal + pk SQL expression). */
export interface AudienceRowCtx {
  tableLit: string;
  pkExpr: string;
}

/** True when this audience means "no mask" (visible to whoever can see the row). */
export function isRowAudience(audience: string | undefined): boolean {
  const a = (audience ?? '').trim();
  return a === '' || a === 'everyone' || a === 'row-audience';
}

/**
 * Compile a column `audience` spec into a boolean SQL predicate. Returns `'true'`
 * for the row-audience / everyone case, `lattice_is_owner(...)` for the owner
 * (secret-column) case. Throws on anything else — fail closed.
 */
export function audiencePredicate(audience: string, ctx?: AudienceRowCtx): string {
  if (isRowAudience(audience)) return 'true';
  const a = audience.trim();
  if (a === 'everyone' || a === 'row-audience') return 'true';
  if (a === 'owner') {
    if (!ctx) throw new Error('lattice: the "owner" audience needs a row context');
    return `lattice_is_owner(${ctx.tableLit}, ${ctx.pkExpr})`;
  }
  throw new Error(`lattice: unknown audience clause "${audience}"`);
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
  const pkExpr = pkSqlExpr(pkCols, '');
  const selectCols = columns.map((col) => {
    const aud = columnAudience[col] ?? '';
    if (isRowAudience(aud)) return quoteIdent(col);
    const pred = audiencePredicate(aud, { tableLit: lit, pkExpr });
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

// ── WS2: per-column audience spec stored in Postgres (canonical) ──────────────
// The spec previously lived only in the owner's on-disk YAML and was compiled into
// the mask view once at init. These helpers make __lattice_column_policy the source
// of truth: seed the YAML spec into it once (on upgrade), then regenerate the
// <table>_v view FROM the DB on every change, so every member sees identical masking
// regardless of their local config and a spec edit re-masks without re-init.

/** Read a table's canonical column->audience map from __lattice_column_policy. */
export async function loadColumnPolicy(
  db: Lattice,
  table: string,
): Promise<Record<string, string>> {
  if (db.getDialect() !== 'postgres') return {};
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "column_name", "audience" FROM "__lattice_column_policy" WHERE "table_name" = ?`,
    [table],
  )) as { column_name: string; audience: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.column_name] = r.audience;
  return out;
}

/**
 * Read EVERY table's canonical column→audience map from __lattice_column_policy in a
 * single query. This is the DB-canonical source the `<t>_v` masking views are built
 * from, so a consumer deciding "is this table masked?" must read it here — NOT from
 * the in-memory, config-derived schema audience, which never reflects a mask applied
 * at runtime (e.g. the GUI "mark column secret" path). Returns an empty map on a
 * non-Postgres DB.
 */
export async function loadAllColumnPolicy(
  db: Lattice,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (db.getDialect() !== 'postgres') return out;
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "table_name", "column_name", "audience" FROM "__lattice_column_policy"`,
  )) as { table_name: string; column_name: string; audience: string }[];
  for (const r of rows) {
    const m = out.get(r.table_name) ?? {};
    m[r.column_name] = r.audience;
    out.set(r.table_name, m);
  }
  return out;
}

/** Seed a table's YAML-declared audiences into __lattice_column_policy — ONE TIME
 *  per table, the migration from the legacy on-disk spec to the DB-canonical store.
 *  A marker in __lattice_migrations gates it: after the first run we never seed from
 *  YAML again, because a later secureCloud would otherwise re-insert a policy row
 *  for a column the owner has since CLEARED through the DB (a cleared column has no
 *  row, so ON CONFLICT DO NOTHING would NOT protect it) — silently re-masking a
 *  column the owner deliberately un-masked. Once seeded, the DB is canonical and
 *  the only path to change a column's audience is setColumnAudience. */
export async function seedColumnPolicyFromYaml(
  db: Lattice,
  table: string,
  yamlAudience: Record<string, string>,
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const marker = `internal:cloud-column-seed:${table}:v1`;
  const already = await getAsyncOrSync(
    db.adapter,
    `SELECT 1 AS one FROM "__lattice_migrations" WHERE "version" = ?`,
    [marker],
  );
  if (already) return;
  for (const [col, aud] of Object.entries(yamlAudience)) {
    if (isRowAudience(aud)) continue; // a default/everyone column needs no policy row
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "__lattice_column_policy" ("table_name","column_name","audience")
         VALUES (?, ?, ?) ON CONFLICT ("table_name","column_name") DO NOTHING`,
      [table, col, aud],
    );
  }
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "__lattice_migrations" ("version","applied_at") VALUES (?, ?)
       ON CONFLICT ("version") DO NOTHING`,
    [marker, new Date().toISOString()],
  );
}

/** Regenerate a table's cell-masking view FROM the DB column-policy (not YAML). If
 *  the table now has no audience columns, drop the view and restore base SELECT to
 *  members; otherwise (re)create the masked view and revoke base SELECT. Runs the
 *  DDL directly (not via db.migrate) so it always reflects the current spec. */
export async function regenerateAudienceViewFromDb(
  db: Lattice,
  table: string,
  columns: readonly string[],
  pkCols: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  if (pkCols.length === 0) return;
  const spec = await loadColumnPolicy(db, table);
  const view = quoteIdent(`${table}_v`);
  const base = quoteIdent(table);
  if (!tableNeedsAudienceView(spec)) {
    await runAsyncOrSync(
      db.adapter,
      `DROP VIEW IF EXISTS ${view};\nGRANT SELECT ON ${base} TO ${MEMBER_GROUP};`,
    );
    return;
  }
  await runAsyncOrSync(db.adapter, audienceViewSql(table, columns, pkCols, spec));
}

/** Owner-only: set (or clear, with an empty spec) a column's audience in the DB and
 *  regenerate the table's mask view from the DB. The owner gate is enforced inside
 *  lattice_set_column_audience (raises for a non-owner). */
export async function setColumnAudience(
  db: Lattice,
  table: string,
  column: string,
  audience: string,
  columns: readonly string[],
  pkCols: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  await runAsyncOrSync(db.adapter, `SELECT lattice_set_column_audience(?, ?, ?)`, [
    table,
    column,
    audience,
  ]);
  await regenerateAudienceViewFromDb(db, table, columns, pkCols);
}
