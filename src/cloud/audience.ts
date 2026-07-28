import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import type { ComputedTableDef } from '../config/types.js';
import { computedTableOrder } from '../schema/computed-table.js';
import { memberGroupFor, pkSqlExpr } from './rls.js';
import { dmlKeyGrantSql } from './member-access.js';
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
    // Clears table-level AND every column-level SELECT, so the grant below starts
    // from a clean slate and a column that has just become masked loses its old
    // column grant rather than keeping it.
    `REVOKE SELECT ON ${base} FROM ${group};`,
    // Column-level SELECT on exactly the columns this view does NOT mask.
    //
    // Withholding everything broke writes in a way the WHERE-clause reasoning
    // missed: `INSERT ... ON CONFLICT DO UPDATE` — which is what `Lattice.upsert`
    // emits, and what every connector sync runs — requires SELECT on each column in
    // its SET list, not just the conflict key. So members could insert and update
    // but never upsert, and connector sync was broken for every member on every
    // table.
    //
    // Granting these is not a second read path around the mask: the base table
    // carries FORCE ROW LEVEL SECURITY with the same row-visibility predicate the
    // view applies, so these columns are row-scoped either way, and the masked ones
    // are not in this list at all. The list comes from the SAME spec the view is
    // built from — including any mask recovered from the standing view — so the
    // grant and the mask cannot disagree.
    ...(() => {
      const readable = columns.filter((c) => isRowAudience(columnAudience[c] ?? ''));
      if (readable.length === 0) return [];
      return [`GRANT SELECT (${readable.map(quoteIdent).join(', ')}) ON ${base} TO ${group};`];
    })(),
    // Taking base SELECT away also takes away the member's ability to WRITE: an
    // UPDATE/DELETE needs SELECT on every column its WHERE clause names, so the
    // revoke above turns `UPDATE … WHERE "id" = ?` into `permission denied` before
    // it reaches the UPDATE. The key grant therefore belongs HERE, welded to the
    // revoke — the two are one operation, and any path that performs one without
    // the other leaves the workspace half-broken. (Reconcile emits it too; it is
    // idempotent.)
    `${dmlKeyGrantSql(table, group)};`,
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

/**
 * The table's ACTUAL columns, in ordinal order, straight from the catalog.
 *
 * The view has to project what the table physically has, not what the config
 * declares. While only carefully-declared tables were masked those two agreed
 * closely enough; once EVERY table gets a member read view — introspected,
 * connector-synced, discovered, drifted — they routinely disagree, and each
 * direction is a bug: a declared-but-absent column makes `CREATE VIEW` fail, and
 * a physical-but-undeclared column silently vanishes from the member's read.
 * This also puts the TypeScript generator on the same footing as the plpgsql one,
 * which already reads `information_schema`.
 */
/**
 * Columns the table's CURRENT member read view masks, read out of the view's own
 * stored definition.
 *
 * This is the one record of what was masked that a restore of
 * `__lattice_column_policy` cannot quietly erase, which is what makes it worth
 * parsing SQL for. A masked column is emitted as
 * `CASE WHEN lattice_is_owner(...) THEN col END AS col`, so every `END AS <col>` in
 * the projection names a guarded column. Postgres normalises the definition it
 * stores, so this matches the shape it hands back rather than the shape we wrote.
 *
 * Returns empty when there is no view, when the definition cannot be read, or on a
 * shape it does not recognise — all of which mean "no evidence", never "not masked".
 * Evidence only ever ADDS masking here, so failing to find it cannot open anything;
 * it only fails to rescue.
 */
/**
 * Masked columns for SEVERAL tables at once, from their view definitions.
 *
 * The member-facing companion to {@link viewMaskedColumns}. A scoped member cannot
 * read `__lattice_column_policy` at all (it is owner-only), so any serve-time mask
 * that derives from the policy silently degrades to "nothing is secret" on exactly
 * the connection the mask exists to protect. The view definitions are readable by
 * anyone who can see the view, and they are the same artifact the mask is enforced
 * by — so they cannot disagree with it.
 *
 * Bounded on purpose: it asks only about the tables handed in, so a hot serve path
 * pays for the tables in the page it is returning, not for the whole catalog.
 */
export async function maskedColumnsForTables(
  db: Lattice,
  tables: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (db.getDialect() !== 'postgres' || tables.length === 0) return out;
  const wanted = [...new Set(tables)];
  const byView = new Map(wanted.map((t) => [`${t}_v`, t]));
  try {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT c.relname AS view, pg_get_viewdef(c.oid, true) AS def
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'v'
          AND c.relname IN (${wanted.map(() => '?').join(', ')})`,
      wanted.map((t) => `${t}_v`),
    )) as { view?: unknown; def?: unknown }[];
    for (const r of rows) {
      const table = typeof r.view === 'string' ? byView.get(r.view) : undefined;
      const def = typeof r.def === 'string' ? r.def : '';
      if (!table || !def) continue;
      const cols = new Set<string>();
      const re = /\bEND\s+AS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
      for (let m = re.exec(def); m !== null; m = re.exec(def)) if (m[1]) cols.add(m[1]);
      if (cols.size > 0) out.set(table, cols);
    }
  } catch {
    /* no evidence — the caller decides how to fail closed */
  }
  return out;
}

async function viewMaskedColumns(db: Lattice, table: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT pg_get_viewdef(c.oid, true) AS def
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'v' AND c.relname = ?`,
      [`${table}_v`],
    )) as { def?: unknown }[];
    const def = typeof rows[0]?.def === 'string' ? rows[0].def : '';
    if (!def) return out;
    const re = /\bEND\s+AS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
    for (let m = re.exec(def); m !== null; m = re.exec(def)) if (m[1]) out.add(m[1]);
  } catch {
    /* no evidence available — the caller falls back to the policy alone */
  }
  return out;
}

async function physicalColumns(db: Lattice, table: string): Promise<string[]> {
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "column_name" AS name FROM "information_schema"."columns"
      WHERE "table_schema" = current_schema() AND "table_name" = ?
      ORDER BY "ordinal_position"`,
    [table],
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * (Re)build the relation a cloud MEMBER reads `table` through, from the DB column
 * policy (not YAML), and make the base table's columns unreachable to members.
 *
 * EVERY member-readable table gets a view — masking where the policy says so, a
 * plain pass-through where it does not. There is deliberately no "this table isn't
 * masked, give members the base table" branch any more, and that absence is the
 * entire security property:
 *
 *   The old branch decided by looking the policy up BY NAME. A policy stranded by
 *   a rename — the table's, or one of its columns' — reads back empty, which is
 *   indistinguishable from "nothing is masked here". So the branch granted members
 *   raw base SELECT on a table whose columns the owner had marked secret, and every
 *   masking leak we have had traces to that one statement. With one branch, a
 *   stranded policy can at worst produce a STALE VIEW: wrong, reportable, and
 *   fixable — never cleartext.
 *
 * `columns` is only a fallback; the projection prefers the catalog (see
 * {@link physicalColumns}). Runs the DDL directly rather than through `db.migrate`
 * so it always reflects the current spec.
 *
 * `recreate` forces DROP + CREATE. `CREATE OR REPLACE VIEW` cannot rename, drop or
 * reorder a view's columns (SQLSTATE 42P16), so a column rename / drop / retype
 * must take that path; it is also used as an automatic fallback when a REPLACE
 * turns out to be illegal. Dropping is bracketed by a rebuild of any computed view
 * that depends on this one — without it, `DROP VIEW` raises a bare "cannot drop ...
 * because other objects depend on it" halfway through an otherwise valid rename.
 */
export async function regenerateMemberReadView(
  db: Lattice,
  table: string,
  columns: readonly string[],
  pkCols: readonly string[],
  opts: { recreate?: boolean; unmask?: readonly string[] } = {},
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  // No primary key ⇒ no row-visibility expression ⇒ no honest view. Members get no
  // read path at all, which is the fail-closed answer; reconcile reports it rather
  // than leaving it silent.
  if (pkCols.length === 0) return;
  const group = await memberGroupFor(db);
  const spec = propagateComputedFieldAudiences(db, table, await loadColumnPolicy(db, table));
  const physical = await physicalColumns(db, table);
  const cols = physical.length > 0 ? physical : columns;

  // A view is never rebuilt LESS restrictive than the one already standing.
  //
  // Revoking base SELECT stopped members reading around the mask, but it left the
  // view itself derived solely from `__lattice_column_policy` — and that policy is
  // losable. Drop those rows (a partial restore does exactly this) and the rebuild
  // reads back "nothing is masked here", regenerates `<t>_v` as a plain pass-through,
  // and hands members the column in cleartext. Measured, and silent: no rename, no
  // name mismatch, nothing for a drift check to notice.
  //
  // So the standing view's own definition is treated as evidence in its own right.
  // Postgres stores it, a restore of the policy table cannot erase it, and it says
  // exactly which columns were guarded. Only a caller deliberately changing an
  // audience may reduce masking, and it says so via `unmask`; every other path —
  // reconcile, rename, add-column, retype — may preserve or increase it, never relax.
  const unmask = new Set(opts.unmask ?? []);
  const standing = await viewMaskedColumns(db, table);
  const preserved: string[] = [];
  for (const col of standing) {
    if (unmask.has(col) || !cols.includes(col)) continue;
    if (isRowAudience(spec[col])) {
      spec[col] = 'owner';
      preserved.push(col);
    }
  }
  if (preserved.length > 0) {
    console.warn(
      `[lattice] "${table}": the column policy no longer records ${preserved
        .map((c) => `"${c}"`)
        .join(
          ', ',
        )} as masked, but the standing view masks ${preserved.length === 1 ? 'it' : 'them'}. ` +
        `Keeping the mask and re-recording the policy — un-masking a column is never inferred from ` +
        `missing policy, only from an explicit change.`,
    );
    // Make the recovered mask durable so the next rebuild does not depend on the
    // view surviving. A failure here is surfaced, not swallowed: the view is still
    // built correctly, only the write-back is missing, and the same recovery runs
    // again next time.
    for (const col of preserved) {
      try {
        await runAsyncOrSync(db.adapter, `SELECT lattice_set_column_audience(?, ?, ?)`, [
          table,
          col,
          'owner',
        ]);
      } catch (e) {
        console.warn(
          `[lattice] could not re-record the recovered mask for "${table}"."${col}": ${(e as Error).message}`,
        );
      }
    }
  }

  const sql = audienceViewSql(table, cols, pkCols, spec, group);

  const dropAndCreate = async (): Promise<void> => {
    const dependents = await directViewDependents(db, table);
    await runAsyncOrSync(db.adapter, `DROP VIEW IF EXISTS ${quoteIdent(`${table}_v`)}`);
    await runAsyncOrSync(db.adapter, sql);
    // Re-point anything that was reading the old view. Only worth the pass if
    // something actually depended on it.
    if (dependents.length > 0) await rebuildComputedDependents(db);
  };

  if (opts.recreate) {
    await dropAndCreate();
    return;
  }
  try {
    await runAsyncOrSync(db.adapter, sql);
  } catch (e) {
    const msg = (e as Error).message;
    // 42P16 — the existing view's column set/names differ, so REPLACE is illegal.
    // Recreating is correct here and keeps the caller from having to know which
    // schema edits change a view's shape.
    if (/42P16|cannot change name of view column|cannot drop columns from view/i.test(msg)) {
      await dropAndCreate();
      return;
    }
    throw e;
  }
}

/**
 * Prior name for {@link regenerateMemberReadView}, kept so the published export
 * surface stays additive. The behaviour changed in 5.5 — it no longer has an
 * "unmasked" branch — so prefer the new name, which says what it now does.
 */
export const regenerateAudienceViewFromDb = regenerateMemberReadView;

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
    // The ONE path allowed to make a view less restrictive. The rebuild otherwise
    // preserves any mask the standing view carries, precisely so a LOST policy can
    // never read as "unmask this" — so a deliberate un-masking has to say so.
    await regenerateMemberReadView(db, table, columns, pkCols, { unmask: [column] });
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
