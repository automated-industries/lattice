import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import type { ComputedTableDef } from '../config/types.js';
import { computedTableOrder } from '../schema/computed-table.js';
import { memberGroupFor, pkSqlExpr } from './rls.js';
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

/** The more restrictive of two masked audiences: identical → itself; divergent → owner-only. */
function stricterAudience(a: string, b: string): string {
  return a === b ? a : 'owner';
}

/**
 * Extend a table's column→audience map so a COMPUTED column inherits the masking of the
 * columns it derives from. A #10 computed field materializes into an ordinary physical
 * column on the base table; without this, an owner-masked source column's value would pass
 * through the derived column RAW in the `<t>_v` view — a column-level cross-tenant leak
 * (a member reads NULL for `salary` but the exact value through `salary_copy`). For every
 * same-table computed field (alias/calc/ai_*), if any of its source columns carries a
 * non-row (masked) audience, the derived column takes the strictest such audience — unless it
 * already declares an explicit audience of its own.
 *
 * Scope: this covers the same-table kinds, whose sources are this table's own columns. An
 * `aggregate` / belongsTo-`path` field derives from ANOTHER table (its source audience lives
 * in that table's policy) and is NOT yet folded here — a narrower follow-up; those kinds are
 * far less common and don't expose a source cell verbatim the way alias/calc do.
 */
export function propagateComputedFieldAudiences(
  db: Lattice,
  table: string,
  columnAudience: Record<string, string>,
): Record<string, string> {
  const plans = db.getComputedFieldPlans(table);
  if (plans.length === 0) return columnAudience;
  const out = { ...columnAudience };
  for (const p of plans) {
    const own = out[p.column];
    if (own !== undefined && !isRowAudience(own)) continue; // already explicitly masked
    let strictest: string | undefined;
    for (const src of p.deps) {
      const a = out[src];
      if (a !== undefined && !isRowAudience(a)) {
        strictest = strictest === undefined ? a : stricterAudience(strictest, a);
      }
    }
    if (strictest !== undefined) out[p.column] = strictest;
  }
  return out;
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
  group: string,
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
    `GRANT SELECT ON ${view} TO ${group};`,
    `REVOKE SELECT ON ${base} FROM ${group};`,
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
  // Fold computed-column derivations into the effective audience so a field derived from a
  // masked source is masked too (never leaks the source's value through the derived column).
  const effective = propagateComputedFieldAudiences(db, table, columnAudience);
  if (!tableNeedsAudienceView(effective)) return;
  if (pkCols.length === 0) return; // unkeyable table — no row filter possible
  const group = await memberGroupFor(db);
  const migration: Migration = {
    version: `internal:audience:table:${table}:v1:${audienceVersionHash(columns, pkCols, effective)}`,
    sql: audienceViewSql(table, columns, pkCols, effective, group),
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
  const group = await memberGroupFor(db);
  const spec = propagateComputedFieldAudiences(db, table, await loadColumnPolicy(db, table));
  const view = quoteIdent(`${table}_v`);
  const base = quoteIdent(table);
  if (!tableNeedsAudienceView(spec)) {
    await runAsyncOrSync(
      db.adapter,
      `DROP VIEW IF EXISTS ${view};\nGRANT SELECT ON ${base} TO ${group};`,
    );
    return;
  }
  await runAsyncOrSync(db.adapter, audienceViewSql(table, columns, pkCols, spec, group));
}

// ── Mask-bypassing dependents ────────────────────────────────────────────────
// A Postgres view executes with its OWNER's rights, so a view that reads a table
// DIRECTLY serves that table's raw columns to anyone who can read the view — the
// cell mask on `<t>_v` is simply not in the path. A computed view compiled while
// a column was still public keeps `FROM "<t>"` forever, so masking the column
// afterwards left the value readable through the projection: the column reported
// as masked while another path still served it. Masking must therefore rebuild
// every such dependent to read through `<t>_v` — or refuse, naming the ones it
// cannot rebuild. Never report a column masked while a path still serves it.

/**
 * Relations (views / materialized views) that read `table` DIRECTLY — i.e. NOT
 * through its `<table>_v` cell-masking view. The table's own mask view is
 * excluded: it IS the mask. Read from `pg_depend`/`pg_rewrite`, so it is the
 * database's own dependency truth rather than anything the process remembers —
 * a view created by an earlier process, or by hand, still shows up. Empty off
 * Postgres, and empty for a table that does not exist.
 */
export async function directViewDependents(db: Lattice, table: string): Promise<string[]> {
  if (db.getDialect() !== 'postgres') return [];
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT DISTINCT c."relname" AS name
       FROM "pg_depend" d
       JOIN "pg_rewrite" r ON r."oid" = d."objid"
       JOIN "pg_class" c ON c."oid" = r."ev_class"
      WHERE d."classid" = 'pg_rewrite'::regclass
        AND d."refclassid" = 'pg_class'::regclass
        AND d."refobjid" = to_regclass(CAST(? AS text))::oid
        AND c."relkind" IN ('v', 'm')
        AND c."relname" <> CAST(? AS text)
      ORDER BY 1`,
    [quoteIdent(table), `${table}_v`],
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * The computed-table definitions the owner published to `__lattice_shared_schema`
 * — the DB-canonical copy of the workspace's `computed:` block, written on owner
 * open and after every runtime computed-table edit. Reading them here (rather
 * than from a config file this module has no handle on) is what lets a mask
 * change rebuild the dependent projections in place. Empty when the cloud has no
 * shared-schema table, no published definitions, or predates the column.
 */
async function publishedComputedDefs(db: Lattice): Promise<Record<string, ComputedTableDef>> {
  const rel = (await getAsyncOrSync(
    db.adapter,
    `SELECT to_regclass('__lattice_shared_schema') AS reg`,
  )) as { reg?: string | null } | undefined;
  if (rel?.reg == null) return {};
  const col = await getAsyncOrSync(
    db.adapter,
    `SELECT 1 AS ok FROM "pg_attribute"
      WHERE "attrelid" = to_regclass('__lattice_shared_schema')
        AND "attname" = 'computed_json' AND NOT "attisdropped"`,
  );
  if (col == null) return {};
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "computed_json" FROM "__lattice_shared_schema" WHERE "id" = ?`,
    ['singleton'],
  )) as { computed_json?: string | null } | undefined;
  const raw = row?.computed_json;
  if (typeof raw !== 'string' || raw === '' || raw === 'null') return {};
  return (JSON.parse(raw) as Record<string, ComputedTableDef> | null) ?? {};
}

/**
 * Recompile every published computed view against the CURRENT column policy, so
 * a projection over a table whose masking just changed is rebuilt to read the
 * right relation (`<t>_v` once a column is masked, the base table once the last
 * one is cleared). The registration recreates the views, which drops their
 * grants, so the member group's SELECT is re-issued here. A view that fails to
 * recompile is reported LOUDLY — it has been dropped by the registration, and a
 * silent skip would leave the workspace missing a table.
 */
async function rebuildComputedDependents(db: Lattice): Promise<void> {
  const defs = await publishedComputedDefs(db);
  const names = Object.keys(defs);
  if (names.length === 0) return;
  // Unregister first: the compiler treats a name already in the live schema as a
  // collision, so re-registering an existing projection has to withdraw it from
  // the registry the same way the computed-table edit path does. Reverse
  // topological order, so a projection built on another comes out first.
  for (const name of [...computedTableOrder(defs)].reverse()) {
    if (db.isComputedTable(name)) db.unregisterComputedTable(name);
  }
  const result = await db.registerComputedTablesLive(defs);
  const group = await memberGroupFor(db);
  for (const view of result.registered) {
    await runAsyncOrSync(db.adapter, `GRANT SELECT ON ${quoteIdent(view)} TO ${group}`);
  }
  if (result.errors.length > 0) {
    throw new Error(
      `lattice: could not rebuild computed view(s) after a column-audience change: ` +
        result.errors.map((e) => `${e.table} (${e.error})`).join('; '),
    );
  }
}

/** Owner-only: set (or clear, with an empty spec) a column's audience in the DB and
 *  regenerate the table's mask view from the DB. The owner gate is enforced inside
 *  lattice_set_column_audience (raises for a non-owner).
 *
 *  Dependent views move WITH the mask. Masking refuses up front when a relation
 *  reads the base table directly and cannot be rebuilt (a hand-written view, an
 *  import-created filtered view) — refusing before any change so the caller is
 *  never told "masked" while that relation still serves the raw value. Clearing
 *  rebuilds dependents FIRST, because they read `<t>_v` at that moment and
 *  Postgres refuses to drop a view something still depends on. */
export async function setColumnAudience(
  db: Lattice,
  table: string,
  column: string,
  audience: string,
  columns: readonly string[],
  pkCols: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const clearing = isRowAudience(audience);

  // Pre-flight (masking only): anything reading the base table directly bypasses
  // the mask. Rebuildable dependents are the published computed views; anything
  // else is refused here, before the policy row exists.
  const exposed = clearing ? [] : await directViewDependents(db, table);
  if (exposed.length > 0) {
    const rebuildable = await publishedComputedDefs(db);
    const stuck = exposed.filter((v) => !(v in rebuildable));
    if (stuck.length > 0) {
      const one = stuck.length === 1;
      throw new Error(
        `Cannot mark "${table}"."${column}" secret: the view${one ? '' : 's'} ` +
          `${stuck.join(', ')} read${one ? 's' : ''} "${table}" directly and would still serve ` +
          `the raw value. Remove or rebuild ${one ? 'it' : 'them'} first, then mark the column secret.`,
      );
    }
  }
  // When clearing, the mask view is about to be dropped — find what reads it now.
  const maskViewDependents = clearing ? await directViewDependents(db, `${table}_v`) : [];

  await runAsyncOrSync(db.adapter, `SELECT lattice_set_column_audience(?, ?, ?)`, [
    table,
    column,
    audience,
  ]);

  if (clearing) {
    if (maskViewDependents.length > 0) await rebuildComputedDependents(db);
    await regenerateAudienceViewFromDb(db, table, columns, pkCols);
    return;
  }

  await regenerateAudienceViewFromDb(db, table, columns, pkCols);
  if (exposed.length > 0) {
    await rebuildComputedDependents(db);
    // Fail loud rather than report a mask that something still reads around.
    const remaining = await directViewDependents(db, table);
    if (remaining.length > 0) {
      throw new Error(
        `lattice: "${table}"."${column}" was masked but ${remaining.join(', ')} still read ` +
          `"${table}" directly — the value is still reachable. Remove those relations.`,
      );
    }
  }
}
