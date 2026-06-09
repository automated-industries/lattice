import { parseConfigFile } from '../config/parser.js';
import { deriveCanonicalContexts } from '../framework/canonical-context.js';
import { appendChangeEnvelope } from '../teams/team-core.js';
import { isNativeEntity } from '../framework/native-entities.js';
import { recordSchemaAudit, createRow, deleteRow, type MutationCtx } from './mutations.js';
import { execSql, loadConfigDoc, saveConfigDoc } from './config-io.js';
import { getGuiEntities, type FileJunction } from './data.js';
import type { ActiveDb } from './server.js';

/**
 * Runtime schema-mutation primitives — the shared core behind the GUI's
 * data-model editor, the chat assistant's `create_entity`/`create_relationship`
 * tools, and the ingest pipeline's Context Constructor. This module owns the
 * single creation path: physical-table introspection, the audited + revertible
 * `schema.*` op record (with the cloud `ddl` envelope), canonical-context
 * (re)derivation so a runtime-created table renders without a reopen, and the
 * entity/junction creators. Separated from `server.ts` routing so creation
 * lives in one place and is independently testable.
 *
 * Every creator is **no-reopen** — it registers the new object live via
 * `defineLate`, so the chat loop's captured `db`/`feed`/`validTables` (and any
 * other in-flight mutation context) stay valid. `ActiveDb` is type-only here
 * (the runtime edge is server → schema-ops only; the type import is erased, so
 * there is no runtime cycle).
 */

/** Adapter shape used for raw catalog queries (physical-table introspection). */
type RawAdapter = {
  allAsync?: (sql: string) => Promise<unknown[]>;
  dialect: 'sqlite' | 'postgres';
};

/** All physical user tables in the DB (excludes Lattice-internal `_%` tables). */
async function listPhysicalUserTables(active: ActiveDb): Promise<string[]> {
  const adapter = (active.db as unknown as { _adapter: RawAdapter })._adapter;
  if (!adapter.allAsync) return active.db.getRegisteredTableNames();
  const sql =
    adapter.dialect === 'postgres'
      ? `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '\\_%' ESCAPE '\\' ORDER BY tablename`
      : `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`;
  return ((await adapter.allAsync(sql)) as { name: string }[]).map((r) => r.name);
}

export async function physicalTableExists(active: ActiveDb, name: string): Promise<boolean> {
  return (await listPhysicalUserTables(active)).includes(name);
}

export async function physicalColumnExists(
  active: ActiveDb,
  table: string,
  col: string,
): Promise<boolean> {
  try {
    return (await active.db.introspectColumns(table)).includes(col);
  } catch {
    return false;
  }
}

/** Cloud-only: append a `ddl` change envelope so peers refetch + converge. */
export async function emitDdlEnvelope(active: ActiveDb, table: string | null): Promise<void> {
  const tc = active.teamContext;
  if (!tc) return;
  await appendChangeEnvelope(active.db, {
    team_id: tc.teamId,
    table_name: table,
    pk: null,
    op: 'ddl',
    payload_json: null,
    owner_user_id: tc.myUserId || null,
  });
}

/** Record a schema op to the unified history + activity feed + emit a ddl envelope. */
export async function recordSchemaOp(
  active: ActiveDb,
  operation: string,
  table: string,
  before: unknown,
  after: unknown,
  summary: string,
  sessionId: string,
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
  await emitDdlEnvelope(active, table);
}

/**
 * Register canonical entity contexts for the workspace's CURRENT tables so a
 * table just created at runtime (by the chat assistant or the Context
 * Constructor) renders its `Context/` immediately — the same derivation
 * `openConfig` runs at startup, applied inline after the create (no
 * reopen). Without this, a runtime-created table has no entity context, so its
 * row view shows "No rendered context …" until the next reopen — the gap that
 * made the editor path (which reopens) render but the chat/ingest path not.
 *
 * Re-derives from the freshly-saved YAML and registers a canonical context for
 * any table that lacks one — on BOTH the Lattice schema (so `db.render()`
 * writes the markdown) AND the `entityContextByTable` snapshot the row-context
 * endpoint reads (so the GUI can locate those files). The subsequent row/link
 * mutation's debounced auto-render then writes the markdown. No-op outside
 * workspace mode (autoRender off ⇒ manifest-only `--config`).
 *
 * Re-registers ALL non-explicit (canonical) tables, not just the brand-new one,
 * via the overwrite-capable `redefineEntityContext` — that is what lets a
 * junction's new hasMany rollup appear on the EXISTING tables it links, without
 * a reopen. Never clobbers a context the user declared in config. Best-effort:
 * a context-registration failure must never fail the entity creation itself
 * (which is already persisted + audited).
 *
 * Creation and "make it renderable" are therefore ONE step in every runtime
 * path — closing the inconsistency where only the reopen-based editor rendered.
 */
function syncCanonicalContexts(active: ActiveDb): void {
  if (!active.autoRender) return;
  try {
    const parsed = parseConfigFile(active.configPath);
    // Never clobber a context the user declared in config; re-derive + replace
    // every other (canonical) table's context. Re-registering ALL of them — not
    // just the brand-new one — is what lets a junction's new hasMany rollup
    // appear on the EXISTING tables it links, without a reopen.
    const explicit = new Set(parsed.entityContexts.map((e) => e.table));
    for (const { table, definition } of deriveCanonicalContexts(parsed.tables)) {
      if (explicit.has(table)) continue;
      active.db.redefineEntityContext(table, definition);
      active.entityContextByTable.set(table, definition);
    }
  } catch (e) {
    console.warn('[gui] canonical-context sync failed:', (e as Error).message);
  }
}

/**
 * Materialize a junction table `jName` with two foreign-key columns — the
 * shared core of {@link createFileJunction} and {@link createUserJunction}.
 * Creates the table + registers it live (`defineLate`, no reopen), persists it
 * to config, registers it as a junction, refreshes canonical contexts so the
 * linked tables' rollups render, and records the revertible
 * `schema.create_junction` op. Callers own the (different) validation, naming,
 * and reuse logic; this owns the identical write path.
 */
export async function materializeJunction(
  active: ActiveDb,
  jName: string,
  colA: string,
  refA: string,
  colB: string,
  refB: string,
  summary: string,
  sessionId: string,
): Promise<void> {
  await execSql(
    active.db,
    `CREATE TABLE "${jName}" (id TEXT PRIMARY KEY, "${colA}" TEXT, "${colB}" TEXT)`,
  );
  await active.db.defineLate(jName, {
    columns: { id: 'TEXT PRIMARY KEY', [colA]: 'TEXT', [colB]: 'TEXT' },
  });
  const entityDef = {
    fields: {
      id: { type: 'uuid', primaryKey: true },
      [colA]: { type: 'uuid', ref: refA },
      [colB]: { type: 'uuid', ref: refB },
    },
    outputFile: jName.toUpperCase() + '.md',
  };
  const doc = loadConfigDoc(active.configPath);
  doc.setIn(['entities', jName], entityDef);
  saveConfigDoc(active.configPath, doc);
  active.validTables.add(jName);
  active.junctionTables.add(jName);
  syncCanonicalContexts(active);
  await recordSchemaOp(
    active,
    'schema.create_junction',
    jName,
    null,
    { entity: jName, entityDef },
    summary,
    sessionId,
  );
}

/**
 * Create (or return) the `files ↔ <otherTable>` junction so ingest can link a
 * file to an existing record even when no relationship has been modeled yet.
 * Registered on the live DB via `defineLate` (no reopen — keeps in-flight
 * mutation contexts valid), persisted to config, and recorded as a revertible
 * `schema.create_junction` op. Returns null when `otherTable` can't be linked
 * (native, junction, unknown, or invalid identifier) so the caller falls back
 * to a suggestion. Mirrors the manual data-model "create relationship" path.
 */
export async function createFileJunction(
  active: ActiveDb,
  otherTable: string,
  sessionId: string,
): Promise<FileJunction | null> {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(otherTable)) return null;
  if (otherTable === 'files' || isNativeEntity(otherTable)) return null;
  if (!active.validTables.has(otherTable) || active.junctionTables.has(otherTable)) return null;
  const jName = `files_${otherTable}`;
  const fileFk = 'file_id';
  const otherFk = `${otherTable}_id`;
  // Already present (live this session) — just hand back the mapping.
  if (active.validTables.has(jName) || active.db.getRegisteredTableNames().includes(jName)) {
    return { junction: jName, fileFk, otherTable, otherFk };
  }
  // A soft-deleted twin exists physically — don't clobber it; let the user
  // revert that one instead.
  if (await physicalTableExists(active, jName)) return null;

  await materializeJunction(
    active,
    jName,
    fileFk,
    'files',
    otherFk,
    otherTable,
    `Linked files ↔ ${otherTable}`,
    sessionId,
  );
  return { junction: jName, fileFk, otherTable, otherFk };
}

/** A many-to-many junction between two user tables (for the chat assistant). */
export interface UserJunction {
  junction: string;
  tableA: string;
  aFk: string;
  tableB: string;
  bFk: string;
}

/**
 * Create (or return) a many-to-many junction between two existing first-class
 * tables — the general form of {@link createFileJunction}, used by the chat
 * assistant's `create_relationship` tool. Registered live via `defineLate` (no
 * reopen), persisted to config, recorded as a revertible `schema.create_junction`
 * op. Returns null when either side is native/`files`/secret/a junction/invalid,
 * or when a soft-deleted twin exists. If the junction (in either column order)
 * already exists this session, it's handed back instead of recreated.
 */
export async function createUserJunction(
  active: ActiveDb,
  tableA: string,
  tableB: string,
  sessionId: string,
): Promise<UserJunction | null> {
  const ok = (t: string): boolean =>
    /^[a-z][a-z0-9_]*$/.test(t) &&
    t !== 'files' &&
    !isNativeEntity(t) &&
    active.validTables.has(t) &&
    !active.junctionTables.has(t);
  if (tableA === tableB || !ok(tableA) || !ok(tableB)) return null;
  const aFk = `${tableA}_id`;
  const bFk = `${tableB}_id`;
  const has = (n: string): boolean =>
    active.validTables.has(n) || active.db.getRegisteredTableNames().includes(n);
  // Reuse an existing junction in either column order.
  const forward = `${tableA}_${tableB}`;
  if (has(forward)) return { junction: forward, tableA, aFk, tableB, bFk };
  const reverse = `${tableB}_${tableA}`;
  if (has(reverse))
    return { junction: reverse, tableA: tableB, aFk: bFk, tableB: tableA, bFk: aFk };
  if (await physicalTableExists(active, forward)) return null;

  await materializeJunction(
    active,
    forward,
    aFk,
    tableA,
    bFk,
    tableB,
    `Linked ${tableA} ↔ ${tableB}`,
    sessionId,
  );
  return { junction: forward, tableA, aFk, tableB, bFk };
}

/**
 * Create (or return) a user entity the Context Constructor inferred from an
 * ingested document. Registered on the live DB via `defineLate` (no reopen),
 * persisted to config, and recorded as a revertible `schema.create_entity` op.
 * Columns are sanitized identifiers (capped). Returns the entity name, or null
 * when it can't be created (native/junction/invalid/soft-deleted twin). Mirrors
 * the manual create-entity path; reused by the ingest pipeline.
 */
export async function createUserEntity(
  active: ActiveDb,
  name: string,
  columns: string[],
  sessionId: string,
  opts?: { normalize?: boolean },
): Promise<string | null> {
  // Normalize to snake_case so a natural name from the model ("People", "Sales
  // Leads") becomes a valid identifier ("people", "sales_leads") instead of a
  // silent rejection. The dispatcher returns this canonical name to the model,
  // which then uses it for create_row/link. The data-model editor opts OUT
  // (`normalize:false`) — it already validated and the user may want a
  // capitalized table name, so the typed name is preserved.
  const normalize = opts?.normalize !== false;
  const entity = normalize
    ? name
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
    : name.trim();
  const valid = normalize
    ? /^[a-z][a-z0-9_]*$/.test(entity)
    : /^[a-zA-Z][a-zA-Z0-9_]*$/.test(entity);
  if (!valid) return null;
  if (entity === 'files' || isNativeEntity(entity)) return null;
  // Already present this session — reuse it (the row insert handles the rest).
  if (active.validTables.has(entity) || active.db.getRegisteredTableNames().includes(entity)) {
    return active.validTables.has(entity) && !active.junctionTables.has(entity) ? entity : null;
  }
  if (await physicalTableExists(active, entity)) return null;

  const reserved = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);
  const inferred = columns
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^[a-z][a-z0-9_]*$/.test(c) && !reserved.has(c));
  // Always lead with a `name` column so every inferred entity has a
  // human-readable label slot — it drives the object's card title and the
  // activity-feed bubble (otherwise rows show a bare `#id`). The Context
  // Constructor fills it with the object's label; dedupe in case the model
  // also proposed a `name`.
  const cols = Array.from(new Set(['name', ...inferred])).slice(0, 12);
  const colDdl = cols.map((c) => `, "${c}" TEXT`).join('');
  await execSql(
    active.db,
    `CREATE TABLE "${entity}" (id TEXT PRIMARY KEY${colDdl}, deleted_at TEXT)`,
  );
  await active.db.defineLate(entity, {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ...Object.fromEntries(cols.map((c) => [c, 'TEXT'])),
      deleted_at: 'TEXT',
    },
  });
  const fields: Record<string, unknown> = { id: { type: 'uuid', primaryKey: true } };
  for (const c of cols) fields[c] = { type: 'text' };
  fields.deleted_at = { type: 'text' };
  const entityDef = { fields, outputFile: entity.toUpperCase() + '.md' };
  const doc = loadConfigDoc(active.configPath);
  doc.setIn(['entities', entity], entityDef);
  saveConfigDoc(active.configPath, doc);
  active.validTables.add(entity);
  // The table is created WITH a `deleted_at` column (above), so register it as
  // soft-deletable too — otherwise the assistant's list_rows would surface
  // soft-deleted rows and its delete_row would hard-delete. (Junctions, made
  // without `deleted_at` in materializeJunction, intentionally stay hard.)
  active.softDeletable.add(entity);
  // Same step as creation: register the canonical context so the new table
  // renders without a reopen (the subsequent row inserts' auto-render writes it).
  syncCanonicalContexts(active);
  await recordSchemaOp(
    active,
    'schema.create_entity',
    entity,
    null,
    { entity, entityDef },
    `Created table ${entity}`,
    sessionId,
  );
  return entity;
}

/**
 * Soft-delete a user entity (table) — NO reopen. Removes it from the config and
 * the live registry ({@link import('../lattice.js').Lattice.unregisterTable}) so
 * it stops being listed/queryable, but KEEPS the physical SQL table + its rows
 * so the recorded `schema.delete_entity` op stays fully revertible (the History
 * page re-adds it from the captured `entityDef`). The caller owns all
 * policy/validation (native, ownership, inbound-FK, emptiness/data handling).
 * Mirrors the data-model editor's soft delete, minus the reopen — which is what
 * lets the chat assistant call it mid-turn without invalidating its captured
 * db/feed references.
 */
export async function softDeleteUserEntity(
  active: ActiveDb,
  name: string,
  sessionId: string,
  summary?: string,
): Promise<void> {
  const doc = loadConfigDoc(active.configPath);
  const entityDef = (doc.toJS() as { entities?: Record<string, unknown> }).entities?.[name];
  doc.deleteIn(['entities', name]);
  saveConfigDoc(active.configPath, doc);
  active.db.unregisterTable(name);
  active.validTables.delete(name);
  active.junctionTables.delete(name);
  active.softDeletable.delete(name);
  active.entityContextByTable.delete(name);
  syncCanonicalContexts(active);
  await recordSchemaOp(
    active,
    'schema.delete_entity',
    name,
    { entity: name, entityDef },
    null,
    summary ?? `Deleted table ${name}`,
    sessionId,
  );
}

/** How the assistant should handle a NON-empty table it was asked to delete. */
export type DeleteResolution = 'delete_data' | { move_to: string };

/** Outcome of {@link aiDeleteEntity}. `needsResolution` ⇒ ask the user first. */
export type DeleteEntityOutcome =
  | { ok: true; deleted: string; deletedRows?: number; movedRows?: number }
  | { ok: false; error: string }
  | { needsResolution: true; rowCount: number; message: string };

/** Above this row count, the assistant refuses to auto-delete/move data. */
const AI_DELETE_ROW_CAP = 1000;

/**
 * The assistant's guarded, reversible table delete. Safeguards (so the model
 * can't destroy data on a careless request):
 *   • refuses native/built-in tables, tables the operator doesn't own, and
 *     tables another table still links to (inbound FK);
 *   • EMPTY table → soft-deletes it immediately (reversible);
 *   • NON-empty table with no `resolution` → does NOT delete; returns
 *     `needsResolution` so the assistant asks the user what to do with the data;
 *   • `resolution='delete_data'` → soft-deletes every live row, then the table;
 *   • `resolution={move_to}` → copies each live row into the target table
 *     (best-effort column mapping), soft-deletes the originals, then the table.
 * Every step goes through the audited mutation primitives, so the whole thing is
 * reversible from history. Never drops the physical table (no hard delete).
 */
export async function aiDeleteEntity(
  active: ActiveDb,
  name: string,
  resolution: DeleteResolution | undefined,
  sessionId: string,
): Promise<DeleteEntityOutcome> {
  if (!active.validTables.has(name)) return { ok: false, error: `Unknown table: ${name}` };
  if (isNativeEntity(name)) {
    return { ok: false, error: `"${name}" is a built-in table and cannot be deleted.` };
  }
  const tc = active.teamContext;
  if (tc && tc.owners.get(name) !== tc.myUserId) {
    return { ok: false, error: `Only the table's owner can delete "${name}".` };
  }
  const inbound: string[] = [];
  for (const t of getGuiEntities(active.configPath, active.outputDir).tables) {
    if (t.name === name) continue;
    for (const rel of Object.values(t.relations)) {
      if (rel.type === 'belongsTo' && rel.table === name) {
        inbound.push(`${t.name}.${rel.foreignKey}`);
      }
    }
  }
  if (inbound.length > 0) {
    return {
      ok: false,
      error: `Cannot delete "${name}" — these links point at it: ${inbound.join(', ')}. Remove those links first.`,
    };
  }

  const mctx: MutationCtx = {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    source: 'ai',
  };
  const softDeletable = active.softDeletable.has(name);
  const rowCount = softDeletable
    ? await active.db.count(name, { filters: [{ col: 'deleted_at', op: 'isNull' }] })
    : await active.db.count(name);

  // Empty → safe to remove straight away.
  if (rowCount === 0) {
    await softDeleteUserEntity(active, name, sessionId);
    return { ok: true, deleted: name };
  }

  // Non-empty → require an explicit decision about the data first.
  if (resolution === undefined) {
    return {
      needsResolution: true,
      rowCount,
      message:
        `"${name}" still has ${String(rowCount)} row${rowCount === 1 ? '' : 's'}. Deleting a table ` +
        `with data needs a decision first — ask the user whether to delete the rows too (reversible), ` +
        `move them into another table, or cancel. Then call delete_entity again with ` +
        `resolution="delete_data" or resolution={"move_to":"<table>"}.`,
    };
  }

  if (resolution === 'delete_data') {
    if (!softDeletable) {
      return {
        ok: false,
        error: `"${name}" rows can't be soft-deleted (no deleted_at column) — clear them manually first.`,
      };
    }
    if (rowCount > AI_DELETE_ROW_CAP) {
      return {
        ok: false,
        error: `"${name}" has ${String(rowCount)} rows — too many to auto-delete safely (cap ${String(AI_DELETE_ROW_CAP)}). Trim it first.`,
      };
    }
    const rows = (await active.db.query(name, {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
      limit: AI_DELETE_ROW_CAP,
    })) as Record<string, unknown>[];
    let deletedRows = 0;
    for (const r of rows) {
      await deleteRow(mctx, name, String(r.id), false); // soft delete — reversible
      deletedRows++;
    }
    await softDeleteUserEntity(active, name, sessionId);
    return { ok: true, deleted: name, deletedRows };
  }

  // resolution = { move_to: target }
  const target = resolution.move_to;
  if (!active.validTables.has(target)) {
    return { ok: false, error: `move_to target "${target}" is not a known table.` };
  }
  if (target === name) return { ok: false, error: 'move_to target must be a different table.' };
  if (active.junctionTables.has(target) || isNativeEntity(target)) {
    return { ok: false, error: `Cannot move rows into "${target}".` };
  }
  if (rowCount > AI_DELETE_ROW_CAP) {
    return {
      ok: false,
      error: `"${name}" has ${String(rowCount)} rows — too many to auto-move (cap ${String(AI_DELETE_ROW_CAP)}).`,
    };
  }
  const targetCols = active.db.getRegisteredColumns(target);
  if (!targetCols) return { ok: false, error: `Could not read the columns of "${target}".` };
  const rows = (await active.db.query(
    name,
    softDeletable
      ? { filters: [{ col: 'deleted_at', op: 'isNull' }], limit: AI_DELETE_ROW_CAP }
      : { limit: AI_DELETE_ROW_CAP },
  )) as Record<string, unknown>[];
  const SKIP = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);
  let movedRows = 0;
  for (const r of rows) {
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!SKIP.has(k) && k in targetCols) mapped[k] = v;
    }
    await createRow(mctx, target, mapped); // new id auto-assigned
    if (softDeletable) await deleteRow(mctx, name, String(r.id), false);
    movedRows++;
  }
  await softDeleteUserEntity(active, name, sessionId);
  return { ok: true, deleted: name, movedRows };
}
