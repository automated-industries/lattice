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
import { getGuiEntities, type FileJunction } from './data.js';
import { assertNotComputedSource } from './computed-ops.js';
import type { ActiveDb } from './active-db.js';
import { secureNewCloudTable } from '../cloud/setup.js';
import { regenerateAudienceViewFromDb } from '../cloud/audience.js';
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
    ? `"${label}" is a live view of a connected external data source, so its columns are synced from there — a column added in Lattice would be dropped on the next sync. To add a field: add it in the source system (it will sync in), build a derived (computed) table from "${label}" that adds it, or create a separate object in Lattice and link these records to it.`
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
  const fwdResult: UserJunction = { junction: forward, tableA, aFk, tableB, bFk };
  const revResult: UserJunction = {
    junction: `${tableB}_${tableA}`,
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
    { column: col, type: 'text' },
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
): Promise<void> {
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
  | { ok: true; deleted: string; deletedRows?: number; movedRows?: number; rewiredLinks?: number }
  | { ok: false; error: string }
  | { needsResolution: true; rowCount: number; message: string };

/** Above this row count, the assistant refuses to auto-delete/move data. */
const AI_DELETE_ROW_CAP = 1000;

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
  const inbound: { table: string; relName: string; foreignKey: string }[] = [];
  for (const t of getGuiEntities(active.configPath, active.outputDir).tables) {
    if (t.name === name) continue;
    for (const [relName, rel] of Object.entries(t.relations)) {
      if (rel.type === 'belongsTo' && rel.table === name) {
        inbound.push({ table: t.name, relName, foreignKey: rel.foreignKey });
      }
    }
  }
  const isMove = resolution !== undefined && resolution !== 'delete_data';
  // Inbound links block a plain delete (there's nowhere to move them), but a MERGE
  // rewires them onto the target instead of refusing — the move_to path below
  // updates each foreign key to the moved rows and repoints its relation.
  if (inbound.length > 0 && !isMove) {
    return {
      ok: false,
      error: `Cannot delete "${name}" — these links point at it: ${inbound
        .map((l) => `${l.table}.${l.foreignKey}`)
        .join(
          ', ',
        )}. Merge "${name}" into another table to carry the links across, or remove those links first.`,
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

  // Empty → safe to remove straight away. (A merge that must also repoint inbound
  // links falls through to the move_to path even with zero rows.)
  if (rowCount === 0 && !(isMove && inbound.length > 0)) {
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
