import { createHash } from 'node:crypto';
import { parseConfigFile } from '../config/parser.js';
import { deriveCanonicalContexts } from '../framework/canonical-context.js';
import { isNativeEntity } from '../framework/native-entities.js';
import {
  recordSchemaAudit,
  createRow,
  deleteRow,
  updateRow,
  type MutationCtx,
} from './mutations.js';
import { execSql, loadConfigDoc, saveConfigDoc } from './config-io.js';
import { isAnonymousName } from '../import/name-policy.js';
import { isTableRole, type RoleSource, type TableRole } from '../import/roles.js';
import {
  getGuiEntities,
  isJunctionTable,
  type FileJunction,
  type GuiTableSummary,
} from './data.js';
import { assertNotComputedSource } from './computed-ops.js';
import { upsertTableMeta } from './column-descriptions.js';
import { LINEAGE_TABLE } from './lineage-store.js';
import { PLAN_STATE_TABLE } from './planner/plan-state.js';
import type { ShapeOp } from './planner/types.js';
import {
  allAsyncOrSync,
  runAsyncOrSync,
  introspectColumnsAsyncOrSync,
  type StorageAdapter,
} from '../db/adapter.js';
import type { Lattice } from '../lattice.js';
import type { ActiveDb } from './active-db.js';
import { secureNewCloudTable } from '../cloud/setup.js';
import {
  isRowAudience,
  loadColumnPolicy,
  regenerateAudienceViewFromDb,
  regenerateMemberReadView,
  tableNeedsAudienceView,
} from '../cloud/audience.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';

/**
 * Secure a table created at RUNTIME (data-model panel / assistant / ingest) the
 * same way `secureCloud` secures declared tables — otherwise a table made on a
 * secured cloud has RLS OFF (wide open), no ownership trigger, and no member
 * grant. No-op off a secured cloud / when the role can't manage it. internal guideline: a
 * failure surfaces (a silently-unsecured table is a data-exposure bug).
 */
async function secureRuntimeTableIfCloud(
  active: ActiveDb,
  name: string,
  pk: string[],
): Promise<void> {
  const db = active.db;
  if (db.getDialect() !== 'postgres') return;
  if (!((await cloudRlsInstalled(db)) && (await canManageRoles(db)))) return;
  await secureNewCloudTable(db, name, pk);
}

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

/**
 * A live view of a connected external data source (a db-source / Gmail / Jira /
 * … connector table) cannot be reshaped from inside Lattice: its columns and
 * rows are SYNCED from the source, so an ALTER here is dropped on the next sync,
 * and unregistering it just re-registers on the next open. When `table` is such a
 * connected table, return a user-facing message that steers to the right move;
 * otherwise return null. Wording carries no schema jargon so the assistant can
 * relay it verbatim. This mirrors the deterministic "steer, don't just block"
 * refusals already used for computed views and managed native objects.
 */
function connectedSourceSteer(
  active: ActiveDb,
  table: string,
  action: 'add-column' | 'delete',
): string | null {
  const src = active.db.getConnectedSource(table);
  if (!src) return null;
  const label = src.model || table;
  return action === 'add-column'
    ? `"${label}" is a live view of a connected external data source, so its columns come from that source and can't be added to here. To add a field, build a derived (computed) table from "${label}" that adds it, or create a separate object in Lattice and link these records to it.`
    : `"${label}" is a live view of a connected external data source. Remove it by disconnecting that connector (which removes all of its synced tables) — deleting just this table re-syncs it back on the next open.`;
}

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

/**
 * No-op DDL-envelope hook. Peer convergence after a schema change is now driven
 * by Postgres RLS + the database's own change-log; the app layer no longer
 * appends a `ddl` envelope. Retained as a stable call site for the schema-op
 * paths in case envelope emission is rebuilt on the RLS model.
 */
export function emitDdlEnvelope(_active: ActiveDb, _table: string | null): Promise<void> {
  // intentionally empty
  return Promise.resolve();
}

/**
 * Record a schema op to the unified history + activity feed + emit a ddl
 * envelope. Returns the audit-entry id so a caller can wire a one-click undo to
 * exactly this change (the id feeds the per-entry revert route).
 */
export async function recordSchemaOp(
  active: ActiveDb,
  operation: string,
  table: string,
  before: unknown,
  after: unknown,
  summary: string,
  sessionId: string,
): Promise<string> {
  const auditId = await recordSchemaAudit(
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
  return auditId;
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
  // EXCLUSIVITY: between any two tables, a many-to-many junction and a
  // belongsTo nesting cannot coexist — they are two different, conflicting
  // claims about the relationship. Guarded HERE (the single shared write path)
  // so the HTTP route, the assistant's create_relationship, and ingest
  // auto-linking all agree. Wording deliberately does NOT match the clients'
  // duplicate-swallow patterns, so this failure SURFACES.
  if (refA !== refB) {
    const cfgDoc = loadConfigDoc(active.configPath).toJSON() as {
      entities?: Record<string, { relations?: Record<string, { type?: string; table?: string }> }>;
    };
    const nests = (child: string, parent: string): boolean =>
      Object.values(cfgDoc.entities?.[child]?.relations ?? {}).some(
        (r) => r.type === 'belongsTo' && r.table === parent,
      );
    if (nests(refA, refB) || nests(refB, refA)) {
      const child = nests(refA, refB) ? refA : refB;
      const parent = child === refA ? refB : refA;
      throw new Error(
        `"${child}" is nested inside "${parent}" — un-nest it before creating a relationship between them`,
      );
    }
  }
  // IF NOT EXISTS: the callers that reach here concurrently (ingest auto-linking two
  // files to the same new entity) hold the schema lock and re-check existence inside
  // it, so this is the sole creator; the guard just hardens the direct create_relationship
  // path against a repeated click.
  await execSql(
    active.db,
    `CREATE TABLE IF NOT EXISTS "${jName}" (id TEXT PRIMARY KEY, "${colA}" TEXT, "${colB}" TEXT)`,
  );
  await active.db.defineLate(jName, {
    columns: { id: 'TEXT PRIMARY KEY', [colA]: 'TEXT', [colB]: 'TEXT' },
  });
  // Relation names mirror what the removed `ref:` path derived: the FK column
  // with a trailing `_id` stripped. Callers always pass `<table>_id` columns,
  // so this reproduces the exact two relation keys that junction detection
  // (isJunctionTable) expects — two belongsTo relations, no per-field ref.
  const relA = colA.endsWith('_id') ? colA.slice(0, -3) : colA;
  const relB = colB.endsWith('_id') ? colB.slice(0, -3) : colB;
  const entityDef = {
    fields: {
      id: { type: 'uuid', primaryKey: true },
      [colA]: { type: 'uuid' },
      [colB]: { type: 'uuid' },
    },
    relations: {
      [relA]: { type: 'belongsTo', table: refA, foreignKey: colA },
      [relB]: { type: 'belongsTo', table: refB, foreignKey: colB },
    },
    // Hidden .schema-only/ overview (the codebase default), never a root <NAME>.md
    // orphan at the Context root.
    outputFile: '.schema-only/' + jName + '.md',
  };
  const doc = loadConfigDoc(active.configPath);
  doc.setIn(['entities', jName], entityDef);
  saveConfigDoc(active.configPath, doc);
  active.validTables.add(jName);
  active.junctionTables.add(jName);
  syncCanonicalContexts(active);
  // Secure the just-created junction on a cloud (RLS + ownership + grant).
  await secureRuntimeTableIfCloud(active, jName, ['id']);
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
  const mapping: FileJunction = { junction: jName, fileFk, otherTable, otherFk };
  // Already present (live this session) — just hand back the mapping.
  if (active.validTables.has(jName) || active.db.getRegisteredTableNames().includes(jName)) {
    return mapping;
  }
  // Serialize the check-then-materialize: a parallel ingest can auto-link two files
  // to the SAME entity at once, so both would pass the existence check and both
  // CREATE the `files_<entity>` junction (loser throws). The lock makes it atomic;
  // the re-check inside reuses a junction a concurrent caller just created.
  return active.db.withSchemaLock(async () => {
    if (active.validTables.has(jName) || active.db.getRegisteredTableNames().includes(jName)) {
      return mapping;
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
    return mapping;
  });
}

/** Bound an identifier to Postgres's 63-byte limit — a deterministic hash suffix
 *  when it would overflow, so a long name can't silently truncate and collide on
 *  PG (SQLite has no such limit). No-op for the common ≤63-byte case. */
function boundIdentifier(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= 63) return name;
  return name.slice(0, 56) + '_' + createHash('sha1').update(name).digest('hex').slice(0, 6);
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
  // Reuse an existing junction in either column order. The name is BOUNDED to
  // Postgres's 63-byte identifier limit (a hash suffix when two long table names
  // would overflow) so a long pair can't silently truncate + collide — the same
  // hazard bounded for cloud RLS trigger names.
  const forward = boundIdentifier(`${tableA}_${tableB}`);
  const fwdResult: UserJunction = { junction: forward, tableA, aFk, tableB, bFk };
  const revResult: UserJunction = {
    junction: boundIdentifier(`${tableB}_${tableA}`),
    tableA: tableB,
    aFk: bFk,
    tableB: tableA,
    bFk: aFk,
  };
  if (has(forward)) return fwdResult;
  if (has(revResult.junction)) return revResult;
  // Serialize the check-then-materialize (see createFileJunction) — concurrent callers
  // creating the same pair would otherwise both CREATE the junction. Re-check both
  // column orders inside the lock so a concurrent winner is reused, not recreated.
  return active.db.withSchemaLock(async () => {
    if (has(forward)) return fwdResult;
    if (has(revResult.junction)) return revResult;
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
    return fwdResult;
  });
}

/**
 * Declare a belongsTo relationship from `childTable` to `parentTable` over an
 * EXISTING foreign-key column — the "table X references table Y" fix the
 * data-model planner applies. Unlike {@link createUserJunction} (a many-to-many
 * junction TABLE), this is a config-only `relations:` entry over a column that
 * ALREADY holds the FK values: additive, non-data-writing, and reversible via the
 * `schema.add_relation` op (whose inverse removes just the relation, never the
 * column). Contexts refresh live (no reopen — nothing structural changed), exactly
 * like the junction path's relation half. Returns the relation name, or null when
 * the pair can't be related (native/junction/invalid, the column is missing,
 * they're already related, or a junction / opposite nesting already connects them).
 */
export async function createUserRelation(
  active: ActiveDb,
  childTable: string,
  fkColumn: string,
  parentTable: string,
  sessionId: string,
): Promise<{ relationName: string } | null> {
  const ok = (t: string): boolean =>
    /^[a-z][a-z0-9_]*$/.test(t) &&
    t !== 'files' &&
    !isNativeEntity(t) &&
    active.validTables.has(t) &&
    !active.junctionTables.has(t);
  if (childTable === parentTable || !ok(childTable) || !ok(parentTable)) return null;
  if (!/^[a-z_][a-z0-9_]*$/i.test(fkColumn)) return null;
  if (!(fkColumn in (active.db.getRegisteredColumns(childTable) ?? {}))) return null;

  const relName = fkColumn.endsWith('_id') ? fkColumn.slice(0, -3) : fkColumn;
  const relation = { type: 'belongsTo' as const, table: parentTable, foreignKey: fkColumn };

  // Idempotence + exclusivity, evaluated against the freshly-loaded config.
  const conflicts = (): boolean => {
    const cfg = loadConfigDoc(active.configPath).toJSON() as {
      entities?: Record<string, { relations?: Record<string, { type?: string; table?: string }> }>;
    };
    const rels = (t: string): { type?: string; table?: string }[] =>
      Object.values(cfg.entities?.[t]?.relations ?? {});
    if (rels(childTable).some((r) => r.type === 'belongsTo' && r.table === parentTable))
      return true; // already related
    if (rels(parentTable).some((r) => r.type === 'belongsTo' && r.table === childTable))
      return true; // opposite nesting
    if (cfg.entities?.[childTable]?.relations?.[relName] !== undefined) return true; // name clash
    const names = active.db.getRegisteredTableNames();
    return (
      names.includes(`${childTable}_${parentTable}`) ||
      names.includes(`${parentTable}_${childTable}`)
    ); // junction exists
  };

  return active.db.withSchemaLock(async () => {
    if (conflicts()) return null;
    const doc = loadConfigDoc(active.configPath);
    doc.setIn(['entities', childTable, 'relations', relName], relation);
    saveConfigDoc(active.configPath, doc);
    syncCanonicalContexts(active); // re-derive the parent's hasMany rollup + child nesting
    await recordSchemaOp(
      active,
      'schema.add_relation',
      childTable,
      null,
      { entity: childTable, relationName: relName, relation },
      `Related ${childTable} → ${parentTable}`,
      sessionId,
    );
    return { relationName: relName };
  });
}

/**
 * The identifier a natural name becomes when it is created as an entity
 * ("People" → `people`, "Sales Leads" → `sales_leads`), or null when nothing
 * usable is left of it.
 *
 * Exported because a caller that has to answer its refusals BEFORE the table is
 * created needs to know the name the create will land on — sharing this one
 * function is what keeps the predicted name and the created name from ever
 * disagreeing.
 */
export function normalizedEntityName(name: string): string | null {
  const entity = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return /^[a-z][a-z0-9_]*$/.test(entity) ? entity : null;
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
  opts?: { normalize?: boolean; rejectAnonymous?: boolean },
): Promise<string | null> {
  // Normalize to snake_case so a natural name from the model ("People", "Sales
  // Leads") becomes a valid identifier ("people", "sales_leads") instead of a
  // silent rejection. The dispatcher returns this canonical name to the model,
  // which then uses it for create_row/link. The data-model editor opts OUT
  // (`normalize:false`) — it already validated and the user may want a
  // capitalized table name, so the typed name is preserved.
  const normalize = opts?.normalize !== false;
  const entity = normalize ? (normalizedEntityName(name) ?? '') : name.trim();
  const valid = normalize ? entity !== '' : /^[a-zA-Z][a-zA-Z0-9_]*$/.test(entity);
  if (!valid) return null;
  if (entity === 'files' || isNativeEntity(entity)) return null;
  // Serialize the whole check-then-CREATE behind the schema lock. A parallel folder
  // ingest can have two files that both extract the same new entity ("Invoices");
  // without the lock they'd both pass the "not registered" check (the check and the
  // CREATE straddle awaits) and both run CREATE TABLE — the loser throwing "table
  // already exists". Inside the lock the check-then-act is atomic, so the second
  // caller sees the first's just-registered table and reuses it. Reentrant, so the
  // nested addColumn inside secureRuntimeTableIfCloud (cloud) runs inline. Any throw
  // propagates to the caller and releases the lock (withSchemaLock advances on settle).
  // The closure returns whether THIS call created the table (vs reused a concurrent
  // creator's), so the background description hook below fires only on a fresh create.
  const outcome = await active.db.withSchemaLock(
    async (): Promise<{ result: string | null; created: boolean }> => {
      // Already present (this session or created by a concurrent caller that won the
      // lock first) — reuse it (the row insert handles the rest).
      if (active.validTables.has(entity) || active.db.getRegisteredTableNames().includes(entity)) {
        const reuse =
          active.validTables.has(entity) && !active.junctionTables.has(entity) ? entity : null;
        return { result: reuse, created: false };
      }
      // Ingest + chat callers pass `rejectAnonymous` so a purely positional name
      // (`table_1`, `sheet3`, the `field`/`f_<n>` fallbacks) never becomes a real
      // table — the shared name policy enforced as a REFUSED call, not a prompt
      // rule. Placed AFTER the reuse block so an already-registered table (including
      // a workspace 5.1.x seeded with `table_N`) is still returned, not refused. The
      // manual data-model create route leaves it unset, so a user can type any name.
      if (opts?.rejectAnonymous && isAnonymousName(entity)) {
        return { result: null, created: false };
      }
      if (await physicalTableExists(active, entity)) return { result: null, created: false };

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
      // IF NOT EXISTS is belt-and-suspenders under the lock: the checks above already
      // rule out a registered/physical collision, so this create is the sole creator.
      await execSql(
        active.db,
        `CREATE TABLE IF NOT EXISTS "${entity}" (id TEXT PRIMARY KEY${colDdl}, deleted_at TEXT)`,
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
      // Hidden .schema-only/ overview (the codebase default), never a root <NAME>.md
      // orphan at the Context root (which duplicates the per-row <Entity>/ context dir).
      const entityDef = { fields, outputFile: '.schema-only/' + entity + '.md' };
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
      // Secure the just-created table on a cloud (RLS + ownership + mask view + grant)
      // so a runtime-created table isn't left wide open.
      await secureRuntimeTableIfCloud(active, entity, ['id']);
      await recordSchemaOp(
        active,
        'schema.create_entity',
        entity,
        null,
        { entity, entityDef },
        `Created table ${entity}`,
        sessionId,
      );
      return { result: entity, created: true };
    },
  );
  // Auto-generate a one-line table definition in the background (fail-silent; skips
  // native/meta/junction + already-described tables; no-op without auth). Fired OUTSIDE
  // withSchemaLock so this detached fire-and-forget task does not inherit the lock's
  // reentrancy flag (which propagates through AsyncLocalStorage into detached work) —
  // otherwise any DDL it did would wrongly run inline instead of acquiring the lock.
  // Only on a fresh create, never on the reuse path.
  if (outcome.created && outcome.result) active.generateTableDescription?.(outcome.result, columns);
  return outcome.result;
}

/**
 * Add a column to an existing user entity at RUNTIME — no reopen. Mirrors
 * createUserEntity: ALTER + live-register via `db.addColumn` (so later tool calls
 * see it this turn), persist to the config (survives a reopen), rebuild the cloud
 * masking view (so members see it), re-derive canonical context, and record a
 * revertible audit op. Refuses junctions, native objects, and bookkeeping tables.
 * The data layer already auto-adds columns on write (mutations.ensureColumns);
 * this is the explicit, first-class path so the assistant never has to refuse.
 */
export async function addUserColumn(
  active: ActiveDb,
  table: string,
  column: string,
  sessionId: string,
): Promise<{ ok: true; column: string } | { ok: false; error: string }> {
  if (!active.validTables.has(table)) return { ok: false, error: `Unknown table "${table}".` };
  if (active.computedTables.has(table)) {
    return {
      ok: false,
      error: `"${table}" is a computed view — its fields come from its definition, so add the new field there instead.`,
    };
  }
  // A connected external mirror (db-source / Gmail / Jira / …) is synced FROM its
  // source: an ALTER here would be dropped on the next sync. Refuse deterministically
  // and steer, so the assistant relays a correct explanation instead of silently
  // "succeeding" with a dead column (which then confuses it into claiming the table
  // isn't there).
  const connectedAdd = connectedSourceSteer(active, table, 'add-column');
  if (connectedAdd) return { ok: false, error: connectedAdd };
  if (
    active.junctionTables.has(table) ||
    table.startsWith('_lattice_') ||
    table.startsWith('__lattice_') ||
    isNativeEntity(table)
  ) {
    // Deterministic refusal that STEERS rather than just blocks: a managed object
    // (files/secrets/…) can't take new columns, so the right move is to model the
    // new attribute as its own object the records link to — never alter the
    // managed table. The wording is user-facing (no schema jargon) so the
    // assistant can relay it verbatim and follow it.
    const steer = isNativeEntity(table)
      ? `"${table}" is a managed object, so it can't take new columns. To record a new attribute — for example a category like state or status — create a new object for that attribute and link your records to it instead.`
      : `"${table}" is a relationship table, so columns can't be added to it.`;
    return { ok: false, error: steer };
  }
  const col = column
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z][a-z0-9_]*$/.test(col)) {
    return { ok: false, error: `"${column}" is not a valid column name.` };
  }
  if (new Set(['id', 'deleted_at', 'created_at', 'updated_at']).has(col)) {
    return { ok: false, error: `"${col}" is a reserved column.` };
  }
  const existing = active.db.getRegisteredColumns(table);
  if (existing && col in existing) {
    return { ok: false, error: `Column "${col}" already exists on "${table}".` };
  }

  // ALTER + register on the live DB (no reopen) so the column is usable this turn.
  await active.db.addColumn(table, col, 'TEXT');

  // Persist to the config so it survives a reopen — best-effort + only for tables
  // declared in the YAML (introspected / cloud-member tables re-derive on reopen).
  try {
    const doc = loadConfigDoc(active.configPath);
    if (doc.getIn(['entities', table])) {
      doc.setIn(['entities', table, 'fields', col], { type: 'text' });
      saveConfigDoc(active.configPath, doc);
    }
  } catch {
    /* the DB ALTER is the source of truth; config persistence is best-effort */
  }

  // Cloud: the masking view selects an explicit column list, so a new column is
  // invisible to members until the view is regenerated (mirrors ensureColumns).
  if (active.db.getDialect() === 'postgres' && (await cloudRlsInstalled(active.db))) {
    const cols = active.db.getRegisteredColumns(table);
    const pk = active.db.getPrimaryKey(table);
    if (cols && pk.length > 0) {
      await regenerateAudienceViewFromDb(active.db, table, Object.keys(cols), pk);
    }
  }

  syncCanonicalContexts(active);
  await recordSchemaOp(
    active,
    'schema.add_column',
    table,
    null,
    // The revert reads `entity` and `fieldDef` off this payload. Recording only
    // {column,type} left both undefined, so undoing a column add threw instead
    // of removing the column — the op was written in a shape its own reverse
    // could not consume.
    { entity: table, column: col, type: 'text', fieldDef: { type: 'text' } },
    `Added column ${col} to ${table}`,
    sessionId,
  );
  return { ok: true, column: col };
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
): Promise<string> {
  // A computed table is not an entity — it is deleted through its own
  // definition path (deleteComputedTable), never soft-deleted like a table.
  if (active.computedTables.has(name)) {
    throw new Error(
      `"${name}" is a computed table — delete it from its computed-table definition instead.`,
    );
  }
  // A connected external mirror re-registers on the next open — refuse the bare
  // table delete and steer to disconnecting the connector (mirrors aiDeleteEntity).
  const connectedDelete = connectedSourceSteer(active, name, 'delete');
  if (connectedDelete) throw new Error(connectedDelete);
  // Fail loudly (naming the dependents, no cascade) while any computed table
  // still reads from this one — deleting a source would break live projections.
  assertNotComputedSource(active, name);
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
  return recordSchemaOp(
    active,
    'schema.delete_entity',
    name,
    { entity: name, entityDef },
    null,
    summary ?? `Deleted table ${name}`,
    sessionId,
  );
}

/**
 * How the assistant should handle a NON-empty table it was asked to delete.
 *   • `delete_data`    — remove the table's OWN rows, nothing else.
 *   • `delete_cascade` — also remove the rows in other tables that point at it.
 *   • `{ move_to }`    — merge the rows into another table and carry the links across.
 */
export type DeleteResolution = 'delete_data' | 'delete_cascade' | { move_to: string };

/** Outcome of {@link aiDeleteEntity}. `needsResolution` ⇒ ask the user first. */
export type DeleteEntityOutcome =
  | {
      ok: true;
      deleted: string;
      deletedRows?: number;
      movedRows?: number;
      rewiredLinks?: number;
      /** Rows in other tables that pointed here and were removed with it. */
      cascadedLinkRows?: number;
      /** Link tables that existed only to express a relationship with the deleted table. */
      droppedLinkTables?: string[];
    }
  | { ok: false; error: string }
  | { needsResolution: true; rowCount: number; message: string };

/** Above this row count, the assistant refuses to auto-delete/move data. */
export const AI_DELETE_ROW_CAP = 1000;

/**
 * One table that links INTO another: the referencing table, the belongsTo
 * relation's name, and the foreign-key column that holds the reference.
 *
 * `owned` marks a link table that exists ONLY to express the relationship — a
 * strict link table (exactly two foreign keys, no payload of its own) with one
 * of those keys pointing at the table in question. Those are part of the
 * relationship rather than independent objects, so they are removed together
 * with it. That distinction is what makes the table removable at all: a
 * `files_<table>` link table is created automatically the first time a file is
 * attached to a record, and it can never be removed on its own — it is itself a
 * table with links pointing at it, so a "remove the links first" instruction
 * sends the caller in a circle.
 */
export interface InboundLink {
  table: string;
  relName: string;
  foreignKey: string;
  owned: boolean;
}

/**
 * Is `t` STILL nothing but a link between two tables, as it stands right now?
 *
 * Registration as a link table happens ONCE, when the table is created — but a
 * table can ACQUIRE a payload column afterwards (any write carrying a field the
 * table lacks adds it), and from that moment it holds data of its own that lives
 * nowhere else. Deciding ownership from the registration alone would keep
 * sweeping such a table away with either side it links, silently, without ever
 * naming it — so ownership is decided from the table's CURRENT shape instead,
 * using the same strict two-keys-no-payload rule as every other destructive
 * path.
 *
 * The declared columns are unioned with the live registry because an auto-added
 * column reaches the registry immediately but the configuration only when the
 * explicit add-column path writes it — reading either one alone would miss it.
 * Registration still gates the answer, so this can only ever NARROW what counts
 * as plumbing, never promote a first-class table into it.
 */
function stillOnlyALink(active: ActiveDb, t: GuiTableSummary): boolean {
  if (!active.junctionTables.has(t.name)) return false;
  // No live registry for it (not registered on this workspace) — the declared
  // shape is then all there is to judge by.
  const registered = active.db.getRegisteredColumns(t.name);
  const columns = registered ? [...new Set([...t.columns, ...Object.keys(registered)])] : t.columns;
  return isJunctionTable({ ...t, columns });
}

/**
 * Every belongsTo relation that points at `table`, classified by
 * {@link InboundLink}. Shared by the assistant's delete tool and the HTTP delete
 * route so the two guards read the model the same way and cannot drift apart.
 */
export function inboundLinksTo(active: ActiveDb, table: string): InboundLink[] {
  const out: InboundLink[] = [];
  for (const t of getGuiEntities(active.configPath, active.outputDir).tables) {
    if (t.name === table) continue;
    for (const [relName, rel] of Object.entries(t.relations)) {
      if (rel.type === 'belongsTo' && rel.table === table) {
        // The STRICT link-table set (two foreign keys, no payload) — the same
        // one every other destructive path uses, never the broader display-only
        // set, so a first-class object can't be mistaken for plumbing.
        out.push({
          table: t.name,
          relName,
          foreignKey: rel.foreignKey,
          owned: stillOnlyALink(active, t),
        });
      }
    }
  }
  return out;
}

/** Filters selecting the rows of `link.table` that currently point at the table
 *  being deleted. Applied in SQL — this never loads a table to filter it in JS. */
function linkRowFilters(
  active: ActiveDb,
  link: InboundLink,
): { col: string; op: 'isNotNull' | 'isNull' }[] {
  const filters: { col: string; op: 'isNotNull' | 'isNull' }[] = [
    { col: link.foreignKey, op: 'isNotNull' },
  ];
  if (active.softDeletable.has(link.table)) filters.push({ col: 'deleted_at', op: 'isNull' });
  return filters;
}

/** How many rows currently point at the table being deleted, counted in SQL. */
async function countLinkRows(active: ActiveDb, link: InboundLink): Promise<number> {
  return active.db.count(link.table, { filters: linkRowFilters(active, link) });
}

/**
 * "b.a_id (3 rows), notes.a_id (1 row)" — the inventory shown to the caller
 * before anything is removed, so the decision is made with the row counts in
 * hand rather than a bare list of column names.
 */
export async function describeInboundLinks(
  active: ActiveDb,
  links: InboundLink[],
): Promise<string> {
  const parts: string[] = [];
  for (const link of links) {
    const n = await countLinkRows(active, link);
    parts.push(`${link.table}.${link.foreignKey} (${String(n)} row${n === 1 ? '' : 's'})`);
  }
  return parts.join(', ');
}

/**
 * Remove everything the deletion of `owner` takes with it — the link side of the
 * operation, shared by the assistant's delete tool and the HTTP delete route:
 *
 *   • the link tables that exist only to express a relationship with `owner`
 *     (always, and without a separate decision — see {@link InboundLink});
 *   • the rows of first-class tables that point at `owner` (only when
 *     `opts.cascade`).
 *
 * Rows go through the shared audited row-delete, so each one is individually
 * reversible from history and shows up in the activity feed. Link tables are
 * soft-deleted like any other table, which keeps the physical table and its rows
 * on disk — so the link table and its contents come back together when the
 * deletion is reverted, without deleting (and re-inserting) every link row.
 *
 * Nothing is written until the whole plan is known to be legal: a computed table
 * reading from a link table, or a cascade larger than `opts.rowBudget`, is
 * refused up front rather than partway through.
 */
export async function removeInboundLinks(
  active: ActiveDb,
  owner: string,
  inbound: InboundLink[],
  mctx: MutationCtx,
  opts: { cascade: boolean; rowBudget: number },
  sessionId: string,
): Promise<
  { ok: true; cascadedLinkRows: number; droppedLinkTables: string[] } | { ok: false; error: string }
> {
  const ownedTables = [...new Set(inbound.filter((l) => l.owned).map((l) => l.table))].filter((t) =>
    active.validTables.has(t),
  );
  // Refuse BEFORE any write: a computed table still reading from a link table
  // would make its removal throw halfway through the deletion.
  for (const t of ownedTables) {
    try {
      assertNotComputedSource(active, t);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  // Count the cascade in SQL first, so an oversized one is refused with nothing
  // written rather than leaving the model half-cascaded.
  const plan: InboundLink[] = [];
  let total = 0;
  if (opts.cascade) {
    for (const link of inbound) {
      if (link.owned) continue;
      const count = await countLinkRows(active, link);
      if (count === 0) continue;
      plan.push(link);
      total += count;
    }
  }
  if (total > opts.rowBudget) {
    return {
      ok: false,
      error:
        `Deleting "${owner}" would also remove ${String(total)} row${total === 1 ? '' : 's'} that link to it — ` +
        `more than can be removed safely in one step (${String(opts.rowBudget)} left in this operation's budget). ` +
        `Trim the linked tables first.`,
    };
  }
  let cascadedLinkRows = 0;
  for (const link of plan) {
    const rows = (await active.db.query(link.table, {
      filters: linkRowFilters(active, link),
      limit: opts.rowBudget,
    })) as Record<string, unknown>[];
    for (const r of rows) {
      // Soft where the table supports it; a table with no deleted_at column
      // takes the same audited hard delete an ordinary row delete would.
      await deleteRow(mctx, link.table, String(r.id), false);
      cascadedLinkRows++;
    }
  }
  const droppedLinkTables: string[] = [];
  for (const t of ownedTables) {
    await softDeleteUserEntity(active, t, sessionId, `Removed the ${t} links with ${owner}`);
    droppedLinkTables.push(t);
  }
  return { ok: true, cascadedLinkRows, droppedLinkTables };
}

/** The GUI-marked secret columns for a table (read-only; empty when the workspace
 *  has no column-meta table). Used by the merge path so it never moves a secret
 *  value into a non-secret column. */
async function secretColumns(active: ActiveDb, table: string): Promise<Set<string>> {
  try {
    const rows = (await active.db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: table },
        { col: 'secret', op: 'eq', val: 1 },
      ],
    })) as { column_name: string }[];
    return new Set(rows.map((r) => r.column_name));
  } catch {
    return new Set(); // no column-meta table on this workspace — nothing secret
  }
}

/** Conservative pre-flight for the merge: is `v` assignable to a column of
 *  `sqlType`? Only rejects a CLEARLY incompatible value (a non-numeric into an
 *  int/real/bool column) so the merge aborts BEFORE any write rather than throwing
 *  mid-loop and leaving rows split. Text/uuid/datetime/json accept anything; null
 *  is always allowed. */
function isAssignableToColumn(v: unknown, sqlType: string | undefined): boolean {
  if (v === null || v === undefined) return true;
  const t = (sqlType ?? '').toLowerCase();
  if (t.includes('int')) {
    if (typeof v === 'number') return Number.isInteger(v);
    if (typeof v === 'boolean') return true;
    if (typeof v === 'string') return /^-?\d+$/.test(v.trim());
    return false;
  }
  if (/real|floa|doub|numeric|decimal/.test(t)) {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') {
      const s = v.trim();
      return s !== '' && Number.isFinite(Number(s));
    }
    return false;
  }
  if (t.includes('bool')) {
    if (typeof v === 'boolean') return true;
    if (typeof v === 'number') return v === 0 || v === 1;
    if (typeof v === 'string') return ['true', 'false', '0', '1'].includes(v.trim().toLowerCase());
    return false;
  }
  return true;
}

/**
 * The assistant's guarded, reversible table delete. Safeguards (so the model
 * can't destroy data on a careless request):
 *   • refuses native/built-in tables and tables the operator doesn't own;
 *   • EMPTY table → soft-deletes it immediately (reversible);
 *   • NON-empty table with no `resolution` → does NOT delete; returns
 *     `needsResolution` so the assistant asks the user what to do with the data;
 *   • `resolution='delete_data'` → soft-deletes every live row, then the table;
 *   • `resolution='delete_cascade'` → the same, plus the rows in other tables
 *     that point at this one;
 *   • `resolution={move_to}` → copies each live row into the target table
 *     (best-effort column mapping), soft-deletes the originals, then the table.
 * Every step goes through the audited mutation primitives, so the whole thing is
 * reversible from history. Never drops the physical table (no hard delete).
 *
 * Tables that link INTO this one are handled by {@link removeInboundLinks}: the
 * link tables that exist only to express a relationship with it go with it
 * automatically, while a first-class table whose own rows point here still needs
 * an explicit `delete_cascade` (or a merge) before anything is removed.
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
  if (active.computedTables.has(name)) {
    return {
      ok: false,
      error: `"${name}" is a computed view — remove its definition instead of deleting it like a table.`,
    };
  }
  // A connected external mirror re-registers on the next open (its connector is
  // still connected), so deleting just the table is a confusing no-op. Steer to
  // disconnecting the connector instead.
  const connectedDelete = connectedSourceSteer(active, name, 'delete');
  if (connectedDelete) return { ok: false, error: connectedDelete };
  // Refuse BEFORE any data moves: a computed table reading from this one would
  // break, and the merge path must never fail after rows have been relocated.
  try {
    assertNotComputedSource(active, name);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const inbound = inboundLinksTo(active, name);
  // A link table that exists only to express a relationship with this one is part
  // of that relationship and goes with it; only a first-class table holding rows
  // of its own has to be decided about. Without that split the delete is a dead
  // end, because the link table can't be removed on its own either.
  const externalLinks = inbound.filter((l) => !l.owned);
  const isMove = typeof resolution === 'object';
  const isCascade = resolution === 'delete_cascade';

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

  // First-class tables still pointing here hold rows of their own, so removing
  // this table takes their links with it — the caller has to say so explicitly.
  // A MERGE is the other way through: it rewires each foreign key onto the target
  // instead of removing anything.
  if (externalLinks.length > 0 && !isMove && !isCascade) {
    const inventory = await describeInboundLinks(active, externalLinks);
    if (resolution === undefined) {
      return {
        needsResolution: true,
        rowCount,
        message:
          `"${name}" has ${String(rowCount)} row${rowCount === 1 ? '' : 's'} and other tables still link to it: ` +
          `${inventory}. Removing it takes those linked rows with it, so this needs a decision first — ask the ` +
          `user whether to delete "${name}" together with the linked rows listed above (reversible), move its ` +
          `rows into another table, or cancel. Then call delete_entity again with ` +
          `resolution="delete_cascade" or resolution={"move_to":"<table>"}.`,
      };
    }
    return {
      ok: false,
      error:
        `Cannot delete "${name}" with resolution="delete_data" — these links point at it: ${inventory}. ` +
        `Use resolution="delete_cascade" to remove those linked rows along with the table (reversible from ` +
        `history), or merge "${name}" into another table with move_to to carry the links across.`,
    };
  }

  // Empty, with nothing to cascade → remove it (and the link tables it owns)
  // straight away. A merge that must also repoint inbound links falls through to
  // the move_to path even with zero rows.
  const cascadeCount = isCascade ? externalLinks.length : 0;
  if (rowCount === 0 && cascadeCount === 0 && !(isMove && inbound.length > 0)) {
    const links = await removeInboundLinks(
      active,
      name,
      inbound,
      mctx,
      { cascade: false, rowBudget: AI_DELETE_ROW_CAP },
      sessionId,
    );
    if (!links.ok) return links;
    await softDeleteUserEntity(active, name, sessionId);
    return {
      ok: true,
      deleted: name,
      ...(links.droppedLinkTables.length > 0 ? { droppedLinkTables: links.droppedLinkTables } : {}),
    };
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

  if (resolution === 'delete_data' || resolution === 'delete_cascade') {
    if (rowCount > 0 && !softDeletable) {
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
    // Take the link side first: it counts the cascade in SQL and refuses an
    // oversized one with nothing written, so an over-budget cascade can never
    // leave this table's own rows already deleted.
    const links = await removeInboundLinks(
      active,
      name,
      inbound,
      mctx,
      { cascade: isCascade, rowBudget: AI_DELETE_ROW_CAP - rowCount },
      sessionId,
    );
    if (!links.ok) return links;
    // Guarded by rowCount so a table with no deleted_at column — reachable here
    // only with zero rows, purely to cascade its links — is never queried with a
    // soft-delete filter it has no column for.
    let deletedRows = 0;
    if (rowCount > 0) {
      const rows = (await active.db.query(name, {
        filters: [{ col: 'deleted_at', op: 'isNull' }],
        limit: AI_DELETE_ROW_CAP,
      })) as Record<string, unknown>[];
      for (const r of rows) {
        await deleteRow(mctx, name, String(r.id), false); // soft delete — reversible
        deletedRows++;
      }
    }
    await softDeleteUserEntity(active, name, sessionId);
    return {
      ok: true,
      deleted: name,
      deletedRows,
      ...(links.cascadedLinkRows > 0 ? { cascadedLinkRows: links.cascadedLinkRows } : {}),
      ...(links.droppedLinkTables.length > 0 ? { droppedLinkTables: links.droppedLinkTables } : {}),
    };
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
  // A source whose rows can't be soft-deleted (no deleted_at) can't be MERGED
  // reversibly: the copies would land in the target while the originals stay
  // physically present, so a history "restore" would duplicate everything. Refuse.
  if (!softDeletable) {
    return {
      ok: false,
      error: `"${name}" can't be merged — its rows have no deleted_at column to reversibly remove. Delete or clear it manually instead.`,
    };
  }
  // Too large to move automatically → hand it back as a decision (ask the user)
  // rather than a hard error the assistant can't recover from.
  if (rowCount > AI_DELETE_ROW_CAP) {
    return {
      needsResolution: true,
      rowCount,
      message:
        `"${name}" has ${String(rowCount)} rows — too many to merge automatically (the safe ` +
        `limit is ${String(AI_DELETE_ROW_CAP)}). Ask the user to trim it first or leave it as its ` +
        `own object; do not retry the merge as-is.`,
    };
  }
  const SKIP = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);
  const targetCols = active.db.getRegisteredColumns(target);
  if (!targetCols) return { ok: false, error: `Could not read the columns of "${target}".` };
  // Never declassify: if a secret source column would land in a non-secret target
  // column (a new one, or an existing non-secret one), refuse rather than expose it.
  const sourceSecret = await secretColumns(active, name);
  if (sourceSecret.size > 0) {
    const targetSecret = await secretColumns(active, target);
    const exposed = [...sourceSecret].filter((c) => !SKIP.has(c) && !targetSecret.has(c));
    if (exposed.length > 0) {
      return {
        ok: false,
        error: `Cannot merge "${name}": the secret field${exposed.length === 1 ? '' : 's'} ${exposed.join(', ')} would become visible in "${target}". Unmark them as secret, or move them manually, first.`,
      };
    }
  }
  // Column union: widen the target with any source column it lacks so no field is
  // silently dropped from the merged copies (the target gains the source's fields;
  // added columns are audited by addUserColumn, so this stays reversible).
  const sourceCols = active.db.getRegisteredColumns(name) ?? {};
  const toAdd = Object.keys(sourceCols).filter((c) => !SKIP.has(c) && !(c in targetCols));
  for (const col of toAdd) {
    const added = await addUserColumn(active, target, col, sessionId);
    if (!added.ok) {
      return {
        ok: false,
        error: `Could not add "${col}" to "${target}" for the merge: ${added.error}`,
      };
    }
  }
  // Re-read after any widening so newly-added columns are included in the mapping.
  const cols = active.db.getRegisteredColumns(target) ?? targetCols;

  const rows = (await active.db.query(name, {
    filters: [{ col: 'deleted_at', op: 'isNull' }],
    limit: AI_DELETE_ROW_CAP,
  })) as Record<string, unknown>[];
  // Pre-flight: abort BEFORE moving any row if a value can't be assigned to its
  // target column's type (e.g. TEXT "N/A" into an INTEGER column). Without this an
  // incompatible row mid-loop would throw INSIDE the transaction below; the type
  // check turns that into a clean up-front refusal instead of a rolled-back write.
  // Unioned columns are TEXT so they never trip this; only a pre-existing same-named
  // column of a strict type can.
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (SKIP.has(k) || !(k in cols)) continue;
      if (!isAssignableToColumn(v, cols[k])) {
        return {
          ok: false,
          error: `Cannot merge "${name}" into "${target}": the value ${JSON.stringify(v)} in "${k}" is not compatible with the "${k}" column in "${target}". Fix or clear those values first.`,
        };
      }
    }
  }
  // Move every row inside ONE transaction: each copy-into-target + soft-delete-of
  // -source (and their audit/changelog writes) commit together, or roll back
  // together if any row throws mid-loop. Combined with the type pre-flight above,
  // a merge either completes fully or changes nothing — it can never leave rows
  // split between the two tables. (The source-entity removal below is a config
  // edit, not a DB write, so it stays outside the transaction and runs only after
  // the row moves have committed.)
  let movedRows = 0;
  const idMap = new Map<string, string>(); // old source row id → new target row id
  await active.db.transaction(async () => {
    movedRows = 0;
    idMap.clear();
    for (const r of rows) {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (!SKIP.has(k) && k in cols) mapped[k] = v;
      }
      const created = await createRow(mctx, target, mapped); // new id auto-assigned
      idMap.set(String(r.id), created.id);
      await deleteRow(mctx, name, String(r.id), false);
      movedRows++;
    }
    // Carry every inbound link across with the rows: update each foreign key that
    // pointed at a moved source row so it now points at that row's copy in the
    // target. Same transaction as the moves → a failure rolls the whole merge back.
    // Bounded (Rule: no unbounded reads) — only link rows referencing a moved row.
    if (idMap.size > 0) {
      const movedIds = [...idMap.keys()];
      for (const link of inbound) {
        const linkRows = (await active.db.query(link.table, {
          filters: [{ col: link.foreignKey, op: 'in', val: movedIds }],
        })) as Record<string, unknown>[];
        for (const lr of linkRows) {
          const ref = lr[link.foreignKey];
          if (typeof ref !== 'string' && typeof ref !== 'number') continue; // FK is a uuid / int
          const newId = idMap.get(String(ref));
          if (newId !== undefined) {
            await updateRow(mctx, link.table, String(lr.id), { [link.foreignKey]: newId });
          }
        }
      }
    }
  });
  // Repoint each inbound relation from the (now-removed) source to the target so the
  // links reference the merged object, not a deleted one. Config edit (not a DB
  // write) → after the transaction commits, alongside the source removal. The link
  // table + FK column keep their names (they just point at the target now).
  if (inbound.length > 0) {
    const doc = loadConfigDoc(active.configPath);
    for (const link of inbound) {
      doc.setIn(['entities', link.table, 'relations', link.relName], {
        type: 'belongsTo',
        table: target,
        foreignKey: link.foreignKey,
      });
    }
    saveConfigDoc(active.configPath, doc);
  }
  await softDeleteUserEntity(active, name, sessionId);
  if (inbound.length > 0) syncCanonicalContexts(active); // refresh rollups for the repointed links
  return { ok: true, deleted: name, movedRows, rewiredLinks: inbound.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table roles — what a table IS, stored beside the rest of its metadata
// ─────────────────────────────────────────────────────────────────────────────

/** The per-table GUI metadata row (icon, definition — and now the role). */
const TABLE_META = '_lattice_gui_meta';

/**
 * The role fields, added to the metadata row rather than to a table of their
 * own: a role is one more thing we know about a table, exactly like its icon and
 * its definition, and a second table keyed on the same thing would only need
 * joining back together at every read.
 *
 * `role_source` is what protects a person's answer from being overwritten by the
 * next inference pass, and `role_set_at` is what lets a stale inferred role be
 * told apart from a fresh one.
 */
const ROLE_COLUMNS: Record<string, string> = {
  role: 'TEXT',
  role_source: 'TEXT',
  grain: 'TEXT',
  role_set_at: 'TEXT',
};

/** A role as stored for one table. */
export interface StoredTableRole {
  role: TableRole;
  source: RoleSource;
  /** What one row means, as recorded when the role was set. */
  grain: string | null;
  /** ISO-8601 timestamp of the write. */
  setAt: string | null;
}

/**
 * Add the role fields to the metadata table if they are not there yet — the
 * same converge-on-use pattern the other bookkeeping stores follow, so a
 * workspace created before roles existed picks them up on the first write with
 * no migration and no reopen. Idempotent (`addColumn` introspects first) and it
 * re-registers the columns on the live schema, so the write that follows can
 * actually use them. They survive a reopen too: the column cache that gates
 * reads and writes is built by introspecting the real table, not from the
 * declaration.
 */
export async function ensureRoleColumns(db: Lattice): Promise<void> {
  for (const [column, type] of Object.entries(ROLE_COLUMNS)) {
    await db.addColumn(TABLE_META, column, type);
  }
}

/**
 * Every role recorded in this workspace, keyed by table name.
 *
 * Deliberately does NOT create the columns: a read must not write. A workspace
 * where no role has ever been set simply has none, and the planner treats that
 * as "nothing recorded yet" rather than as an error.
 */
export async function readTableRoles(db: Lattice): Promise<Map<string, StoredTableRole>> {
  const out = new Map<string, StoredTableRole>();
  const present = await introspectColumnsAsyncOrSync(db.adapter, TABLE_META);
  if (!Object.keys(ROLE_COLUMNS).every((c) => present.includes(c))) return out;
  // One row per table, and only the rows that carry a role — bounded by SQL, not
  // by reading the table and filtering afterwards.
  const rows = (await db.query(TABLE_META, {
    filters: [{ col: 'role', op: 'isNotNull' }],
    limit: 1000,
  })) as {
    entity_name?: unknown;
    role?: unknown;
    role_source?: unknown;
    grain?: unknown;
    role_set_at?: unknown;
  }[];
  for (const r of rows) {
    if (typeof r.entity_name !== 'string' || !isTableRole(r.role)) continue;
    out.set(r.entity_name, {
      role: r.role,
      source: r.role_source === 'user' ? 'user' : 'inferred',
      grain: typeof r.grain === 'string' ? r.grain : null,
      setAt: typeof r.role_set_at === 'string' ? r.role_set_at : null,
    });
  }
  return out;
}

/**
 * Record a table's role, how it was decided, and what one of its rows means.
 * Leaves every other field of the metadata row (icon, definition) untouched, and
 * refuses a table the workspace does not have — a role written against a name
 * nothing answers to is a silent no-op, which is exactly the failure this
 * module exists to avoid.
 */
export async function setTableRole(
  active: ActiveDb,
  table: string,
  role: TableRole,
  source: RoleSource,
  grain: string | null,
): Promise<void> {
  if (!active.validTables.has(table)) throw new Error(`Unknown table: ${table}`);
  if (!isTableRole(role)) throw new Error(`"${String(role)}" is not a table role.`);
  await ensureRoleColumns(active.db);
  const now = new Date().toISOString();
  const fields = {
    role,
    role_source: source,
    grain,
    role_set_at: now,
    updated_at: now,
  };
  const existing = (await active.db.get(TABLE_META, table)) as { entity_name: string } | null;
  if (existing) await active.db.update(TABLE_META, table, fields);
  else await active.db.insert(TABLE_META, { entity_name: table, ...fields });
}

/**
 * Write a table's definition to BOTH places a definition is read from: the
 * workspace configuration (which is what the data-model profiler consults, and
 * therefore what decides whether the table still looks undocumented) and the
 * browsable metadata row (which is what the interface and the assistant show).
 *
 * Splitting those two was a real defect: the documentation proposal read the
 * configuration and the applier wrote only the metadata row, so applying it
 * never satisfied the check that produced it and the same proposal came back on
 * every pass, forever. One writer, both stores.
 */
export async function setTableDefinition(
  active: ActiveDb,
  table: string,
  description: string,
): Promise<void> {
  if (!active.validTables.has(table)) throw new Error(`Unknown table: ${table}`);
  const text = description.trim();
  const doc = loadConfigDoc(active.configPath);
  if (doc.getIn(['entities', table]) !== undefined) {
    if (text) doc.setIn(['entities', table, 'description'], text);
    else doc.deleteIn(['entities', table, 'description']);
    saveConfigDoc(active.configPath, doc);
  }
  await upsertTableMeta(active.db, table, { description: text });
}

// ─────────────────────────────────────────────────────────────────────────────
// Renaming a table — and everything that names it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bookkeeping stores that record a table by NAME, and the columns holding
 * it. Every one of these is a dangling reference the moment a table is renamed:
 * metadata and definitions stop being found, the lineage trail breaks, cached
 * embeddings and graph edges point at nothing, and on a cloud the sharing and
 * column-visibility policies stop applying to the table they were written for
 * (which fails OPEN — a renamed table would lose its column masking).
 *
 * Deliberately NOT in this list: the audit log. It records what happened, under
 * the name the table had at the time; rewriting history to match the present
 * would falsify the record and break the revert payloads stored alongside it.
 */
const TABLE_NAME_REFERENCES: readonly { store: string; columns: readonly string[] }[] = [
  { store: TABLE_META, columns: ['entity_name'] },
  { store: '_lattice_gui_column_meta', columns: ['table_name'] },
  { store: LINEAGE_TABLE, columns: ['object_table', 'source_table'] },
  { store: '_lattice_embeddings', columns: ['table_name'] },
  { store: '__lattice_edges', columns: ['src_table', 'dst_table'] },
  { store: '__lattice_computed_state', columns: ['table_name'] },
  // Cloud only — absent on a local workspace, which the existence check handles.
  { store: '__lattice_owners', columns: ['table_name'] },
  { store: '__lattice_row_grants', columns: ['table_name'] },
  { store: '__lattice_table_shares', columns: ['table_name'] },
  { store: '__lattice_table_share_grants', columns: ['table_name'] },
  { store: '__lattice_table_policy', columns: ['table_name'] },
  { store: '__lattice_column_policy', columns: ['table_name'] },
];

/**
 * The bookkeeping stores that record a COLUMN by name — the table it sits on AND
 * the column itself. A column rename moves the physical column and nothing else,
 * so every one of these strands under a name the table no longer has a column
 * for: the browsable per-column metadata stops being found, computed-fill state
 * stops matching its field, and on a cloud the per-column masking policy stops
 * applying to the column it was written for.
 *
 * That last one fails OPEN in the same way a stranded table policy did. The
 * `<t>_v` member read view is generated FROM `__lattice_column_policy`, keyed by
 * (table, column) — so a policy left behind under the OLD column name reads back
 * as "this column is not masked", and the next rebuild of the view emits the
 * renamed column in cleartext to every member of the team.
 *
 * Deliberately NOT in this list:
 *   • the audit log (`_lattice_gui_audit`) — it records what happened under the
 *     name the column had at the time; rewriting history to match the present
 *     would falsify the record and break the revert payloads stored with it;
 *   • cached embeddings (`_lattice_embeddings`) — keyed by row, not by column,
 *     and re-embedded from the current text on the next pass.
 *
 * Noted but deliberately NOT fixed here: `__lattice_ai_map` / `__lattice_ai_cell`
 * key their cache on `field_key = '<table>.<field>'`, which a column rename also
 * strands. That is a cache MISS — the field re-fills from the model and costs
 * tokens — never a leak, so it does not belong in a security carry.
 */
const COLUMN_NAME_REFERENCES: readonly {
  store: string;
  /** The column holding the TABLE name. */
  tableColumn: string;
  /** The column holding the COLUMN name. */
  nameColumn: string;
}[] = [
  // Cloud only — absent on a local workspace, which the existence check handles.
  // This is the one that leaks; the other two are correctness.
  { store: '__lattice_column_policy', tableColumn: 'table_name', nameColumn: 'column_name' },
  { store: '_lattice_gui_column_meta', tableColumn: 'table_name', nameColumn: 'column_name' },
  { store: '__lattice_computed_state', tableColumn: 'table_name', nameColumn: 'field' },
];

/**
 * The cloud bookkeeping that decides who may read a table, keyed by its NAME:
 * per-row ownership and grants, the standing table-level share, the per-table
 * defaults, and the per-column masking policy.
 *
 * A rename MOVES these (they still describe the same table under a new name).
 * A purge must DELETE them — the table they describe is gone, and a name is all
 * that binds them to it, so the next table to take that name inherits the lot.
 */
const CLOUD_NAME_KEYED_POLICY: readonly string[] = [
  '__lattice_owners',
  '__lattice_row_grants',
  '__lattice_table_shares',
  '__lattice_table_share_grants',
  '__lattice_table_policy',
  '__lattice_column_policy',
];

/**
 * Physically remove a soft-deleted table, along with the rendered artifact that
 * masks it and everything the cloud recorded ABOUT it by name.
 *
 * Two things make this more than a `DROP TABLE`. The cell-masking view generated
 * for a table with a secret column DEPENDS on that table, so a plain drop is
 * refused by the database outright — a masked table could not be purged at all.
 * And the sharing, per-table defaults, row grants and column policy are keyed by
 * NAME rather than by the table's identity: left behind, the next table created
 * with that name starts life shared with the whole team, stamping its new rows
 * with a dead table's default visibility, and masked by a policy nobody wrote
 * for it.
 *
 * Throws on failure, so a half-purged table can never be reported as a success.
 */
export async function purgeUserEntity(active: ActiveDb, table: string): Promise<void> {
  const q = table.replace(/"/g, '""');
  const onCloud = active.db.getDialect() === 'postgres' && (await cloudRlsInstalled(active.db));
  if (onCloud) await execSql(active.db, `DROP VIEW IF EXISTS "${q}_v"`);
  await execSql(active.db, `DROP TABLE IF EXISTS "${q}"`);
  if (!onCloud) return;
  for (const store of CLOUD_NAME_KEYED_POLICY) {
    const columns = await introspectColumnsAsyncOrSync(active.db.adapter, store);
    if (!columns.includes('table_name')) continue; // this workspace has no such store
    await runAsyncOrSync(active.db.adapter, `DELETE FROM "${store}" WHERE "table_name" = ?`, [
      table,
    ]);
  }
}

/** One link table renamed alongside the table it is named after. */
export interface LinkTableRename {
  from: string;
  to: string;
  /** The foreign-key column named after the renamed table, when it was renamed. */
  column?: { from: string; to: string };
  /** The relation whose name was derived from that column, when it was renamed. */
  relation?: { from: string; to: string };
}

/** Everything a rename moved besides the table itself. */
export interface RenameCascade {
  /**
   * belongsTo declarations on other tables that pointed at the renamed table,
   * named as they were FOUND — a link table that this same cascade also renamed
   * appears under its previous name, and {@link RenameCascade.linkTables} maps it
   * to the new one.
   */
  relations: { table: string; relation: string }[];
  /** Computed tables whose definition named it (as a base or through a link). */
  computed: string[];
  /** Link tables named after it, renamed with it. */
  linkTables: LinkTableRename[];
  /** True when the table had a declared entity-context block, moved with it. */
  contextMoved: boolean;
  /** Bookkeeping rows repointed, per store + column. */
  rows: { store: string; column: string; rows: number }[];
  /** Saved dashboards whose recorded source tables were repointed. */
  dashboards: number;
  /** Cloud only: per-table masked views rebuilt under the new name. */
  maskViews: string[];
  /** Dismissed proposal fingerprints rewritten so the answers still apply. */
  proposals: number;
}

export type RenameOutcome =
  | { ok: true; cascade: RenameCascade; auditId: string }
  | { ok: false; error: string };

/** Rename a key in place, preserving the order of every other key. */
function renameKey<T>(obj: Record<string, T>, from: string, to: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

/** The machine-derived hidden overview path, rewritten when the name it was
 *  derived from changes. An author-chosen output path is left alone. */
function movedOutputFile(outputFile: unknown, from: string, to: string): string | null {
  return outputFile === `.schema-only/${from}.md` ? `.schema-only/${to}.md` : null;
}

/**
 * The link tables whose NAME is built from the table being renamed — `<table>_<other>`,
 * `<other>_<table>`, `files_<table>`. Their names are derived, not chosen, so they
 * have to follow: a stale `files_orders` beside a renamed `sales` is not merely
 * untidy, it makes the next file attachment create a SECOND link table and split
 * the links across both.
 */
function linkTablesNamedAfter(active: ActiveDb, from: string, to: string): LinkTableRename[] {
  const out: LinkTableRename[] = [];
  const others = new Set<string>([...active.validTables, 'files']);
  others.delete(from);
  for (const junction of active.junctionTables) {
    for (const other of others) {
      if (other === junction) continue;
      if (junction === boundIdentifier(`${from}_${other}`)) {
        out.push({ from: junction, to: boundIdentifier(`${to}_${other}`) });
        break;
      }
      if (junction === boundIdentifier(`${other}_${from}`)) {
        out.push({ from: junction, to: boundIdentifier(`${other}_${to}`) });
        break;
      }
    }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** Repoint one bookkeeping store's table-name column, skipping a store this
 *  workspace does not have. Returns how many rows moved. */
async function repointStore(
  adapter: StorageAdapter,
  store: string,
  column: string,
  from: string,
  to: string,
): Promise<number> {
  const columns = await introspectColumnsAsyncOrSync(adapter, store);
  if (!columns.includes(column)) return 0; // this workspace has no such store
  const rows = (await allAsyncOrSync(
    adapter,
    `SELECT COUNT(*) AS n FROM "${store}" WHERE "${column}" = ?`,
    [from],
  )) as { n?: unknown }[];
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return 0;
  await runAsyncOrSync(adapter, `UPDATE "${store}" SET "${column}" = ? WHERE "${column}" = ?`, [
    to,
    from,
  ]);
  return n;
}

/**
 * Repoint ONE bookkeeping store's column-name column, scoped to a single table,
 * skipping a store this workspace does not have. Returns how many rows moved.
 *
 * A deliberate sibling of {@link repointStore} rather than a generalisation of
 * it: that one is the proven table-rename carry and is not worth destabilising,
 * and this one has to do something it does not — delete a colliding target row
 * first. `__lattice_column_policy` and `__lattice_computed_state` are both keyed
 * `(table_name, <name>)`, so `UPDATE ... SET <name> = <new>` throws on the
 * primary key if a row for `<new>` is already sitting there. Every rename route
 * refuses when the target column already exists, so a row under the new name is
 * necessarily left over from a column that is gone — stale bookkeeping for a
 * column that no longer exists, which the incoming row is the correct value for.
 */
async function repointColumnStore(
  adapter: StorageAdapter,
  store: string,
  tableColumn: string,
  nameColumn: string,
  table: string,
  from: string,
  to: string,
): Promise<number> {
  const columns = await introspectColumnsAsyncOrSync(adapter, store);
  if (!columns.includes(tableColumn) || !columns.includes(nameColumn)) return 0;
  const rows = (await allAsyncOrSync(
    adapter,
    `SELECT COUNT(*) AS n FROM "${store}" WHERE "${tableColumn}" = ? AND "${nameColumn}" = ?`,
    [table, from],
  )) as { n?: unknown }[];
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return 0;
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${store}" WHERE "${tableColumn}" = ? AND "${nameColumn}" = ?`,
    [table, to],
  );
  await runAsyncOrSync(
    adapter,
    `UPDATE "${store}" SET "${nameColumn}" = ? WHERE "${tableColumn}" = ? AND "${nameColumn}" = ?`,
    [to, table, from],
  );
  return n;
}

/** Repoint the table names a saved dashboard records as its data sources. The
 *  authored page itself is re-authored by the repair pass the rename triggers;
 *  this keeps the machine-readable dependency list correct either way. */
async function repointDashboards(active: ActiveDb, renames: Map<string, string>): Promise<number> {
  if (!active.db.getRegisteredTableNames().includes('dashboards')) return 0;
  const rows = (await active.db.query('dashboards', {
    filters: [{ col: 'source_tables', op: 'isNotNull' }],
    limit: 500,
  })) as { id: string; source_tables?: unknown }[];
  let moved = 0;
  for (const row of rows) {
    if (typeof row.source_tables !== 'string' || row.source_tables === '') continue;
    let sources: unknown;
    try {
      sources = JSON.parse(row.source_tables);
    } catch {
      continue; // not a list we wrote — leave it exactly as it is
    }
    if (!Array.isArray(sources)) continue;
    const next: unknown[] = [];
    let changed = false;
    for (const source of sources as unknown[]) {
      const target = typeof source === 'string' ? renames.get(source) : undefined;
      next.push(target ?? source);
      if (target !== undefined) changed = true;
    }
    if (!changed) continue;
    await active.db.update('dashboards', row.id, { source_tables: JSON.stringify(next) });
    moved++;
  }
  return moved;
}

/**
 * Rewrite the dismissed-proposal fingerprints that name the table. A proposal id
 * is `<kind>:<table>:<column>:<toTable>`, so without this every question the user
 * already answered ("no, don't merge those") comes back the moment the table is
 * renamed.
 */
async function repointProposals(active: ActiveDb, renames: Map<string, string>): Promise<number> {
  const adapter = active.db.adapter;
  const columns = await introspectColumnsAsyncOrSync(adapter, PLAN_STATE_TABLE);
  if (!columns.includes('op_id')) return 0;
  let moved = 0;
  for (const [from, to] of renames) {
    // Bounded by SQL to the ids that could possibly contain the name; the exact
    // segment test below is what decides. (`_` is a LIKE wildcard, so this can
    // over-select — never under-select, which is what matters here.)
    const rows = (await allAsyncOrSync(
      adapter,
      `SELECT "op_id" FROM "${PLAN_STATE_TABLE}" WHERE "op_id" LIKE ?`,
      [`%${from}%`],
    )) as { op_id?: unknown }[];
    for (const row of rows) {
      const id = typeof row.op_id === 'string' ? row.op_id : '';
      const parts = id.split(':');
      if (parts.length < 2) continue;
      const rewritten = [parts[0], ...parts.slice(1).map((p) => (p === from ? to : p))].join(':');
      if (rewritten === id) continue;
      const clash = (await allAsyncOrSync(
        adapter,
        `SELECT "op_id" FROM "${PLAN_STATE_TABLE}" WHERE "op_id" = ?`,
        [rewritten],
      )) as unknown[];
      // The rewritten fingerprint may already be stored (both names dismissed at
      // some point) — the answer is the same either way, so drop the duplicate
      // rather than fail on the primary key.
      if (clash.length > 0) {
        await runAsyncOrSync(adapter, `DELETE FROM "${PLAN_STATE_TABLE}" WHERE "op_id" = ?`, [id]);
      } else {
        await runAsyncOrSync(
          adapter,
          `UPDATE "${PLAN_STATE_TABLE}" SET "op_id" = ? WHERE "op_id" = ?`,
          [rewritten, id],
        );
      }
      moved++;
    }
  }
  return moved;
}

/**
 * Refusal raised from inside {@link renameTablesCarryingPolicy} when a rename
 * cannot be completed safely. Distinct from a programming error so callers can
 * report the message to the user instead of letting it escape as a crash.
 */
export class RenameRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenameRefused';
  }
}

/**
 * What renaming a table has to know about it BEFORE it moves: whether the cloud
 * masks any of its columns, and the shape needed to rebuild that mask afterwards.
 *
 * Both are read while the table still answers to its old name. Which columns are
 * secret is canonical in the column policy, keyed BY NAME — so once the table has
 * moved, an empty policy read under the new name is indistinguishable from "this
 * table has no secret columns", and acting on that hands every member raw read.
 * The column list and primary key are captured here too so the mask can be
 * rebuilt without depending on the live registry having been re-pointed yet
 * (a rename never changes either one).
 */
interface TableNamePolicySnapshot {
  onCloud: boolean;
  masked: Set<string>;
  shape: Map<string, { columns: string[]; pk: readonly string[] }>;
}

/** Everything {@link renameTablesCarryingPolicy} moved besides the tables. */
export interface TableNamePolicyMove {
  /** Bookkeeping rows re-pointed, per store + column. */
  rows: { store: string; column: string; rows: number }[];
  /** Cloud only: per-table masking views rebuilt under the new name. */
  maskViews: string[];
}

/**
 * Columns renamed on one table, old name → new name. Both
 * {@link renameTablesCarryingPolicy} (keyed by the table's NEW name, since the
 * table has moved by the time these are applied) and
 * {@link renameColumnsCarryingPolicy} take this shape.
 */
export type ColumnRenames = ReadonlyMap<string, string>;

/**
 * Move everything keyed to the renamed COLUMNS of one table, and say which of
 * them were masked before the move. Shared by both carries.
 *
 * The masked set is read while the columns still answer to their old names: the
 * policy is keyed by (table, column), so once the column has moved, an empty
 * policy read under the new name is indistinguishable from "this column was
 * never masked" — and acting on that is exactly the leak.
 */
async function snapshotMaskedColumns(
  db: Lattice,
  table: string,
  renames: ColumnRenames,
): Promise<Set<string>> {
  const policy = await loadColumnPolicy(db, table);
  const masked = new Set<string>();
  for (const from of renames.keys()) if (!isRowAudience(policy[from])) masked.add(from);
  return masked;
}

/** Re-point every column-keyed bookkeeping store for one table's renamed columns. */
async function carryColumnStores(
  db: Lattice,
  table: string,
  renames: ColumnRenames,
): Promise<{ store: string; column: string; rows: number }[]> {
  const moved: { store: string; column: string; rows: number }[] = [];
  for (const { store, tableColumn, nameColumn } of COLUMN_NAME_REFERENCES) {
    for (const [from, to] of renames) {
      const rows = await repointColumnStore(
        db.adapter,
        store,
        tableColumn,
        nameColumn,
        table,
        from,
        to,
      );
      if (rows > 0) moved.push({ store, column: nameColumn, rows });
    }
  }
  return moved;
}

/**
 * Refuse when a column that WAS masked does not read back masked under its new
 * name. Same fail-closed reasoning as the table-level refusal: an empty policy
 * after the move means the policy failed to travel, never that the owner
 * un-masked the column.
 */
async function refuseUnmaskedColumns(
  db: Lattice,
  table: string,
  renames: ColumnRenames,
  maskedBefore: ReadonlySet<string>,
): Promise<void> {
  if (maskedBefore.size === 0) return;
  const carried = await loadColumnPolicy(db, table);
  const lost: string[] = [];
  for (const [from, to] of renames) {
    if (maskedBefore.has(from) && isRowAudience(carried[to])) lost.push(`"${from}" → "${to}"`);
  }
  if (lost.length === 0) return;
  throw new RenameRefused(
    `${lost.join(', ')} on "${table}" ${lost.length === 1 ? 'was' : 'were'} marked secret, and that ` +
      `column policy did not follow the rename. The column${lost.length === 1 ? ' has' : 's have'} ` +
      `already been renamed in the database and that is NOT undone here; what stopped is the rebuild ` +
      `of the masking view, because rebuilding it from a policy that reads back empty would hand every ` +
      `member the column in cleartext. The workspace is safe but stale: the standing view still masks ` +
      `under the old column name. Reopen the workspace to rebuild it, then re-mark the column secret.`,
  );
}

/**
 * Rebuild the relation members read `table` through, after its columns moved.
 *
 * `recreate` is not optional. `CREATE OR REPLACE VIEW` cannot rename, drop or
 * reorder a view's columns (SQLSTATE 42P16), and a column rename does exactly
 * that — so a plain REPLACE fails and the table is left being read through a
 * view that projects a column the table no longer has.
 */
async function rebuildMemberReadViewForColumns(
  db: Lattice,
  table: string,
  columns: readonly string[],
  pk: readonly string[],
): Promise<void> {
  if (pk.length === 0) return;
  await regenerateMemberReadView(db, table, columns, pk, { recreate: true });
}

/** Map a list of column names through a rename map, leaving untouched names alone. */
function mapNames(names: readonly string[], renames: ColumnRenames): string[] {
  return names.map((n) => renames.get(n) ?? n);
}

/**
 * Rename tables and carry EVERYTHING keyed to their names with them — the ONE
 * primitive any rename must go through.
 *
 * `move` performs the physical `ALTER TABLE ... RENAME` (plus whatever the
 * caller needs to keep in step with it: the configuration document, the live
 * registry). It is bracketed, so it is not possible to run it without the
 * snapshot in front and the carry behind:
 *
 *   before — record which of the tables the cloud masks, and their shape;
 *   move   — the caller's physical rename;
 *   after  — re-point every name-keyed bookkeeping store, then rebuild each
 *            masking view under the new name and drop the stale one.
 *
 * The order after `move` is load-bearing. The cloud's column policy is one of
 * those stores and the masking view is generated FROM it, so rebuilding the view
 * first would read the policy under a name it has not been moved to yet, find
 * nothing, conclude the table has no secret columns — and both drop the view and
 * grant the member group raw SELECT on the base table.
 *
 * Throws {@link RenameRefused} rather than resolving that ambiguity in the
 * direction that exposes data: for a table that WAS masked, an empty policy read
 * under the new name means the policy failed to travel, not that the owner
 * un-masked it. The mask is left standing under the old view.
 *
 * `columnRenames` covers the one rename that moves BOTH: a link table renamed
 * after the table it points at also has its `<table>_id` key column renamed
 * inside `move`. A column name is keyed just as a table name is, so it needs the
 * same carry — keyed here by the table's NEW name, because by the time the carry
 * runs the table has already moved and every store has been re-pointed to it.
 */
export async function renameTablesCarryingPolicy(
  db: Lattice,
  renames: ReadonlyMap<string, string>,
  move: () => Promise<void>,
  columnRenames: ReadonlyMap<string, ColumnRenames> = new Map(),
): Promise<TableNamePolicyMove> {
  const snapshot: TableNamePolicySnapshot = {
    onCloud: db.getDialect() === 'postgres' && (await cloudRlsInstalled(db)),
    masked: new Set<string>(),
    shape: new Map(),
  };
  /** Per OLD table name: which of its renamed columns the cloud masks right now. */
  const maskedColumns = new Map<string, Set<string>>();
  for (const [oldName, newName] of renames) {
    const cols = db.getRegisteredColumns(oldName);
    if (cols) {
      snapshot.shape.set(oldName, { columns: Object.keys(cols), pk: db.getPrimaryKey(oldName) });
    }
    if (!snapshot.onCloud) continue;
    if (tableNeedsAudienceView(await loadColumnPolicy(db, oldName))) snapshot.masked.add(oldName);
    const cr = columnRenames.get(newName);
    // Read under the OLD table name — the columns have not moved yet either.
    if (cr) maskedColumns.set(oldName, await snapshotMaskedColumns(db, oldName, cr));
  }

  await move();

  const moved: TableNamePolicyMove = { rows: [], maskViews: [] };
  for (const { store, columns } of TABLE_NAME_REFERENCES) {
    for (const column of columns) {
      for (const [oldName, newName] of renames) {
        const rows = await repointStore(db.adapter, store, column, oldName, newName);
        if (rows > 0) moved.rows.push({ store, column, rows });
      }
    }
  }
  // The columns that moved with their tables, carried AFTER the store re-point
  // (which brought those rows to the new TABLE name) and BEFORE the view rebuild
  // below (which reads them back). Either order alone strands one of the two
  // halves of the key. Not gated on the cloud: two of these stores are ordinary
  // workspace bookkeeping that a local workspace has as well.
  for (const newName of renames.values()) {
    const cr = columnRenames.get(newName);
    if (!cr || cr.size === 0) continue;
    moved.rows.push(...(await carryColumnStores(db, newName, cr)));
  }
  if (!snapshot.onCloud) return moved;

  for (const [oldName, newName] of renames) {
    const cr = columnRenames.get(newName);
    if (cr) await refuseUnmaskedColumns(db, newName, cr, maskedColumns.get(oldName) ?? new Set());
  }

  // Members read a table through a view NAMED after it. Postgres binds a view to
  // the table it selects from by identity, so the view survives the rename —
  // under the OLD name, where nothing looks for it. Rebuild it under the new name
  // and drop the stale one, or a renamed table simply stops being readable by
  // every member of the team, and the stranded view + policy become the drift
  // that member reconciliation has to refuse.
  for (const [oldName, newName] of renames) {
    if (snapshot.masked.has(oldName)) {
      const carried = await loadColumnPolicy(db, newName);
      if (!tableNeedsAudienceView(carried)) {
        throw new RenameRefused(
          `"${oldName}" has columns marked secret, and that column policy did not follow it to ` +
            `"${newName}". Rebuilding the masking view from an empty policy would give every member ` +
            `direct read on those columns, so the rename stopped before doing that. The table is now ` +
            `called "${newName}" and its columns are still masked; reopen the workspace and try again.`,
        );
      }
    }
    await execSql(db, `DROP VIEW IF EXISTS "${oldName.replace(/"/g, '""')}_v"`);
    const shape = snapshot.shape.get(oldName);
    if (shape && shape.pk.length > 0) {
      // The fallback column list and the primary key are the shape as it stood
      // BEFORE `move`, so a column renamed alongside the table has to be mapped
      // through — otherwise the view is asked to project a name the table no
      // longer has.
      const cr = columnRenames.get(newName) ?? new Map<string, string>();
      await regenerateAudienceViewFromDb(
        db,
        newName,
        mapNames(shape.columns, cr),
        mapNames([...shape.pk], cr),
      );
      if (snapshot.masked.has(oldName)) moved.maskViews.push(`${newName}_v`);
    }
  }
  return moved;
}

/**
 * Rename columns on ONE table and carry EVERYTHING keyed to their names with
 * them — the counterpart of {@link renameTablesCarryingPolicy}, and the ONE
 * primitive any column rename must go through.
 *
 * The exposure it exists to close is the same one, one key deeper. Cloud column
 * masking lives in `__lattice_column_policy` keyed by (table, column) — BOTH
 * names. Renaming the table was hardened; renaming a COLUMN was not, and it
 * moves the physical column while leaving the policy row keyed to a column name
 * the table no longer has. The next rebuild of the `<t>_v` member read view
 * reads that policy back empty for the new name, concludes the column is not
 * masked, and projects it in cleartext to every member.
 *
 * Nothing else rescues it. The standing view's own definition IS treated as
 * evidence by {@link regenerateMemberReadView}, which is what saves a table
 * whose policy is lost — but that evidence names the OLD column, and a column
 * that is no longer among the table's physical columns is ignored. Carrying the
 * policy is the only fix.
 *
 * `move` performs the physical `ALTER TABLE ... RENAME COLUMN` (plus whatever
 * the caller keeps in step with it — the configuration document, the audit
 * record). It is bracketed, so it cannot run without the snapshot in front and
 * the carry behind:
 *
 *   before — record which of the columns the cloud masks, and the table's shape;
 *   move   — the caller's physical rename;
 *   after  — re-point every column-keyed bookkeeping store, then rebuild the
 *            member read view from the carried policy.
 *
 * The order after `move` is load-bearing for the same reason it is there:
 * rebuilding the view first would read the policy under a column name it has not
 * been moved to yet and find nothing.
 *
 * Throws {@link RenameRefused} rather than resolving that ambiguity in the
 * direction that exposes data — see {@link refuseUnmaskedColumns} for what the
 * workspace looks like when it does (safe, stale, healed by a reopen).
 */
export async function renameColumnsCarryingPolicy(
  db: Lattice,
  table: string,
  renames: ColumnRenames,
  move: () => Promise<void>,
): Promise<TableNamePolicyMove> {
  const onCloud = db.getDialect() === 'postgres' && (await cloudRlsInstalled(db));
  // Captured before the move: which columns are masked (keyed by the name they
  // still have), and the shape the view is rebuilt from. A rename changes
  // neither the column set nor the primary key, only the names in them.
  const maskedBefore = onCloud
    ? await snapshotMaskedColumns(db, table, renames)
    : new Set<string>();
  const registered = db.getRegisteredColumns(table);
  const columns = registered ? Object.keys(registered) : [];
  const pk = [...db.getPrimaryKey(table)];

  await move();

  const moved: TableNamePolicyMove = { rows: [], maskViews: [] };
  moved.rows.push(...(await carryColumnStores(db, table, renames)));
  if (!onCloud) return moved;

  await refuseUnmaskedColumns(db, table, renames, maskedBefore);
  await rebuildMemberReadViewForColumns(
    db,
    table,
    mapNames(columns, renames),
    mapNames(pk, renames),
  );
  if (maskedBefore.size > 0) moved.maskViews.push(`${table}_v`);
  return moved;
}

/**
 * Rename ONE column on a user table: the physical `ALTER TABLE ... RENAME
 * COLUMN`, whatever the caller keeps in step with it (the configuration entry
 * that names the field), and the full column-name carry — as one bracketed unit.
 *
 * The DDL lives HERE rather than in the route that calls it, for the same reason
 * the table-level rename does: the statement and the carry that has to bracket
 * it belong in one module, so a reader of the route cannot emit the one without
 * the other, and the structural guard has a single place to point at.
 *
 * Throws {@link RenameRefused} when the carry refuses; the caller reports it.
 */
export async function renameUserColumn(
  active: ActiveDb,
  table: string,
  from: string,
  to: string,
  keepInStep: () => void | Promise<void>,
): Promise<TableNamePolicyMove> {
  const q = (s: string): string => s.replace(/"/g, '""');
  return renameColumnsCarryingPolicy(active.db, table, new Map([[from, to]]), async () => {
    await execSql(active.db, `ALTER TABLE "${q(table)}" RENAME COLUMN "${q(from)}" TO "${q(to)}"`);
    await keepInStep();
  });
}

/**
 * Physically drop a column and take everything keyed to its name with it.
 *
 * Three things make this more than an `ALTER TABLE ... DROP COLUMN`:
 *
 *  1. On a cloud EVERY table is read through a `<t>_v` view, and Postgres
 *     refuses to drop a column another relation depends on — so without dropping
 *     the view first, dropping any column of any table simply fails.
 *  2. The per-column masking policy is keyed by (table, column). Left behind, it
 *     describes a column that does not exist, and the next column to be given
 *     that name inherits a mask nobody wrote for it — or, worse, an owner who
 *     re-adds the column believes it is masked when the view says otherwise.
 *  3. The view has to come back, and it has to come back by DROP + CREATE:
 *     `CREATE OR REPLACE VIEW` cannot drop a view's columns (SQLSTATE 42P16).
 *
 * Throws on failure, so a half-dropped column can never be reported as success.
 */
export async function dropColumnCarryingPolicy(
  db: Lattice,
  table: string,
  column: string,
): Promise<void> {
  const onCloud = db.getDialect() === 'postgres' && (await cloudRlsInstalled(db));
  const q = table.replace(/"/g, '""');
  if (onCloud) await execSql(db, `DROP VIEW IF EXISTS "${q}_v"`);
  await execSql(db, `ALTER TABLE "${q}" DROP COLUMN "${column.replace(/"/g, '""')}"`);
  for (const { store, tableColumn, nameColumn } of COLUMN_NAME_REFERENCES) {
    const columns = await introspectColumnsAsyncOrSync(db.adapter, store);
    if (!columns.includes(tableColumn) || !columns.includes(nameColumn)) continue;
    await runAsyncOrSync(
      db.adapter,
      `DELETE FROM "${store}" WHERE "${tableColumn}" = ? AND "${nameColumn}" = ?`,
      [table, column],
    );
  }
  if (!onCloud) return;
  const registered = db.getRegisteredColumns(table);
  await rebuildMemberReadViewForColumns(
    db,
    table,
    registered ? Object.keys(registered) : [],
    db.getPrimaryKey(table),
  );
}

/**
 * Rename a user table — and move EVERY other place that name is written.
 *
 * A rename used to move two things (the physical table, its configuration
 * entry) and leave the rest of the workspace pointing at a name that no longer
 * exists. This is the single primitive that moves all of them together:
 *
 *   • the configuration entry and the declared entity-context block;
 *   • every belongsTo relationship other tables declare against it;
 *   • the link tables NAMED after it, their `<table>_id` key column, and the
 *     relation whose name was derived from that column;
 *   • computed-table definitions that read from it (directly, or through a
 *     link table that was renamed with it);
 *   • the browsable per-table and per-column metadata rows (icon, definition,
 *     role);
 *   • the lineage trail, cached embeddings, graph edges and computed-fill state;
 *   • on a cloud, the sharing / ownership / column-visibility policies;
 *   • the source tables saved dashboards record;
 *   • the fingerprints of proposals the user already dismissed.
 *
 * Every cascade is derived from the CURRENT state rather than replayed from a
 * log, which makes the operation its own inverse: renaming back finds the same
 * referrers under the new name and moves them home. Recorded as the shared
 * revertible rename op, with the full inventory of what moved in its payload.
 *
 * Refuses — with a message, before writing anything — rather than half-applying.
 */
export async function renameUserEntity(
  active: ActiveDb,
  from: string,
  to: string,
  sessionId: string,
): Promise<RenameOutcome> {
  const fail = (error: string): RenameOutcome => ({ ok: false, error });
  if (!active.validTables.has(from)) return fail(`Unknown table: ${from}`);
  if (isNativeEntity(from)) return fail(`"${from}" is a built-in table and cannot be renamed.`);
  if (active.computedTables.has(from)) {
    return fail(`"${from}" is a computed table — rename it in its definition instead.`);
  }
  if (active.junctionTables.has(from)) {
    return fail(`"${from}" is a relationship table; it is named after the tables it links.`);
  }
  const connected = active.db.getConnectedSource(from);
  if (connected) {
    return fail(
      `"${from}" is a live view of a connected external data source, so its name comes from that source. ` +
        `Rename it there, or disconnect the connector.`,
    );
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(to)) return fail(`"${to}" is not a valid table name.`);
  if (from === to) return fail(`"${from}" is already named that.`);
  if (isNativeEntity(to)) return fail(`"${to}" is the name of a built-in table.`);
  if (active.validTables.has(to) || active.db.getRegisteredTableNames().includes(to)) {
    return fail(`A table called "${to}" already exists.`);
  }

  return active.db.withSchemaLock(async (): Promise<RenameOutcome> => {
    if (await physicalTableExists(active, to)) {
      return fail(`A table called "${to}" already exists.`);
    }
    const doc = loadConfigDoc(active.configPath);
    const entityDef: unknown = doc.getIn(['entities', from]);
    if (entityDef === undefined) {
      return fail(`"${from}" is not declared in this workspace's configuration.`);
    }

    // ── plan the whole cascade before writing anything ──────────────────────
    const links = linkTablesNamedAfter(active, from, to);
    for (const link of links) {
      if (
        link.to !== link.from &&
        (active.validTables.has(link.to) || active.db.getRegisteredTableNames().includes(link.to))
      ) {
        return fail(
          `Renaming "${from}" would also rename the link table "${link.from}" to "${link.to}", ` +
            `which already exists. Remove or rename that table first.`,
        );
      }
    }
    const config = doc.toJSON() as {
      entities?: Record<
        string,
        {
          fields?: Record<string, unknown>;
          relations?: Record<string, { type?: string; table?: string; foreignKey?: string }>;
          outputFile?: unknown;
        }
      >;
      computed?: Record<
        string,
        { base?: string; fields?: Record<string, { kind?: string; via?: string }> }
      >;
    };
    const renames = new Map<string, string>([[from, to]]);
    for (const link of links) renames.set(link.from, link.to);

    const cascade: RenameCascade = {
      relations: [],
      computed: [],
      linkTables: links,
      contextMoved: doc.getIn(['entityContexts', from]) !== undefined,
      rows: [],
      dashboards: 0,
      proposals: 0,
      maskViews: [],
    };

    // ── configuration: relationships pointing at anything being renamed ─────
    for (const [table, def] of Object.entries(config.entities ?? {})) {
      for (const [relName, rel] of Object.entries(def.relations ?? {})) {
        const moved = rel.table === undefined ? undefined : renames.get(rel.table);
        if (moved === undefined) continue;
        doc.setIn(['entities', table, 'relations', relName, 'table'], moved);
        cascade.relations.push({ table, relation: relName });
      }
    }

    // ── configuration: the table itself + its declared context block ────────
    doc.deleteIn(['entities', from]);
    doc.setIn(['entities', to], entityDef);
    const movedOverview = movedOutputFile(config.entities?.[from]?.outputFile, from, to);
    if (movedOverview) doc.setIn(['entities', to, 'outputFile'], movedOverview);
    if (cascade.contextMoved) {
      const ctxDef: unknown = doc.getIn(['entityContexts', from]);
      doc.deleteIn(['entityContexts', from]);
      doc.setIn(['entityContexts', to], ctxDef);
    }

    // ── configuration: link tables named after it ───────────────────────────
    for (const link of links) {
      const def = config.entities?.[link.from];
      if (!def) continue;
      const relations = def.relations ?? {};
      // The key column is named after the table by construction; the relation's
      // own name is that column with the `_id` stripped, so the two move together.
      const relEntry = Object.entries(relations).find(([, r]) => r.table === from);
      const oldColumn = relEntry?.[1].foreignKey;
      // Only a column NAMED after the table follows it; a hand-chosen key column
      // means something of its own and is left exactly as it is.
      const newColumn =
        typeof oldColumn === 'string' && oldColumn === `${from}_id` ? `${to}_id` : null;
      const oldRelName = relEntry?.[0];
      const derivedRelName =
        typeof oldColumn === 'string' && oldColumn.endsWith('_id')
          ? oldColumn.slice(0, -3)
          : oldColumn;
      // ...and the relation name follows only when it was itself derived from
      // that column (which is how every link table is built).
      const newRelName =
        newColumn !== null && oldRelName !== undefined && oldRelName === derivedRelName
          ? newColumn.slice(0, -3)
          : null;

      let fields = { ...(def.fields ?? {}) };
      let nextRelations: Record<string, unknown> = { ...relations };
      if (newColumn && typeof oldColumn === 'string') {
        fields = renameKey(fields, oldColumn, newColumn);
        link.column = { from: oldColumn, to: newColumn };
        for (const [k, r] of Object.entries(nextRelations)) {
          const rel = r as { foreignKey?: string };
          if (rel.foreignKey === oldColumn) nextRelations[k] = { ...rel, foreignKey: newColumn };
        }
      }
      if (newRelName && oldRelName) {
        nextRelations = renameKey(nextRelations, oldRelName, newRelName);
        link.relation = { from: oldRelName, to: newRelName };
      }
      // This block is rebuilt from the PRE-edit snapshot, so the relation
      // targets repointed above have to be applied to it again.
      for (const [k, r] of Object.entries(nextRelations)) {
        const rel = r as { table?: string };
        const moved = rel.table === undefined ? undefined : renames.get(rel.table);
        if (moved !== undefined) nextRelations[k] = { ...rel, table: moved };
      }
      const rebuilt: Record<string, unknown> = { ...def, fields, relations: nextRelations };
      const linkOverview = movedOutputFile(def.outputFile, link.from, link.to);
      if (linkOverview) rebuilt.outputFile = linkOverview;
      doc.deleteIn(['entities', link.from]);
      doc.setIn(['entities', link.to], rebuilt);
    }

    // ── configuration: computed-table definitions ───────────────────────────
    for (const [name, def] of Object.entries(config.computed ?? {})) {
      let touched = false;
      const movedBase = def.base === undefined ? undefined : renames.get(def.base);
      if (movedBase !== undefined) {
        doc.setIn(['computed', name, 'base'], movedBase);
        touched = true;
      }
      for (const [field, spec] of Object.entries(def.fields ?? {})) {
        if (spec.kind !== 'aggregate' || typeof spec.via !== 'string') continue;
        const dot = spec.via.indexOf('.');
        if (dot < 0) continue;
        const viaTable = spec.via.slice(0, dot);
        const movedVia = renames.get(viaTable);
        if (movedVia === undefined) continue;
        doc.setIn(['computed', name, 'fields', field, 'via'], `${movedVia}${spec.via.slice(dot)}`);
        touched = true;
      }
      if (touched) cascade.computed.push(name);
    }

    // ── the rename itself, bracketed by the policy carry ────────────────────
    // Everything that can be checked has been checked above (the target name is
    // free, every derived link-table name is free, the table is declared), so
    // the first statement inside the closure is the first write. The
    // configuration is saved only once every rename has succeeded, so a failure
    // there leaves the workspace describing the state it is actually in.
    //
    // The physical rename goes through the one primitive that also carries every
    // name-keyed store and the cloud's masking views with it — never a bare
    // ALTER TABLE, which is what strips a table's column masking.
    //
    // A link table also has its `<table>_id` key COLUMN renamed, and a column
    // name is keyed exactly as a table name is — including by the cloud's column
    // masking policy. Declared here, keyed by the link table's NEW name, so the
    // same primitive carries both halves of the key.
    const columnRenames = new Map<string, ColumnRenames>();
    for (const link of links) {
      if (link.column) columnRenames.set(link.to, new Map([[link.column.from, link.column.to]]));
    }
    let move: TableNamePolicyMove;
    try {
      move = await renameTablesCarryingPolicy(
        active.db,
        renames,
        async () => {
          for (const link of links) {
            if (link.column) {
              await execSql(
                active.db,
                `ALTER TABLE "${link.from}" RENAME COLUMN "${link.column.from}" TO "${link.column.to}"`,
              );
            }
            await execSql(active.db, `ALTER TABLE "${link.from}" RENAME TO "${link.to}"`);
          }
          await execSql(active.db, `ALTER TABLE "${from}" RENAME TO "${to}"`);
          saveConfigDoc(active.configPath, doc);

          // ── re-point the live workspace (no reopen) ───────────────────────
          const parsed = parseConfigFile(active.configPath);
          for (const [oldName, newName] of renames) {
            const entry = parsed.tables.find((t) => t.name === newName);
            if (!entry) {
              throw new RenameRefused(`"${newName}" could not be re-registered after the rename.`);
            }
            active.db.unregisterTable(oldName);
            await active.db.defineLate(newName, entry.definition);
            for (const set of [
              active.validTables,
              active.softDeletable,
              active.junctionTables,
              active.hiddenLinkTables,
            ]) {
              if (set.delete(oldName)) set.add(newName);
            }
            active.entityContextByTable.delete(oldName);
          }
          // A declared (non-canonical) entity context has to be re-registered
          // under the new name, or the table renders nothing until the next reopen.
          const declaredContext = parsed.entityContexts.find((e) => e.table === to);
          if (declaredContext) {
            active.db.redefineEntityContext(to, declaredContext.definition);
            active.entityContextByTable.set(to, declaredContext.definition);
          }
          syncCanonicalContexts(active);
        },
        columnRenames,
      );
    } catch (e) {
      if (e instanceof RenameRefused) return fail(e.message);
      throw e;
    }
    cascade.rows = move.rows;
    cascade.maskViews = move.maskViews;
    cascade.dashboards = await repointDashboards(active, renames);
    cascade.proposals = await repointProposals(active, renames);

    const auditId = await recordSchemaOp(
      active,
      'schema.rename_entity',
      to,
      { entity: from, cascade: inverted(cascade) },
      { entity: to, cascade },
      `Renamed table ${from} → ${to}`,
      sessionId,
    );
    return { ok: true, cascade, auditId };
  });
}

/** The same inventory as it stood BEFORE the rename — the `before` half of the
 *  audit record, so the entry describes both states rather than only the new one. */
function inverted(cascade: RenameCascade): RenameCascade {
  return {
    ...cascade,
    linkTables: cascade.linkTables.map((l) => ({
      from: l.to,
      to: l.from,
      ...(l.column ? { column: { from: l.column.to, to: l.column.from } } : {}),
      ...(l.relation ? { relation: { from: l.relation.to, to: l.relation.from } } : {}),
    })),
  };
}

/**
 * Apply one {@link ShapeOp} — the counterpart of the structural plan applier for
 * the ops that say what a table IS rather than how it is built. Both arms route
 * to the primitives above, so an applied shape op is stored (and, for a rename,
 * audited + revertible) exactly like any other schema change.
 */
export async function applyShapeOp(
  active: ActiveDb,
  op: ShapeOp,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  switch (op.kind) {
    case 'assign_role': {
      const role = op.evidence.role;
      if (!isTableRole(role)) {
        return { ok: false, error: `"${String(role)}" is not a table role.` };
      }
      const grain = op.evidence.grain;
      await setTableRole(
        active,
        op.target.table,
        role,
        'inferred',
        typeof grain === 'string' ? grain : null,
      );
      return { ok: true };
    }
    case 'rename_generic_table': {
      const to = op.target.toTable;
      if (!to) return { ok: false, error: 'no name to rename to' };
      const result = await renameUserEntity(active, op.target.table, to, sessionId);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
  }
}
