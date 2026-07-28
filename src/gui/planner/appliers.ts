import { randomUUID } from 'node:crypto';
import { parseConfigFile, fieldToSqliteBaseType } from '../../config/parser.js';
import { deriveCanonicalContexts } from '../../framework/canonical-context.js';
import { isNativeEntity } from '../../framework/native-entities.js';
import { cloudRlsInstalled } from '../../framework/cloud-connect.js';
import { regenerateAudienceViewFromDb } from '../../cloud/audience.js';
import { allAsyncOrSync } from '../../db/adapter.js';
import { ISO_DATE, ISO_DATETIME, isNumericValue } from '../../import/infer-core.js';
import { canonicalizeValue } from './introspect.js';
import type { ActiveDb } from '../active-db.js';
import { execSql, loadConfigDoc, saveConfigDoc } from '../config-io.js';
import { assertNotComputedSource } from '../computed-ops.js';
import { createRow, updateRow, type MutationCtx } from '../mutations.js';
import {
  normalizedEntityName,
  physicalColumnExists,
  recordSchemaOp,
  renameUserEntity,
} from '../schema-ops.js';

/**
 * The three restructure appliers the plan review offers but could not run:
 * canonical rename, dimension extraction, and column retype. Each one goes
 * through the same audited, no-reopen primitives the rest of the runtime schema
 * layer uses, so an applied proposal lands on the version-history stack and the
 * live workspace stays usable without disposing the in-flight connection.
 *
 * Every guard REFUSES with a message rather than half-applying: these rewrite
 * user data, so a partially-applied restructure is worse than a declined one.
 * Nothing here swallows — a primitive that throws propagates to the caller,
 * which is the review route (it reports the error) or the unattended pass
 * (which catches per-op by design).
 */

/** Result shape shared by every applier (mirrors the two already-wired ones). */
export type ApplyOutcome = { ok: true } | { ok: false; error: string };

const fail = (error: string): ApplyOutcome => ({ ok: false, error });

/**
 * Above this many live rows an applier that must touch EVERY row refuses rather
 * than silently restructuring only the rows it happened to read. The planner
 * profiles from a bounded sample, so a partial backfill would look successful
 * while leaving most rows unlinked.
 */
export const APPLIER_MAX_SCAN_ROWS = 20_000;

/** Distinct values above which a column is not a dimension worth extracting. */
export const MAX_DIMENSION_VALUES = 500;

/**
 * A stored cell as text: `null` when empty, `undefined` when the value is not a
 * scalar. A structured cell is neither a category to extract nor something a
 * narrower column type can hold, and callers must refuse rather than coerce it
 * into the string "[object Object]".
 */
function cellText(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

/** A row's primary-key value as text (always a scalar in a Lattice table). */
function rowId(row: Record<string, unknown>): string {
  return cellText(row.id) ?? '';
}

/** A mutation context for the audited row primitives, built from the workspace. */
function mutationCtx(active: ActiveDb, sessionId: string): MutationCtx {
  return {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    source: 'system',
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Re-derive the canonical entity contexts from the freshly-saved config so a
 * structural change renders without a reopen (relation rollups, a renamed
 * table's folder). Mirrors what the runtime create/delete primitives do. Never
 * clobbers a context the user declared. Best-effort by design: a context
 * refresh failure must not undo an already-persisted, already-audited schema
 * change — it is reported, and the next open re-derives it correctly.
 */
function refreshCanonicalContexts(active: ActiveDb): void {
  if (!active.autoRender) return;
  try {
    const parsed = parseConfigFile(active.configPath);
    const explicit = new Set(parsed.entityContexts.map((e) => e.table));
    for (const { table, definition } of deriveCanonicalContexts(parsed.tables)) {
      if (explicit.has(table)) continue;
      active.db.redefineEntityContext(table, definition);
      active.entityContextByTable.set(table, definition);
    }
  } catch (e) {
    console.warn('[data-model planner] context refresh failed:', (e as Error).message);
  }
}

/**
 * Re-register a table on the LIVE schema registry from the just-saved config.
 * `defineLate` early-returns for an already-registered table, so unregister
 * first — the re-define then runs the (idempotent) schema apply and picks up
 * the new name/field types. Rows are untouched.
 */
async function reregisterFromConfig(active: ActiveDb, table: string): Promise<void> {
  const parsed = parseConfigFile(active.configPath);
  const entry = parsed.tables.find((t) => t.name === table);
  if (!entry) throw new Error(`"${table}" is not declared in this workspace's configuration`);
  active.db.unregisterTable(table);
  await active.db.defineLate(table, entry.definition);
}

/** Shared refusal set: tables no restructure applier may reshape. */
function refuseUnreshapable(active: ActiveDb, table: string): string | null {
  if (!active.validTables.has(table)) return `Unknown table: ${table}`;
  if (isNativeEntity(table)) return `"${table}" is a built-in object and cannot be restructured.`;
  if (active.computedTables.has(table)) {
    return `"${table}" is a computed view — change its definition instead.`;
  }
  if (active.junctionTables.has(table)) {
    return `"${table}" is a relationship table and cannot be restructured.`;
  }
  if (active.db.getConnectedSource(table)) {
    return `"${table}" is a live view of a connected external source, so its shape comes from that source.`;
  }
  try {
    assertNotComputedSource(active, table);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/**
 * Rows of a table, refusing past the scan cap rather than truncating.
 *
 * `includeDeleted` is the difference between "which rows does this restructure
 * READ" and "which rows does it REWRITE". An extraction only cares about live
 * rows, but a column retype rebuilds the physical column — the engine casts
 * EVERY row, archived ones included — so it must read them all or it is casting
 * values it never verified.
 */
async function readAllRows(
  active: ActiveDb,
  table: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<{ rows: Record<string, unknown>[] } | { error: string }> {
  const count = await active.db.boundedCount(table, { cap: APPLIER_MAX_SCAN_ROWS + 1 });
  if (count > APPLIER_MAX_SCAN_ROWS) {
    return {
      error: `"${table}" has more than ${String(APPLIER_MAX_SCAN_ROWS)} rows — too large to restructure in one pass.`,
    };
  }
  const queryOpts: Parameters<typeof active.db.query>[1] = { limit: APPLIER_MAX_SCAN_ROWS };
  if (!opts.includeDeleted && active.softDeletable.has(table)) {
    queryOpts.filters = [{ col: 'deleted_at', op: 'isNull' }];
  }
  return { rows: (await active.db.query(table, queryOpts)) as Record<string, unknown>[] };
}

// ── canonical_rename ────────────────────────────────────────────────────────

/**
 * Rename a table to a canonical identifier.
 *
 * This is a thin adapter over the workspace's ONE rename primitive, not a second
 * implementation of it. A rename is never just an `ALTER TABLE ... RENAME`: the
 * configuration entry, the entity context, the live registry, every bookkeeping
 * store that records the table BY NAME, and — on a hosted workspace — the
 * per-table sharing, ownership and column-masking policy all key on that name,
 * and a rename that moves the table without them silently gives every member
 * direct read on columns the owner marked secret. Routing through the shared
 * primitive is what makes that impossible to get wrong from here.
 */
export async function applyRenameTable(
  active: ActiveDb,
  from: string,
  to: string,
  sessionId: string,
): Promise<ApplyOutcome> {
  const outcome = await renameUserEntity(active, from, to, sessionId);
  return outcome.ok ? { ok: true } : fail(outcome.error);
}

// ── extract_dimension ───────────────────────────────────────────────────────

/**
 * Normalize a repeated categorical column into its own object: create the
 * dimension table, one row per distinct value, add the foreign-key column and
 * its relationship, then backfill every row. Each step is one of the audited
 * primitives (create entity / create row / add link / update row), so the whole
 * extraction is on the history stack and reverts step by step through the same
 * path any other schema change does.
 *
 * `createEntity` is injected because the entity creator normalizes + registers
 * the table; passing it keeps this module off the create path's import chain.
 */
export async function applyExtractDimension(
  active: ActiveDb,
  table: string,
  column: string,
  dimTable: string,
  sessionId: string,
  createEntity: (name: string, columns: string[]) => Promise<string | null>,
): Promise<ApplyOutcome> {
  const refusal = refuseUnreshapable(active, table);
  if (refusal) return fail(refusal);
  const cols = active.db.getRegisteredColumns(table);
  if (!cols || !(column in cols)) return fail(`"${table}" has no column called "${column}".`);
  if (active.db.getPrimaryKey(table).includes(column)) {
    return fail(`"${column}" is the key of "${table}" and cannot be extracted.`);
  }

  const read = await readAllRows(active, table);
  if ('error' in read) return fail(read.error);
  const values: string[] = [];
  const seen = new Set<string>();
  for (const row of read.rows) {
    const s = cellText(row[column]);
    if (s === null) continue;
    if (s === undefined) {
      return fail(`"${table}.${column}" holds structured values, so it is not a category.`);
    }
    if (seen.has(s)) continue;
    seen.add(s);
    values.push(s);
  }
  if (values.length === 0) return fail(`"${table}.${column}" has no values to extract.`);
  if (values.length > MAX_DIMENSION_VALUES) {
    return fail(
      `"${table}.${column}" has ${String(values.length)} distinct values — too many to be a category.`,
    );
  }

  // The name the dimension table will be created under, resolved BEFORE the
  // create rather than read back from it: every refusal left below is ABOUT that
  // table, and a refusal that fires after the create leaves behind a table the
  // user never asked for and has to clean up by hand. The creator normalizes a
  // natural name the same way, through the same shared function, so the
  // predicted name and the created one cannot drift apart.
  const target = normalizedEntityName(dimTable);
  if (target === null) return fail(`"${dimTable}" is not a usable name for a category.`);
  const fkColumn = `${target}_id`;
  if (await physicalColumnExists(active, table, fkColumn)) {
    return fail(`"${table}" already has a "${fkColumn}" column.`);
  }
  // The two conditions the link step below refuses on, checked here — where the
  // answer is still a plain refusal rather than a table full of category rows
  // that nothing links to.
  const relationName = fkColumn.endsWith('_id') ? fkColumn.slice(0, -3) : fkColumn;
  const doc = loadConfigDoc(active.configPath);
  if (doc.getIn(['entities', table]) === undefined) {
    return fail(`"${table}" is not declared in this workspace's configuration.`);
  }
  if (doc.getIn(['entities', table, 'relations', relationName]) !== undefined) {
    return fail(`"${table}" already has a relationship called "${relationName}".`);
  }

  // A dimension table may already exist (an earlier partial run, or a table that
  // happens to carry that name), in which case its rows are reused rather than
  // duplicated — so read them here, before anything is written. A table too
  // large to read whole cannot be reused: the values past the read would be
  // silently duplicated.
  const dimIsLive =
    active.validTables.has(target) || active.db.getRegisteredTableNames().includes(target);
  const existing = dimIsLive
    ? ((await active.db.query(target, {
        limit: MAX_DIMENSION_VALUES + 1,
        ...(active.softDeletable.has(target)
          ? { filters: [{ col: 'deleted_at', op: 'isNull' }] }
          : {}),
      })) as Record<string, unknown>[])
    : [];
  if (existing.length > MAX_DIMENSION_VALUES) {
    return fail(`"${target}" already exists and is too large to reuse as a category list.`);
  }

  // ── nothing above this line writes; nothing below it refuses ───────────────

  const created = await createEntity(dimTable, ['name']);
  if (!created) return fail(`Could not create a "${dimTable}" object for the extracted values.`);
  if (created !== target) {
    // Unreachable while the creator normalizes through the shared function above
    // — but if it ever stops doing so, say so loudly instead of carrying on with
    // guards that were answered for a different table.
    return fail(
      `The category object was created as "${created}" rather than "${target}", so the extraction cannot continue.`,
    );
  }

  const mctx = mutationCtx(active, sessionId);

  // One dimension row per distinct value, reusing any row that already carries
  // that name.
  const idByValue = new Map<string, string>();
  for (const row of existing) {
    const name = row.name;
    if (typeof name === 'string' && name !== '') idByValue.set(name, rowId(row));
  }
  for (const value of values) {
    if (idByValue.has(value)) continue;
    const id = randomUUID();
    await createRow(mctx, created, { id, name: value });
    idByValue.set(value, id);
  }

  // The foreign-key column and the relationship it expresses are ONE change —
  // recorded as the shared link op, whose inverse removes both together (a
  // column without its relation, or the reverse, is a broken half-state).
  const linked = await addLinkColumn(active, table, fkColumn, created, sessionId);
  if (!linked.ok) return linked;

  for (const row of read.rows) {
    const s = cellText(row[column]);
    if (s === null || s === undefined) continue;
    const target = idByValue.get(s);
    if (!target) continue;
    await updateRow(mctx, table, rowId(row), { [fkColumn]: target });
  }
  return { ok: true };
}

/**
 * Add a belongsTo foreign-key column + its relation to a live table — the
 * no-reopen form of the data-model editor's "add link", recorded as the shared
 * revertible link op so the history page removes the column declaration and the
 * relation in one step.
 */
async function addLinkColumn(
  active: ActiveDb,
  table: string,
  column: string,
  target: string,
  sessionId: string,
): Promise<ApplyOutcome> {
  const fieldDef = { type: 'uuid' };
  const relationName = column.endsWith('_id') ? column.slice(0, -3) : column;
  const relation = { type: 'belongsTo', table: target, foreignKey: column };

  const doc = loadConfigDoc(active.configPath);
  if (doc.getIn(['entities', table]) === undefined) {
    return fail(`"${table}" is not declared in this workspace's configuration.`);
  }
  if (doc.getIn(['entities', table, 'relations', relationName]) !== undefined) {
    return fail(`"${table}" already has a relationship called "${relationName}".`);
  }

  // ALTER + live-register (no reopen) so the column is usable immediately.
  await active.db.addColumn(table, column, fieldToSqliteBaseType('uuid'));
  doc.setIn(['entities', table, 'fields', column], fieldDef);
  doc.setIn(['entities', table, 'relations', relationName], relation);
  saveConfigDoc(active.configPath, doc);

  // A cloud's mask view selects an explicit column list, so a new column stays
  // invisible to members until the view is regenerated.
  if (active.db.getDialect() === 'postgres' && (await cloudRlsInstalled(active.db))) {
    const cols = active.db.getRegisteredColumns(table);
    const pk = active.db.getPrimaryKey(table);
    if (cols && pk.length > 0) {
      await regenerateAudienceViewFromDb(active.db, table, Object.keys(cols), pk);
    }
  }
  refreshCanonicalContexts(active);

  await recordSchemaOp(
    active,
    'schema.add_link',
    table,
    null,
    { entity: table, column, fieldDef, relationName, relation },
    `Added link ${table} → ${target}`,
    sessionId,
  );
  return { ok: true };
}

// ── retype_column ───────────────────────────────────────────────────────────

/** The retype targets the detector emits, plus `text` for the reverse direction. */
const RETYPE_TARGETS = new Set(['text', 'integer', 'real', 'boolean', 'date', 'datetime']);

/**
 * The STORAGE class a declared type lands in. Dates and datetimes are text on
 * both engines, so retyping to one of those is a declaration change with no DDL
 * and no value rewrite; only the numeric/boolean targets move storage.
 */
function storageClassFor(type: string): string {
  switch (type) {
    case 'integer':
    case 'boolean':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    default:
      return 'TEXT';
  }
}

/**
 * Build the DDL for a column retype. This is the one place the two engines
 * genuinely diverge:
 *
 *  - Postgres has `ALTER TABLE … ALTER COLUMN … TYPE`, but will NOT implicitly
 *    cast text to a numeric type, so the `USING` clause is mandatory.
 *  - SQLite has no `ALTER COLUMN` at all (its declared type is only an
 *    affinity), so the column is rebuilt: add the new one, copy across, drop the
 *    old, rename into place. `ADD COLUMN` starts from a bare type, so the
 *    column's own NOT NULL / DEFAULT have to be restated here or the rebuild
 *    quietly drops them.
 *
 * Pure + exported so both branches are asserted without a live Postgres.
 * Callers normalize the stored values FIRST (see {@link applyRetypeColumn}), so
 * by the time this SQL runs every remaining value casts cleanly on either
 * engine.
 */
export function retypeSql(
  dialect: 'sqlite' | 'postgres',
  table: string,
  column: string,
  sqlType: string,
  tempColumn: string,
  constraints: { notNull?: boolean; defaultSql?: string | null } = {},
): string[] {
  const t = `"${table}"`;
  const c = `"${column}"`;
  const tmp = `"${tempColumn}"`;
  if (dialect === 'postgres') {
    return [`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${sqlType} USING (${c}::${sqlType})`];
  }
  const spec =
    sqlType +
    (constraints.notNull === true ? ' NOT NULL' : '') +
    (constraints.defaultSql != null ? ` DEFAULT ${constraints.defaultSql}` : '');
  return [
    `ALTER TABLE ${t} ADD COLUMN ${tmp} ${spec}`,
    `UPDATE ${t} SET ${tmp} = CAST(${c} AS ${sqlType})`,
    `ALTER TABLE ${t} DROP COLUMN ${c}`,
    `ALTER TABLE ${t} RENAME COLUMN ${tmp} TO ${c}`,
  ];
}

/**
 * Punctuation the shared ingest numeric reading ignores — currency, grouping,
 * percent, accounting parentheses. Mirrors the strip inside `isNumericValue`,
 * which is the ACCEPTANCE oracle below: anything that predicate calls numeric
 * parses with this same strip, so "accepted" and "convertible" can never drift.
 */
const IGNORED_NUMERIC_PUNCTUATION = /[\s,$%()]/g;

/**
 * Canonicalize one stored value for the target type, or report why it can't be.
 * Conversion happens HERE, in the app layer, rather than being left to the SQL
 * cast: SQLite's `CAST('lots' AS INTEGER)` yields 0 instead of failing, which
 * would turn a retype into silent data corruption.
 *
 * What counts as convertible is NOT decided here — it defers to the same type
 * reading ingest uses (`isNumericValue`, the ISO date/datetime shapes, and the
 * shared cross-dialect value canonicalizer for booleans). That equality is the
 * point: the retype detector proposes a target using exactly those predicates,
 * so anything proposed converts, and nothing the importer would have read as
 * plain text gets rewritten into a number, a flag, or a date behind the user's
 * back. A looser reading here (`Number('$'.replace(…))` → 0, "yes" → 1,
 * `Date.parse('March 5, 2026')` → a date) silently rewrites real values.
 */
export function canonicalizeForRetype(
  raw: unknown,
  type: string,
): { value: string | null } | { problem: string } {
  const text = cellText(raw);
  if (text === null) return { value: null };
  if (text === undefined) return { problem: 'a structured value' };
  const s = text.trim();
  if (s === '') return { value: null };
  switch (type) {
    case 'integer':
    case 'real': {
      if (!isNumericValue(s)) return { problem: s };
      const n = Number(s.replace(IGNORED_NUMERIC_PUNCTUATION, ''));
      if (!Number.isFinite(n)) return { problem: s };
      if (type === 'integer' && !Number.isInteger(n)) return { problem: s };
      return { value: String(n) };
    }
    case 'boolean': {
      const v = canonicalizeValue(s, 'boolean');
      if (typeof v !== 'boolean') return { problem: s };
      return { value: v ? '1' : '0' };
    }
    case 'date': {
      if (!ISO_DATE.test(s)) return { problem: s };
      return { value: s };
    }
    case 'datetime': {
      // A bare date IS a datetime; anything else must carry the time part.
      if (!ISO_DATETIME.test(s) && !ISO_DATE.test(s)) return { problem: s };
      return { value: s };
    }
    default:
      return { value: s };
  }
}

/**
 * The literal a stored column DEFAULT holds, or null when the default is an
 * expression rather than a constant. SQLite hands back the raw source text
 * (`'0'`, `0`); Postgres appends a cast (`'0'::text`). An expression default
 * (`CURRENT_TIMESTAMP`, `nextval(…)`) has no value we can prove converts, so it
 * is reported as unconvertible instead of guessed at.
 */
function defaultLiteralText(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/::[A-Za-z_][A-Za-z_ ]*$/, '')
    .trim();
  const quoted = /^'((?:[^']|'')*)'$/.exec(s);
  const inner = quoted?.[1];
  if (inner !== undefined) return inner.replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return null;
}

/**
 * A metadata cell (PRAGMA / information_schema) as text. These columns are
 * always scalars, so a non-scalar means "absent" rather than something to
 * stringify into a SQL statement.
 */
function metaText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return null;
}

/** Re-emit a canonicalized default as a SQL literal for the target storage. */
function defaultLiteralSql(value: string, sqlType: string): string {
  return sqlType === 'TEXT' ? `'${value.replace(/'/g, "''")}'` : value;
}

/** Escape an identifier for interpolation into a double-quoted SQL name. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Matches an identifier as a whole word inside a SQL statement (quoted or not). */
function mentionsColumn(sql: string, column: string): boolean {
  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])"?${esc}"?([^A-Za-z0-9_]|$)`).test(sql);
}

/**
 * The physical work a retype needs, resolved BEFORE anything is written:
 * `pre` runs first, then the type change, then `post`. `restore` undoes `pre`
 * if the change fails part-way.
 */
interface RetypePhysicalPlan {
  pre: string[];
  post: string[];
  restore: string[];
  constraints: { notNull: boolean; defaultSql: string | null };
}

/**
 * Plan the SQLite column rebuild — and refuse, before any write, anything the
 * rebuild cannot carry across.
 *
 * `ALTER TABLE … DROP COLUMN` is rejected outright when an index references the
 * column, so every such index is dropped first and recreated from its own stored
 * definition afterwards. An index SQLite created implicitly for a UNIQUE/PRIMARY
 * KEY constraint has no recreatable definition, so that case is refused instead.
 * The column's NOT NULL / DEFAULT live on the table definition, not on the
 * values, so they are restated on the replacement column or the rebuild drops
 * them silently.
 */
async function planSqliteRetype(
  active: ActiveDb,
  table: string,
  column: string,
  target: string,
  sqlType: string,
  hasEmptyValue: boolean,
): Promise<RetypePhysicalPlan | { error: string }> {
  const adapter = active.db.adapter;
  const info = await allAsyncOrSync(adapter, `PRAGMA table_info(${quoteIdent(table)})`);
  const col = info.find((r) => metaText(r.name) === column);
  if (!col) return { error: `"${table}" has no column called "${column}".` };
  const notNull = Number(col.notnull) === 1;
  const rawDefault = metaText(col.dflt_value);

  let defaultSql: string | null = null;
  if (rawDefault !== null) {
    const literal = defaultLiteralText(rawDefault);
    if (literal === null) {
      return {
        error: `"${table}.${column}" has a computed default (${rawDefault}) that cannot be carried across a type change.`,
      };
    }
    const canonical = canonicalizeForRetype(literal, target);
    if ('problem' in canonical || canonical.value === null) {
      return {
        error: `"${table}.${column}" defaults to "${literal}", which does not convert — change the default first.`,
      };
    }
    defaultSql = defaultLiteralSql(canonical.value, sqlType);
  }
  if (notNull && defaultSql === null) {
    return {
      error: `"${table}.${column}" is a required column with no default value, so rebuilding it would drop that requirement.`,
    };
  }
  if (notNull && hasEmptyValue) {
    return {
      error: `"${table}.${column}" is required but some rows are empty, which cannot be stored as ${sqlType.toLowerCase()}.`,
    };
  }

  const indexSql = new Map<string, string | null>();
  for (const r of await allAsyncOrSync(
    adapter,
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
    [table],
  )) {
    const name = metaText(r.name);
    if (name !== null) indexSql.set(name, metaText(r.sql));
  }
  const pre: string[] = [];
  const post: string[] = [];
  for (const idx of await allAsyncOrSync(adapter, `PRAGMA index_list(${quoteIdent(table)})`)) {
    const name = metaText(idx.name);
    if (name === null) continue;
    const cols = await allAsyncOrSync(adapter, `PRAGMA index_info(${quoteIdent(name)})`);
    const sql = indexSql.get(name) ?? null;
    const covers =
      cols.some((c) => metaText(c.name) === column) ||
      (sql !== null && mentionsColumn(sql, column));
    if (!covers) continue;
    if (sql === null) {
      return {
        error: `"${table}.${column}" is covered by a ${metaText(idx.origin) === 'pk' ? 'primary key' : 'unique'} constraint, which cannot be rebuilt around a type change.`,
      };
    }
    pre.push(`DROP INDEX ${quoteIdent(name)}`);
    post.push(sql);
  }
  return { pre, post, restore: [...post], constraints: { notNull, defaultSql } };
}

/**
 * Plan the Postgres type change. `ALTER COLUMN … TYPE` carries NOT NULL and
 * rebuilds indexes on its own, but it refuses when the column's DEFAULT does not
 * cast to the new type — so the default is dropped around the change and
 * re-applied in its canonical form, and a default that would not survive is
 * refused before anything is written.
 */
async function planPostgresRetype(
  active: ActiveDb,
  table: string,
  column: string,
  target: string,
  sqlType: string,
): Promise<RetypePhysicalPlan | { error: string }> {
  const rows = await allAsyncOrSync(
    active.db.adapter,
    `SELECT column_default AS dflt FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  const rawDefault = metaText(rows[0]?.dflt);
  const t = quoteIdent(table);
  const c = quoteIdent(column);
  if (rawDefault === null) {
    return { pre: [], post: [], restore: [], constraints: { notNull: false, defaultSql: null } };
  }
  const literal = defaultLiteralText(rawDefault);
  if (literal === null) {
    return {
      error: `"${table}.${column}" has a computed default (${rawDefault}) that cannot be carried across a type change.`,
    };
  }
  const canonical = canonicalizeForRetype(literal, target);
  if ('problem' in canonical || canonical.value === null) {
    return {
      error: `"${table}.${column}" defaults to "${literal}", which does not convert — change the default first.`,
    };
  }
  return {
    pre: [`ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`],
    post: [
      `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${defaultLiteralSql(canonical.value, sqlType)}`,
    ],
    restore: [`ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${rawDefault}`],
    constraints: { notNull: false, defaultSql: null },
  };
}

/**
 * Run the planned physical change, and put back what was taken down if it fails
 * part-way.
 *
 * The rebuild is not one atomic statement and cannot be wrapped in a
 * transaction: the DDL runs on the shared connection, so a rollback would also
 * discard whatever concurrent row writes happened to be in flight. Instead each
 * step is undone explicitly — the half-built temporary column is dropped (a
 * stray `<col>_lattice_retype` is invisible to the interface and the user has no
 * way to remove it), dropped indexes are recreated, and a dropped mask view is
 * regenerated so a cloud never keeps serving without it. The ORIGINAL failure is
 * always what propagates; a cleanup that also fails is appended to it, never
 * swallowed and never substituted for it.
 */
async function runPhysicalRetype(
  active: ActiveDb,
  table: string,
  column: string,
  sqlType: string,
  tempColumn: string,
  plan: RetypePhysicalPlan,
  hasMaskView: boolean,
): Promise<void> {
  const dialect = active.db.getDialect();
  try {
    if (hasMaskView) await execSql(active.db, `DROP VIEW IF EXISTS "${table}_v"`);
    for (const sql of plan.pre) await execSql(active.db, sql);
    for (const sql of retypeSql(dialect, table, column, sqlType, tempColumn, plan.constraints)) {
      await execSql(active.db, sql);
    }
    for (const sql of plan.post) await execSql(active.db, sql);
  } catch (e) {
    const cleanupErrors: string[] = [];
    const attempt = async (sql: string): Promise<void> => {
      try {
        await execSql(active.db, sql);
      } catch (err) {
        cleanupErrors.push(`${sql}: ${(err as Error).message}`);
      }
    };
    if (await physicalColumnExists(active, table, tempColumn)) {
      await attempt(`ALTER TABLE "${table}" DROP COLUMN "${tempColumn}"`);
    }
    for (const sql of plan.restore) await attempt(sql);
    if (hasMaskView) {
      const cols = active.db.getRegisteredColumns(table);
      const pk = active.db.getPrimaryKey(table);
      if (cols && pk.length > 0) {
        try {
          await regenerateAudienceViewFromDb(active.db, table, Object.keys(cols), pk);
        } catch (err) {
          cleanupErrors.push(`regenerate ${table}_v: ${(err as Error).message}`);
        }
      }
    }
    const original = e as Error;
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${original.message} (and cleaning up afterwards failed: ${cleanupErrors.join('; ')})`,
      );
    }
    throw original;
  }
}

/**
 * Retype a column to a narrower declared type: verify EVERY stored value
 * converts, normalize the stored text so the engine's own cast is lossless,
 * run the dialect-appropriate DDL, update the declared type in the config, and
 * re-register the table so the change is visible without a reopen (which is
 * also what stops the detector from proposing the same retype forever).
 *
 * Recorded in history as a retype op so the change is visible and attributable.
 * The operation is its own inverse — retyping back to `text` restores the text
 * form — which is the revert path, since a value rewrite cannot be replayed
 * from a config diff the way a rename can.
 */
export async function applyRetypeColumn(
  active: ActiveDb,
  table: string,
  column: string,
  toType: string,
  sessionId: string,
): Promise<ApplyOutcome> {
  const refusal = refuseUnreshapable(active, table);
  if (refusal) return fail(refusal);
  const target = toType.toLowerCase();
  if (!RETYPE_TARGETS.has(target)) return fail(`"${toType}" is not a type a column can hold.`);
  const cols = active.db.getRegisteredColumns(table);
  if (!cols || !(column in cols)) return fail(`"${table}" has no column called "${column}".`);
  if (active.db.getPrimaryKey(table).includes(column)) {
    return fail(`"${column}" is the key of "${table}" and cannot be retyped.`);
  }
  if (active.db.getEncryptedColumns(table).has(column)) {
    return fail(`"${column}" is stored encrypted and cannot be retyped.`);
  }
  const currentType = active.db.getRegisteredFieldTypes(table)?.[column];
  if (currentType === target) return fail(`"${table}.${column}" is already ${target}.`);

  // EVERY row, archived ones included: the rebuild below casts them all.
  const read = await readAllRows(active, table, { includeDeleted: true });
  if ('error' in read) return fail(read.error);

  // Verify the WHOLE column before touching anything — a retype that silently
  // zeroes the values it couldn't parse is worse than a declined one.
  const rewrite: { id: string; value: string | null }[] = [];
  const problems: string[] = [];
  let hasEmptyValue = false;
  for (const row of read.rows) {
    const out = canonicalizeForRetype(row[column], target);
    if ('problem' in out) {
      if (problems.length < 5) problems.push(out.problem);
      continue;
    }
    if (out.value === null) hasEmptyValue = true;
    // Compare against what is ACTUALLY stored, not its normalized reading: an
    // empty string reads as "no value" but is not NULL, and leaving it in place
    // would let the engine cast it to a zero.
    const stored = row[column];
    const alreadyCanonical =
      out.value === null ? stored === null || stored === undefined : stored === out.value;
    if (!alreadyCanonical) rewrite.push({ id: rowId(row), value: out.value });
  }
  if (problems.length > 0) {
    return fail(
      `"${table}.${column}" cannot become ${target}: ${problems.map((p) => `"${p}"`).join(', ')} ` +
        `${problems.length === 1 ? 'is not' : 'are not'} ${target}.`,
    );
  }

  const sqlType = storageClassFor(target);
  const tempColumn = `${column}_lattice_retype`;
  if (tempColumn in cols) {
    return fail(`"${table}" already has a "${tempColumn}" column — remove it and retry.`);
  }

  // The declaration this retype edits must exist BEFORE the first write. Checked
  // again inside the lock (still before any write) so the write acts on the doc
  // it verified, never a stale read.
  if (loadConfigDoc(active.configPath).getIn(['entities', table, 'fields', column]) === undefined) {
    return fail(`"${table}.${column}" is not declared in this workspace's configuration.`);
  }

  const dialect = active.db.getDialect();
  const physicalChanges = sqlType !== storageClassFor(currentType ?? 'text');
  // What the physical change needs — indexes to drop and recreate, constraints to
  // carry across, defaults to re-apply — resolved here, where a "this cannot be
  // rebuilt" answer is still a plain refusal rather than a half-applied table.
  let plan: RetypePhysicalPlan = {
    pre: [],
    post: [],
    restore: [],
    constraints: { notNull: false, defaultSql: null },
  };
  if (physicalChanges) {
    const planned =
      dialect === 'postgres'
        ? await planPostgresRetype(active, table, column, target, sqlType)
        : await planSqliteRetype(active, table, column, target, sqlType, hasEmptyValue);
    if ('error' in planned) return fail(planned.error);
    plan = planned;
  }

  return active.db.withSchemaLock(async (): Promise<ApplyOutcome> => {
    const doc = loadConfigDoc(active.configPath);
    if (doc.getIn(['entities', table, 'fields', column]) === undefined) {
      return fail(`"${table}.${column}" is not declared in this workspace's configuration.`);
    }

    // A cloud's per-table mask view selects from the base table, and Postgres
    // refuses to alter a column a view depends on — it is dropped around the
    // change and regenerated from the column policy afterwards. Read here, while
    // this is still all reads: dropping a mask for a retype that then refuses
    // would leave the cloud serving the base table unmasked.
    const hasMaskView = dialect === 'postgres' && (await cloudRlsInstalled(active.db));

    // ── nothing above this line writes; nothing below it refuses ─────────────

    // Normalize the stored text FIRST so the engine's own cast below is a pure
    // representation change with nothing left to parse. Every value was proven
    // convertible above, and each write is the canonical spelling of the value
    // it replaces — so if the DDL that follows fails, the error surfaces, the
    // declared type is unchanged, and no value has been lost.
    for (const r of rewrite) {
      await active.db.update(table, r.id, { [column]: r.value });
    }

    if (physicalChanges) {
      await runPhysicalRetype(active, table, column, sqlType, tempColumn, plan, hasMaskView);
    }

    doc.setIn(['entities', table, 'fields', column, 'type'], target);
    saveConfigDoc(active.configPath, doc);
    await reregisterFromConfig(active, table);

    if (hasMaskView) {
      const after = active.db.getRegisteredColumns(table);
      const pk = active.db.getPrimaryKey(table);
      if (after && pk.length > 0) {
        await regenerateAudienceViewFromDb(active.db, table, Object.keys(after), pk);
      }
    }
    refreshCanonicalContexts(active);

    await recordSchemaOp(
      active,
      'schema.retype_column',
      table,
      { entity: table, column, type: currentType ?? 'text' },
      { entity: table, column, type: target },
      `Retyped ${table}.${column} to ${target}`,
      sessionId,
    );
    return { ok: true };
  });
}
