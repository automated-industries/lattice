import type { Row } from '../types.js';
import type { Lattice } from '../lattice.js';
import type { ComputedTableDef, ComputedFieldDef } from '../config/types.js';
import { compileComputedTable, computedTableOrder } from '../schema/computed-table.js';
import type { CompiledComputedTable, ComputedSchemaTable } from '../schema/computed-table.js';
import {
  ensureAiTables,
  runComputedFill,
  purgeAiField,
  readComputedState,
  countPending,
  recordComputedTableError,
  clearComputedTableError,
  COMPUTED_STATE_TABLE,
} from '../schema/computed-fill.js';
import type { ComputedFieldState, FieldFillResult } from '../schema/computed-fill.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { isNativeEntity, isInternalNativeEntity } from '../framework/native-entities.js';
import { memberGroupFor } from '../cloud/rls.js';
import { publishSharedSchema } from '../cloud/shared-schema.js';
import { loadConfigDoc, saveConfigDoc } from './config-io.js';
import { recordSchemaAudit, type AuditEntry } from './mutations.js';
import {
  recordLineage,
  ensureLineageTable,
  LINEAGE_TABLE,
  type LineageEdge,
} from './lineage-store.js';
import { buildComputedFillLlm } from './computed-llm.js';
import type { ActiveDb } from './active-db.js';

/**
 * Runtime computed-table mutation primitives — the audited surface behind the
 * GUI's computed-table builder (create / update / delete / preview / refresh).
 * Mirrors `schema-ops.ts` (createUserEntity is the sibling pattern): validate →
 * DDL + live-register through the core registration path → persist to the
 * config YAML → cloud securing → revertible `schema.*` audit op. Every mutation
 * is **no-reopen**: the core's live registration keeps the captured
 * `db`/`feed`/`validTables` of any in-flight context valid.
 *
 * The compile/DDL/registration work itself lives in the core
 * (`schema/computed-table.ts` via `Lattice.registerComputedTablesLive`) and the
 * AI materialization in `schema/computed-fill.ts` — this module only sequences
 * those primitives and owns the GUI-side bookkeeping (YAML, lineage, audit,
 * cloud grants).
 *
 * Audit note: ops here record through {@link recordSchemaAudit} directly rather
 * than schema-ops' `recordSchemaOp` wrapper (which would form an import cycle —
 * schema-ops imports {@link assertNotComputedSource} from here). The only
 * difference is the wrapper's trailing `emitDdlEnvelope` call, which is an
 * intentionally-empty hook.
 */

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * The workspace's computed-table definitions, from the config YAML — the
 * canonical store (mirrors how entity definitions live in `entities:`).
 * Declaration order is preserved.
 */
function loadComputedDefs(configPath: string): Record<string, ComputedTableDef> {
  const cfg = loadConfigDoc(configPath).toJS() as {
    computed?: Record<string, ComputedTableDef>;
  } | null;
  return cfg?.computed ?? {};
}

/**
 * `name` plus every computed table transitively built ON it (by `base`
 * chains), in topological order (dependencies first). Computed tables register
 * with no relations, so `base` is the only computed→computed edge.
 */
function affectedInTopoOrder(defs: Record<string, ComputedTableDef>, name: string): string[] {
  const affected = new Set<string>([name]);
  // Fixed-point closure over direct base edges (defs are acyclic — the parser
  // and the compiler both reject cycles — so this terminates).
  for (;;) {
    let grew = false;
    for (const [n, d] of Object.entries(defs)) {
      if (!affected.has(n) && affected.has(d.base)) {
        affected.add(n);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return computedTableOrder(defs).filter((n) => affected.has(n));
}

/** The member group to grant on a secured team cloud the owner manages; else null. */
async function securedCloudGroup(db: Lattice): Promise<string | null> {
  if (db.getDialect() !== 'postgres') return null;
  if (!((await cloudRlsInstalled(db)) && (await canManageRoles(db)))) return null;
  return memberGroupFor(db);
}

/**
 * Cloud securing for a computed VIEW: grant the member group SELECT and
 * republish the shared schema so members hydrate the definition. A view can
 * NEVER take the table-RLS securing path (`secureNewCloudTable`) — RLS cannot
 * be enabled on a view; row filtering is compiled INTO the view via
 * `lattice_row_visible` predicates by the core registration.
 */
async function secureComputedViewsIfCloud(active: ActiveDb, views: string[]): Promise<void> {
  const group = await securedCloudGroup(active.db);
  if (!group) return;
  for (const view of views) {
    await runAsyncOrSync(
      active.db.adapter,
      `GRANT SELECT ON "${view.replace(/"/g, '""')}" TO ${group}`,
    );
  }
  await publishSharedSchema(active.db, active.configPath);
}

/** Does a physical relation (table OR view) with this name exist in the DB? */
async function physicalRelationExists(db: Lattice, name: string): Promise<boolean> {
  if (db.getDialect() === 'postgres') {
    const row = (await getAsyncOrSync(db.adapter, `SELECT to_regclass(?) AS reg`, [name])) as
      | { reg?: string | null }
      | undefined;
    return row?.reg != null;
  }
  const row = await getAsyncOrSync(
    db.adapter,
    `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
    [name],
  );
  return row != null;
}

/**
 * Stable identity of an AI field's DEFINITION — the parts whose change
 * invalidates its materialized cache (prompt, labels, model, inputs, kind).
 * Null for non-AI kinds.
 */
function aiFieldIdentity(f: ComputedFieldDef): string | null {
  if (f.kind === 'ai_classify') {
    return JSON.stringify({
      kind: f.kind,
      input: f.input,
      prompt: f.prompt,
      labels: f.labels,
      model: f.model ?? 'default',
    });
  }
  if (f.kind === 'ai_transform') {
    return JSON.stringify({
      kind: f.kind,
      inputs: f.inputs,
      prompt: f.prompt,
      model: f.model ?? 'default',
    });
  }
  return null;
}

/**
 * Purge the materialized cache of exactly the AI fields whose DEFINITION
 * changed or vanished between `oldDef` and `newDef` — an unchanged field keeps
 * its cache (reads stay warm), a changed one re-derives on the next fill.
 */
async function purgeChangedAiFields(
  db: Lattice,
  name: string,
  oldDef: ComputedTableDef,
  newDef: ComputedTableDef,
): Promise<void> {
  for (const [field, oldField] of Object.entries(oldDef.fields)) {
    const oldId = aiFieldIdentity(oldField);
    if (oldId === null) continue;
    const newField = newDef.fields[field];
    const newId = newField ? aiFieldIdentity(newField) : null;
    if (newId !== oldId) await purgeAiField(db.adapter, `${name}.${field}`);
  }
}

/**
 * Replace the table's `computed_from` lineage with edges derived from the
 * CURRENT compiled definition: one `sql_source` edge per source table and one
 * `calculation` edge per AI field. A re-definition re-derives the edges, so a
 * dropped source never lingers in provenance.
 */
async function refreshComputedLineage(
  db: Lattice,
  name: string,
  def: ComputedTableDef,
  compiled: CompiledComputedTable,
): Promise<void> {
  await ensureLineageTable(db.adapter);
  await runAsyncOrSync(
    db.adapter,
    `DELETE FROM "${LINEAGE_TABLE}" WHERE "object_table" = ? AND "tier" = 'computed' AND "relation" = 'computed_from'`,
    [name],
  );
  const edges: LineageEdge[] = compiled.sources.map((src) => ({
    objectTable: name,
    objectId: '*',
    sourceKind: 'sql_source',
    sourceTable: src,
    tier: 'computed',
    relation: 'computed_from',
  }));
  for (const [field, fdef] of Object.entries(def.fields)) {
    if (fdef.kind !== 'ai_classify' && fdef.kind !== 'ai_transform') continue;
    edges.push({
      objectTable: name,
      objectId: '*',
      sourceKind: 'calculation',
      tier: 'computed',
      relation: 'computed_from',
      detailJson: JSON.stringify({ field, kind: fdef.kind, model: fdef.model ?? 'default' }),
    });
  }
  await recordLineage(db.adapter, edges);
}

/** Drop the table's `computed_from` lineage (the table is being deleted). */
async function dropComputedLineage(db: Lattice, name: string): Promise<void> {
  await ensureLineageTable(db.adapter);
  await runAsyncOrSync(
    db.adapter,
    `DELETE FROM "${LINEAGE_TABLE}" WHERE "object_table" = ? AND "tier" = 'computed' AND "relation" = 'computed_from'`,
    [name],
  );
}

/**
 * Kick the AI fill for a freshly (re)registered computed table —
 * fire-and-forget, never an unhandled rejection. The fill engine records
 * per-field progress/errors in `__lattice_computed_state` itself; only an
 * infrastructure failure (DB unreachable) throws out of it, and that is
 * surfaced into the same state table under field `'*'` plus the server log.
 */
function kickComputedFill(active: ActiveDb, compiled: CompiledComputedTable): void {
  if (compiled.aiFields.length === 0) return;
  const llm = active.computedFillLlm ? active.computedFillLlm() : buildComputedFillLlm(active.db);
  void runComputedFill(active.db.adapter, llm, compiled).catch(async (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[computed] background fill for "${compiled.viewName}" failed: ${msg}`);
    try {
      await recordComputedTableError(
        active.db.adapter,
        compiled.viewName,
        `background fill failed: ${msg}`,
      );
    } catch (stateErr) {
      console.error(
        '[computed] recording the fill failure also failed:',
        (stateErr as Error).message,
      );
    }
  });
}

/** Record a computed-table schema op to the unified history + activity feed. */
async function recordComputedOp(
  active: ActiveDb,
  operation: string,
  table: string,
  before: unknown,
  after: unknown,
  summary: string,
  sessionId: string | undefined,
): Promise<void> {
  await recordSchemaAudit(
    active.db,
    active.feed,
    table,
    operation,
    before,
    after,
    summary,
    'gui',
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// Internal appliers — the un-audited state transitions
// ---------------------------------------------------------------------------
// The public ops below are `validate → apply → audit`; undo/redo replays the
// SAME appliers via {@link applyComputedSchemaOp} without recording a new
// audit entry (an undo flips the existing entry's flag — it is not a new op).

/**
 * Create the computed table: register through the core path (compile →
 * bookkeeping ensure → view DDL → introspect → live-register), persist the
 * definition to the config YAML, track it in the active sets, refresh lineage,
 * secure it on a cloud, and kick the AI fill. Throws on a registration
 * failure, with the never-created table's error state cleaned up.
 */
async function applyCreateComputed(
  active: ActiveDb,
  name: string,
  def: ComputedTableDef,
): Promise<CompiledComputedTable> {
  const result = await active.db.registerComputedTablesLive({ [name]: def });
  const failure = result.errors[0];
  if (failure) {
    // The registration records failures under field '*' so an OPEN-time error
    // is inspectable — but this table was never created, so a rejected create
    // must not leave a state row behind for a nonexistent table.
    await clearComputedTableError(active.db.adapter, name);
    throw new Error(failure.error);
  }
  const compiled = result.compiled.get(name);
  if (!compiled) throw new Error(`computed table "${name}" registered without compiled output`);

  const doc = loadConfigDoc(active.configPath);
  doc.setIn(['computed', name], def);
  saveConfigDoc(active.configPath, doc);

  active.validTables.add(name);
  active.computedTables.add(name);
  await refreshComputedLineage(active.db, name, def, compiled);
  await secureComputedViewsIfCloud(active, [name]);
  kickComputedFill(active, compiled);
  return compiled;
}

/**
 * Delete the computed table: refuse while other computed tables are built on
 * it, drop the view, unregister it, remove the definition from the YAML, purge
 * its AI cache + fill state, and drop its lineage. Returns the removed
 * definition (the audit `before` payload — its revert re-creates).
 */
async function applyDeleteComputed(active: ActiveDb, name: string): Promise<ComputedTableDef> {
  const defs = loadComputedDefs(active.configPath);
  const def = defs[name];
  if (!def || !active.computedTables.has(name)) {
    throw new Error(`Unknown computed table "${name}"`);
  }
  const dependents = affectedInTopoOrder(defs, name).filter((n) => n !== name);
  if (dependents.length > 0) {
    throw new Error(
      `Cannot delete computed table "${name}" — ${
        dependents.length === 1 ? 'computed table' : 'computed tables'
      } ${dependents.join(', ')} ${dependents.length === 1 ? 'is' : 'are'} built on it. Delete or repoint ${
        dependents.length === 1 ? 'it' : 'them'
      } first.`,
    );
  }

  await runAsyncOrSync(active.db.adapter, `DROP VIEW IF EXISTS "${name.replace(/"/g, '""')}"`);
  active.db.unregisterComputedTable(name);

  const doc = loadConfigDoc(active.configPath);
  doc.deleteIn(['computed', name]);
  saveConfigDoc(active.configPath, doc);

  // Purge the whole AI cache + fill state for this table. The current
  // definition's fields cover every live cache key (renamed/removed fields
  // were purged by the update that changed them); the state delete also clears
  // any table-level `'*'` error row.
  for (const [field, fdef] of Object.entries(def.fields)) {
    if (fdef.kind === 'ai_classify' || fdef.kind === 'ai_transform') {
      await purgeAiField(active.db.adapter, `${name}.${field}`);
    }
  }
  try {
    await runAsyncOrSync(
      active.db.adapter,
      `DELETE FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = ?`,
      [name],
    );
  } catch (e) {
    // The state table only exists once AI bookkeeping was ensured; a workspace
    // that never had AI fields has nothing to clear.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table|does not exist/i.test(msg)) throw e;
  }
  await dropComputedLineage(active.db, name);

  active.validTables.delete(name);
  active.computedTables.delete(name);

  // Members hydrate the published layout — republish so the deleted definition
  // disappears for them too (no grant to revoke: the DROP took it along).
  const group = await securedCloudGroup(active.db);
  if (group) await publishSharedSchema(active.db, active.configPath);
  return def;
}

/**
 * Update the computed table's definition: validate the recompile FIRST (no
 * destructive work on a bad definition), then drop this view and every
 * dependent in reverse-topological order (Postgres refuses dropping a view
 * with dependents), re-register the whole affected set in topological order,
 * purge exactly the AI fields whose definition changed, persist the YAML,
 * refresh lineage, re-secure the recreated views on a cloud, and kick a
 * refill. Returns the previous definition + the new compiled output.
 */
async function applyUpdateComputed(
  active: ActiveDb,
  name: string,
  def: ComputedTableDef,
): Promise<{ oldDef: ComputedTableDef; compiled: CompiledComputedTable }> {
  const defs = loadComputedDefs(active.configPath);
  const oldDef = defs[name];
  if (!oldDef || !active.computedTables.has(name)) {
    throw new Error(`Unknown computed table "${name}"`);
  }
  const newDefs = { ...defs, [name]: def };
  const affected = affectedInTopoOrder(newDefs, name);

  // Validation pass: compile the whole affected set against the live schema
  // (with the affected names excluded — re-registering an existing name is not
  // a collision) so a bad definition is rejected BEFORE any view is dropped.
  {
    const schema = active.db.computedSchemaLookup();
    for (const n of affected) schema.delete(n);
    for (const n of affected) {
      const d = newDefs[n];
      if (!d) continue;
      const compiled = compileComputedTable(n, d, schema, active.db.getDialect());
      schema.set(n, {
        columns: new Set(compiled.columns),
        relations: {},
        primaryKey: ['id'],
        hasDeletedAt: false,
        fieldTypes: compiled.fieldTypes,
      });
    }
  }

  // Drop dependents first (reverse topo), then re-register the set in topo
  // order through the core path.
  for (const n of [...affected].reverse()) {
    await runAsyncOrSync(active.db.adapter, `DROP VIEW IF EXISTS "${n.replace(/"/g, '""')}"`);
    active.db.unregisterComputedTable(n);
  }
  const toRegister: Record<string, ComputedTableDef> = {};
  for (const n of affected) {
    const d = newDefs[n];
    if (d) toRegister[n] = d;
  }
  const result = await active.db.registerComputedTablesLive(toRegister);
  const failure = result.errors[0];
  if (failure) {
    // Validated above, so only an infrastructure failure lands here. The
    // engine has recorded the per-table error state; the YAML still holds the
    // previous definitions, so the next open rebuilds from those.
    throw new Error(`re-registering computed tables failed: ${failure.error}`);
  }
  const compiled = result.compiled.get(name);
  if (!compiled) throw new Error(`computed table "${name}" re-registered without compiled output`);

  await purgeChangedAiFields(active.db, name, oldDef, def);

  const doc = loadConfigDoc(active.configPath);
  doc.setIn(['computed', name], def);
  saveConfigDoc(active.configPath, doc);
  for (const n of affected) {
    active.validTables.add(n);
    active.computedTables.add(n);
  }

  await refreshComputedLineage(active.db, name, def, compiled);
  // Every affected view was dropped + recreated, which destroyed its grants —
  // re-secure them all, not just the edited one.
  await secureComputedViewsIfCloud(active, affected);
  kickComputedFill(active, compiled);
  return { oldDef, compiled };
}

// ---------------------------------------------------------------------------
// Public ops — validate → apply → audit
// ---------------------------------------------------------------------------

/**
 * Create a computed table from the GUI. Validates the name against the same
 * rules the entity-creation route applies (identifier grammar, native-entity
 * and live-table collisions, and a physical table/view of the same name —
 * including a soft-deleted one, which must be reverted or purged instead of
 * silently shadowed), then runs the full create flow and records the
 * revertible `schema.create_computed` op.
 */
export async function createComputedTable(
  active: ActiveDb,
  name: string,
  def: ComputedTableDef,
  sessionId: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error('Computed-table name must be a valid identifier');
  }
  if (trimmed === 'files' || isNativeEntity(trimmed)) {
    throw new Error(`"${trimmed}" is a built-in name and cannot be used`);
  }
  if (active.validTables.has(trimmed) || active.db.getRegisteredTableNames().includes(trimmed)) {
    throw new Error(`A table named "${trimmed}" already exists`);
  }
  if (await physicalRelationExists(active.db, trimmed)) {
    throw new Error(
      `A deleted table or view named "${trimmed}" still exists — revert it or purge it first.`,
    );
  }
  await applyCreateComputed(active, trimmed, def);
  await recordComputedOp(
    active,
    'schema.create_computed',
    trimmed,
    null,
    { name: trimmed, def },
    `Created computed table ${trimmed}`,
    sessionId,
  );
}

/**
 * Update a computed table's definition — recompile (dependents recreated in
 * order), selective AI-cache purge, YAML persist, and the revertible
 * `schema.update_computed` op (before/after definitions).
 */
export async function updateComputedTable(
  active: ActiveDb,
  name: string,
  def: ComputedTableDef,
  sessionId: string,
): Promise<void> {
  const { oldDef } = await applyUpdateComputed(active, name, def);
  await recordComputedOp(
    active,
    'schema.update_computed',
    name,
    { name, def: oldDef },
    { name, def },
    `Updated computed table ${name}`,
    sessionId,
  );
}

/**
 * Delete a computed table — refused (loudly, naming them) while other computed
 * tables are built on it. Records the revertible `schema.delete_computed` op;
 * its revert re-creates the view from the captured definition.
 */
export async function deleteComputedTable(
  active: ActiveDb,
  name: string,
  sessionId: string,
): Promise<void> {
  const def = await applyDeleteComputed(active, name);
  await recordComputedOp(
    active,
    'schema.delete_computed',
    name,
    { name, def },
    null,
    `Deleted computed table ${name}`,
    sessionId,
  );
}

/** Result of {@link previewComputedTable}. */
export interface ComputedPreview {
  /** `['id', ...fieldNames]`, in declaration order. */
  columns: string[];
  /** Up to `limit` live rows of the projection. */
  rows: Row[];
  /** The compiled SELECT (for display). */
  sql: string;
  /** Field → canonical display type (includes the projected `id`). */
  fieldTypes: Record<string, string>;
  /**
   * AI field → how many items a fill pass would enqueue for THIS definition
   * right now. The preview compiles under a throwaway name, so the count is a
   * from-scratch estimate — it does not credit values an existing table of the
   * same shape has already materialized.
   */
  pendingAi: Record<string, number>;
}

/**
 * Dry-run a computed-table definition: compile it against the live schema and
 * run the projection with a row cap. Issues NO view DDL, persists nothing, and
 * records no audit entry. (When the definition declares AI fields, the shared
 * `__lattice_ai_*` bookkeeping tables are ensured — a `CREATE TABLE IF NOT
 * EXISTS` no-op everywhere but a fresh workspace — so the view's LEFT JOINs
 * resolve; AI cells read NULL until a real table is created and filled.)
 */
export async function previewComputedTable(
  active: ActiveDb,
  def: ComputedTableDef,
  limit = 50,
): Promise<ComputedPreview> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const schema = active.db.computedSchemaLookup();
  // Throwaway compile name — never DDL'd, only embedded in the returned SQL
  // and the AI cache keys the pending counts probe.
  let name = 'computed_preview';
  for (let i = 2; schema.has(name); i++) name = `computed_preview_${String(i)}`;
  const cloud =
    active.db.getDialect() === 'postgres' && (await cloudRlsInstalled(active.db))
      ? ({ rowVisible: true } as const)
      : undefined;
  const compiled = compileComputedTable(name, def, schema, active.db.getDialect(), cloud);
  if (compiled.aiFields.length > 0) await ensureAiTables(active.db.adapter);
  const rows = await allAsyncOrSync(active.db.adapter, `${compiled.selectSql} LIMIT ${String(n)}`);
  const pendingAi: Record<string, number> = {};
  for (const f of compiled.aiFields) {
    pendingAi[f.field] = await countPending(active.db.adapter, f);
  }
  return {
    columns: compiled.columns,
    rows,
    sql: compiled.selectSql,
    fieldTypes: compiled.fieldTypes,
    pendingAi,
  };
}

/** One progress event of {@link refreshComputedTable}. */
export interface ComputedRefreshProgress {
  phase: 'field' | 'field-done';
  field: string;
  message?: string;
  filled?: number;
  pending?: number;
  error?: string;
}

/**
 * Run the AI fill for a computed table's AI fields (or the `opts.fields`
 * subset), streaming per-field progress through `onProgress`. Runs with the
 * real model adapter (or the ActiveDb's injected one). Records an
 * informational `schema.refresh_computed` audit entry — like `schema.purge`,
 * it appears in history but has no inverse (a refresh only materializes
 * AI-derived cells; there is no prior state to restore).
 */
export async function refreshComputedTable(
  active: ActiveDb,
  name: string,
  opts: { fields?: string[]; sessionId?: string } = {},
  onProgress?: (p: ComputedRefreshProgress) => void,
): Promise<FieldFillResult[]> {
  if (!active.computedTables.has(name)) {
    throw new Error(`Unknown computed table "${name}"`);
  }
  const compiled = active.db.getComputedRegistration()?.compiled.get(name);
  if (!compiled) {
    throw new Error(
      `Computed table "${name}" has no compiled definition — its registration may have failed; fix the definition first`,
    );
  }
  let aiFields = compiled.aiFields;
  if (opts.fields && opts.fields.length > 0) {
    const want = new Set(opts.fields);
    aiFields = compiled.aiFields.filter((f) => want.has(f.field));
    const known = new Set(aiFields.map((f) => f.field));
    const unknown = opts.fields.filter((f) => !known.has(f));
    if (unknown.length > 0) {
      throw new Error(`"${name}" has no AI field named ${unknown.join(', ')}`);
    }
  }
  const llm = active.computedFillLlm ? active.computedFillLlm() : buildComputedFillLlm(active.db);
  const results: FieldFillResult[] = [];
  for (const field of aiFields) {
    onProgress?.({ phase: 'field', field: field.field, message: `Filling ${field.field}…` });
    const report = await runComputedFill(active.db.adapter, llm, {
      ...compiled,
      aiFields: [field],
    });
    const outcome = report.fields[0];
    if (!outcome) continue;
    results.push(outcome);
    onProgress?.({
      phase: 'field-done',
      field: outcome.field,
      filled: outcome.filled,
      pending: outcome.pending,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
  }
  await recordComputedOp(
    active,
    'schema.refresh_computed',
    name,
    null,
    {
      name,
      fields: results.map(({ field, status, filled, pending }) => ({
        field,
        status,
        filled,
        pending,
      })),
    },
    `Refreshed computed table ${name}`,
    opts.sessionId,
  );
  return results;
}

/** One computed table's definition + per-field fill state. */
export interface ComputedTableInfo {
  name: string;
  def: ComputedTableDef;
  state: ComputedFieldState[];
}

/**
 * The workspace's computed tables (declaration order) with each one's
 * per-field fill/error state. State reads are tolerant of a workspace that
 * never created the bookkeeping table and of a scoped cloud member (no SELECT
 * grant on `__lattice_*` bookkeeping) — those simply report no state; a
 * genuine fault still surfaces.
 */
export async function listComputedTables(active: ActiveDb): Promise<ComputedTableInfo[]> {
  const defs = loadComputedDefs(active.configPath);
  const out: ComputedTableInfo[] = [];
  for (const [name, def] of Object.entries(defs)) {
    let state: ComputedFieldState[] = [];
    try {
      state = await readComputedState(active.db.adapter, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such table|does not exist|permission denied/i.test(msg)) throw err;
    }
    out.push({ name, def, state });
  }
  return out;
}

/** One field-source candidate for the computed-table builder's pickers. */
export interface ReachableField {
  /**
   * The reference as a definition would write it: a bare column (`'status'`),
   * a dotted belongsTo path (`'assignee.team.name'`), or an aggregate `via`
   * (`'ticket_tags.tag'`).
   */
  path: string;
  /** Canonical display type of the referenced column; `'aggregate'` for a via. */
  type: string;
  /** How the value is reached from the base. */
  via: 'column' | 'relation' | 'aggregate';
}

/** Internal bookkeeping and assistant-storage tables are never picker candidates. */
function offerable(name: string): boolean {
  return (
    !name.startsWith('_lattice_') && !name.startsWith('__lattice_') && !isInternalNativeEntity(name)
  );
}

/**
 * Every reference a computed table on `base` could declare, for the builder's
 * pickers: the base's own columns, dotted belongsTo-path columns (two hops —
 * the depth the docs' examples use), and junction-aggregate `via` targets
 * (tables with exactly ONE belongsTo back to the base, mirroring the
 * compiler's unambiguity rule). Throws for an unknown or junction base (the
 * route maps that to 400).
 */
export function reachableFields(active: ActiveDb, base: string): ReachableField[] {
  const schema = active.db.computedSchemaLookup();
  const shape = schema.get(base);
  if (!shape || !offerable(base)) throw new Error(`Unknown base table "${base}"`);
  if (active.junctionTables.has(base)) {
    throw new Error(`"${base}" is a relationship table and cannot be a computed-table base`);
  }
  const out: ReachableField[] = [];
  const addColumns = (
    prefix: string,
    t: ComputedSchemaTable | undefined,
    via: 'column' | 'relation',
  ): void => {
    if (!t) return;
    for (const col of t.columns) {
      if (col === 'deleted_at') continue; // soft-delete bookkeeping — folded by the compiler
      out.push({ path: `${prefix}${col}`, type: t.fieldTypes?.[col] ?? 'text', via });
    }
  };
  addColumns('', shape, 'column');
  for (const [relName, rel] of Object.entries(shape.relations)) {
    if (!offerable(rel.table)) continue;
    const child = schema.get(rel.table);
    addColumns(`${relName}.`, child, 'relation');
    for (const [relName2, rel2] of Object.entries(child?.relations ?? {})) {
      if (!offerable(rel2.table)) continue;
      addColumns(`${relName}.${relName2}.`, schema.get(rel2.table), 'relation');
    }
  }
  for (const [jName, jShape] of schema) {
    if (jName === base || !offerable(jName)) continue;
    const legs = Object.entries(jShape.relations);
    const baseLegs = legs.filter(([, r]) => r.table === base);
    if (baseLegs.length !== 1) continue; // none, or ambiguous — the compiler refuses those
    for (const [relName, r] of legs) {
      if (relName === baseLegs[0]?.[0] || !offerable(r.table)) continue;
      out.push({ path: `${jName}.${relName}`, type: 'aggregate', via: 'aggregate' });
    }
  }
  return out;
}

/**
 * Refuse a structural change to `table` (delete, rename) while any computed
 * table reads from it — a computed table's sources are load-bearing SQL
 * references, and a cascade would silently destroy user-defined projections.
 * Sources come from the compiled artifacts when available (base + joined +
 * junction + remote tables); a definition that failed to compile still guards
 * its declared base.
 */
export function assertNotComputedSource(active: ActiveDb, table: string): void {
  const defs = loadComputedDefs(active.configPath);
  if (Object.keys(defs).length === 0) return;
  const compiled = active.db.getComputedRegistration()?.compiled;
  const dependents = Object.entries(defs)
    .filter(([name, def]) => (compiled?.get(name)?.sources ?? [def.base]).includes(table))
    .map(([name]) => name);
  if (dependents.length > 0) {
    throw new Error(
      `Cannot change "${table}" — ${
        dependents.length === 1 ? 'computed table' : 'computed tables'
      } ${dependents.join(', ')} read${dependents.length === 1 ? 's' : ''} from it. Delete or update ${
        dependents.length === 1 ? 'it' : 'them'
      } first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/** Audit payload shape for the computed-table schema ops. */
interface ComputedOpPayload {
  name: string;
  def: ComputedTableDef;
}

function parsePayload(json: string | null, entry: AuditEntry): ComputedOpPayload {
  if (!json) {
    throw new Error(`Cannot revert ${entry.operation}: the audit entry carries no definition`);
  }
  return JSON.parse(json) as ComputedOpPayload;
}

/**
 * Apply the inverse (undo/revert) or forward (redo) of a computed-table schema
 * audit entry — create⁻¹ = delete, delete⁻¹ = create(before), update⁻¹ =
 * update(before). Replays the same live appliers the public ops use, so no
 * reopen is needed and the caller keeps the SAME ActiveDb. A refresh entry is
 * informational and has no inverse — reverting it throws (mirroring
 * `schema.purge`).
 */
export async function applyComputedSchemaOp(
  active: ActiveDb,
  entry: AuditEntry,
  direction: 'inverse' | 'forward',
): Promise<void> {
  const inv = direction === 'inverse';
  switch (entry.operation) {
    case 'schema.create_computed': {
      const p = parsePayload(entry.after_json, entry);
      if (inv) await applyDeleteComputed(active, p.name);
      else await applyCreateComputed(active, p.name, p.def);
      break;
    }
    case 'schema.update_computed': {
      const p = parsePayload(inv ? entry.before_json : entry.after_json, entry);
      await applyUpdateComputed(active, p.name, p.def);
      break;
    }
    case 'schema.delete_computed': {
      const p = parsePayload(entry.before_json, entry);
      if (inv) await applyCreateComputed(active, p.name, p.def);
      else await applyDeleteComputed(active, p.name);
      break;
    }
    case 'schema.refresh_computed':
      throw new Error(
        'A computed-table refresh only fills AI-derived fields — there is nothing to revert.',
      );
    default:
      throw new Error(`Not a computed-table schema op: ${entry.operation}`);
  }
}

/** The computed-table schema ops {@link applyComputedSchemaOp} handles. */
export function isComputedSchemaOp(operation: string): boolean {
  return (
    operation === 'schema.create_computed' ||
    operation === 'schema.update_computed' ||
    operation === 'schema.delete_computed' ||
    operation === 'schema.refresh_computed'
  );
}
