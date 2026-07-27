import { randomUUID } from 'node:crypto';
import { parseConfigFile, fieldToSqliteBaseType } from '../../config/parser.js';
import { deriveCanonicalContexts } from '../../framework/canonical-context.js';
import { isNativeEntity } from '../../framework/native-entities.js';
import { cloudRlsInstalled } from '../../framework/cloud-connect.js';
import { regenerateAudienceViewFromDb } from '../../cloud/audience.js';
import type { ActiveDb } from '../active-db.js';
import { execSql, loadConfigDoc, saveConfigDoc } from '../config-io.js';
import { assertNotComputedSource } from '../computed-ops.js';
import { createRow, updateRow, type MutationCtx } from '../mutations.js';
import { physicalColumnExists, recordSchemaOp } from '../schema-ops.js';

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

/** Live rows of a table, refusing past the scan cap rather than truncating. */
async function readAllRows(
  active: ActiveDb,
  table: string,
): Promise<{ rows: Record<string, unknown>[] } | { error: string }> {
  const count = await active.db.boundedCount(table, { cap: APPLIER_MAX_SCAN_ROWS + 1 });
  if (count > APPLIER_MAX_SCAN_ROWS) {
    return {
      error: `"${table}" has more than ${String(APPLIER_MAX_SCAN_ROWS)} rows — too large to restructure in one pass.`,
    };
  }
  const opts: Parameters<typeof active.db.query>[1] = { limit: APPLIER_MAX_SCAN_ROWS };
  if (active.softDeletable.has(table)) opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
  return { rows: (await active.db.query(table, opts)) as Record<string, unknown>[] };
}

// ── canonical_rename ────────────────────────────────────────────────────────

/**
 * Rename a table to a canonical identifier: physical RENAME, the config entry
 * (and its entity context) moved, the live registry re-pointed WITHOUT a reopen,
 * and the shared revertible rename op recorded — so the history page's undo puts
 * it back through the same path the data-model editor's rename uses.
 */
export async function applyRenameTable(
  active: ActiveDb,
  from: string,
  to: string,
  sessionId: string,
): Promise<ApplyOutcome> {
  const refusal = refuseUnreshapable(active, from);
  if (refusal) return fail(refusal);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(to)) return fail(`"${to}" is not a valid table name.`);
  if (from === to) return fail(`"${from}" is already named that.`);
  if (active.validTables.has(to) || active.db.getRegisteredTableNames().includes(to)) {
    return fail(`A table called "${to}" already exists.`);
  }

  return active.db.withSchemaLock(async (): Promise<ApplyOutcome> => {
    const doc = loadConfigDoc(active.configPath);
    const entityDef: unknown = doc.getIn(['entities', from]);
    if (entityDef === undefined) {
      return fail(`"${from}" is not declared in this workspace's configuration.`);
    }
    await execSql(active.db, `ALTER TABLE "${from}" RENAME TO "${to}"`);
    doc.deleteIn(['entities', from]);
    doc.setIn(['entities', to], entityDef);
    const ctxDef: unknown = doc.getIn(['entityContexts', from]);
    if (ctxDef !== undefined) {
      doc.deleteIn(['entityContexts', from]);
      doc.setIn(['entityContexts', to], ctxDef);
    }
    saveConfigDoc(active.configPath, doc);

    // Re-point the live workspace (no reopen): the registry, the allowlists, and
    // the rendered-context index all key on the table name.
    const parsed = parseConfigFile(active.configPath);
    const entry = parsed.tables.find((t) => t.name === to);
    if (!entry) return fail(`"${to}" could not be re-registered after the rename.`);
    active.db.unregisterTable(from);
    await active.db.defineLate(to, entry.definition);
    for (const set of [
      active.validTables,
      active.softDeletable,
      active.junctionTables,
      active.hiddenLinkTables,
    ]) {
      if (set.delete(from)) set.add(to);
    }
    active.entityContextByTable.delete(from);
    refreshCanonicalContexts(active);

    await recordSchemaOp(
      active,
      'schema.rename_entity',
      to,
      { entity: from },
      { entity: to },
      `Renamed table ${from} → ${to}`,
      sessionId,
    );
    return { ok: true };
  });
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

  const created = await createEntity(dimTable, ['name']);
  if (!created) return fail(`Could not create a "${dimTable}" object for the extracted values.`);
  const fkColumn = `${created}_id`;
  if (await physicalColumnExists(active, table, fkColumn)) {
    return fail(`"${table}" already has a "${fkColumn}" column.`);
  }

  const mctx = mutationCtx(active, sessionId);

  // One dimension row per distinct value, reusing any row that already carries
  // that name (the target table may pre-exist from an earlier partial run).
  const existing = (await active.db.query(created, {
    limit: MAX_DIMENSION_VALUES + 1,
    ...(active.softDeletable.has(created)
      ? { filters: [{ col: 'deleted_at', op: 'isNull' }] }
      : {}),
  })) as Record<string, unknown>[];
  if (existing.length > MAX_DIMENSION_VALUES) {
    // Reusing a table this large would silently create duplicates for the
    // values beyond the read — refuse instead.
    return fail(`"${created}" already exists and is too large to reuse as a category list.`);
  }
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
 *    old, rename into place.
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
): string[] {
  const t = `"${table}"`;
  const c = `"${column}"`;
  const tmp = `"${tempColumn}"`;
  if (dialect === 'postgres') {
    return [`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${sqlType} USING (${c}::${sqlType})`];
  }
  return [
    `ALTER TABLE ${t} ADD COLUMN ${tmp} ${sqlType}`,
    `UPDATE ${t} SET ${tmp} = CAST(${c} AS ${sqlType})`,
    `ALTER TABLE ${t} DROP COLUMN ${c}`,
    `ALTER TABLE ${t} RENAME COLUMN ${tmp} TO ${c}`,
  ];
}

/**
 * Canonicalize one stored value for the target type, or report why it can't be.
 * Conversion happens HERE, in the app layer, rather than being left to the SQL
 * cast: SQLite's `CAST('lots' AS INTEGER)` yields 0 instead of failing, which
 * would turn a retype into silent data corruption.
 */
function canonicalizeForType(
  raw: unknown,
  type: string,
): { value: string | null } | { problem: string } {
  const text = cellText(raw);
  if (text === null) return { value: null };
  if (text === undefined) return { problem: 'a structured value' };
  const s = text.trim();
  if (s === '') return { value: null };
  switch (type) {
    case 'integer': {
      const n = Number(s.replace(/[\s,$%]/g, ''));
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { problem: s };
      return { value: String(n) };
    }
    case 'real': {
      const n = Number(s.replace(/[\s,$%]/g, ''));
      if (!Number.isFinite(n)) return { problem: s };
      return { value: String(n) };
    }
    case 'boolean': {
      const l = s.toLowerCase();
      if (['1', 'true', 't', 'yes', 'y'].includes(l)) return { value: '1' };
      if (['0', 'false', 'f', 'no', 'n'].includes(l)) return { value: '0' };
      return { problem: s };
    }
    case 'date':
    case 'datetime': {
      if (Number.isNaN(Date.parse(s))) return { problem: s };
      return { value: s };
    }
    default:
      return { value: s };
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

  const read = await readAllRows(active, table);
  if ('error' in read) return fail(read.error);

  // Verify the WHOLE column before touching anything — a retype that silently
  // zeroes the values it couldn't parse is worse than a declined one.
  const rewrite: { id: string; value: string | null }[] = [];
  const problems: string[] = [];
  for (const row of read.rows) {
    const out = canonicalizeForType(row[column], target);
    if ('problem' in out) {
      if (problems.length < 5) problems.push(out.problem);
      continue;
    }
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

  return active.db.withSchemaLock(async (): Promise<ApplyOutcome> => {
    // Normalize the stored text FIRST so the engine's own cast below is a pure
    // representation change with nothing left to parse. Every value was proven
    // convertible above, and each write is the canonical spelling of the value
    // it replaces — so if the DDL that follows fails, the error surfaces, the
    // declared type is unchanged, and no value has been lost.
    for (const r of rewrite) {
      await active.db.update(table, r.id, { [column]: r.value });
    }

    const dialect = active.db.getDialect();
    const physicalChanges = sqlType !== storageClassFor(currentType ?? 'text');
    // A cloud's per-table mask view selects from the base table, and Postgres
    // refuses to alter a column a view depends on — drop it around the change
    // and regenerate from the column policy afterwards.
    const hasMaskView = dialect === 'postgres' && (await cloudRlsInstalled(active.db));
    if (physicalChanges) {
      if (hasMaskView) await execSql(active.db, `DROP VIEW IF EXISTS "${table}_v"`);
      for (const sql of retypeSql(dialect, table, column, sqlType, tempColumn)) {
        await execSql(active.db, sql);
      }
    }

    const doc = loadConfigDoc(active.configPath);
    if (doc.getIn(['entities', table, 'fields', column]) === undefined) {
      return fail(`"${table}.${column}" is not declared in this workspace's configuration.`);
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
