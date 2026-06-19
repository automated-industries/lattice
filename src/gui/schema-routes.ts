import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http.js';
import type { GuiRequestContext } from './request-context.js';
import { getGuiEntities, type GuiTableSummary } from './data.js';
import { upsertColumnMeta } from './column-descriptions.js';
import { recordSchemaAudit } from './mutations.js';
import { execSql, loadConfigDoc, saveConfigDoc } from './config-io.js';
import { reopenSameConfig } from './lifecycle.js';
import {
  physicalTableExists,
  physicalColumnExists,
  emitDdlEnvelope,
  recordSchemaOp,
  materializeJunction,
  createUserEntity,
  softDeleteUserEntity,
} from './schema-ops.js';
import { fieldToSqliteBaseType } from '../config/parser.js';
import type { LatticeFieldDef } from '../config/types.js';
import { isNativeEntity } from '../framework/native-entities.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { setTableDefaultVisibility, setTableNeverShare } from '../cloud/table-policy.js';
import { setColumnAudience } from '../cloud/audience.js';

/**
 * Schema create/alter/delete routes, extracted from server.ts as the fourth
 * route module (after read-routes.ts, tables-routes.ts). A flat leaf mirroring
 * the established precedents: the same (req, res, ctx, deps) boolean-returning
 * contract, re-parsing url/method from the request. Unlike the read/tables
 * dispatchers, several of these routes mutate the active workspace via a
 * same-config reopen — they go through `ctx.swapActive` (the single active-DB
 * write-back path), exactly as the handler's inline `active = activeRef = next;
 * startBackgroundRender(next)` swaps did. No reopen here moves the served
 * workspace id (all are same-workspace reopens), so `swapActive` is called with
 * NO workspaceId argument — leaving the header label untouched.
 *
 * No moved route body is wrapped in a new try/catch: a schema route can throw
 * (FK conflict, owner-only, not-found), and those must propagate to server.ts's
 * existing outer catch (which maps them to 404 / 403 / 409). The two `try/catch`
 * blocks inside the purge route are part of the moved body verbatim (they map a
 * failed DROP to a 400) — they are not new.
 */

/**
 * Process-constant deps the schema routes need that are not per-request active-DB
 * state. `host` parses the request url (mirrors ReadRoutesDeps / TablesRoutesDeps);
 * `autoRender` is the workspace-mode flag the same-config reopen passes through.
 */
export interface SchemaRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. Closure const in server.ts. */
  host: string;
  /** Workspace-mode auto-render flag, threaded to `reopenSameConfig`. Closure const in server.ts. */
  autoRender: boolean;
}

// Structural columns Lattice manages — never renamable, retypable, deletable,
// or maskable from the GUI. `id` is the uuid primary key; the timestamps +
// soft-delete column carry semantics undo/redo + freshness depend on.
const SCHEMA_SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
// The only column types a user may CREATE. `uuid` is reserved for keys
// (the id PK + foreign keys) and enforced by Lattice, not user-selectable.
const ALLOWED_COLUMN_TYPES = new Set(['text', 'integer', 'real', 'boolean']);

/** The entity a column references (a foreign-key "link"), or null. */
function columnRefTarget(configPath: string, entity: string, col: string): string | null {
  // A "link" is now an entity-level `relations:` belongsTo entry whose
  // foreignKey is this column (the per-field `ref:` shorthand was removed in
  // 4.0). Find the belongsTo pointing at `col` and return its target table.
  const relsNode: unknown = loadConfigDoc(configPath).getIn(['entities', entity, 'relations']);
  if (!relsNode || typeof relsNode !== 'object') return null;
  const rels =
    typeof (relsNode as { toJSON?: unknown }).toJSON === 'function'
      ? (relsNode as { toJSON: () => Record<string, unknown> }).toJSON()
      : (relsNode as Record<string, unknown>);
  for (const rel of Object.values(rels)) {
    if (
      rel &&
      typeof rel === 'object' &&
      (rel as { type?: unknown }).type === 'belongsTo' &&
      (rel as { foreignKey?: unknown }).foreignKey === col
    ) {
      const table = (rel as { table?: unknown }).table;
      return typeof table === 'string' && table ? table : null;
    }
  }
  return null;
}

/**
 * Ordered, first-match dispatcher for the schema create/alter/delete routes.
 * server.ts calls it right after handleTablesRoutes and before the version-history
 * routes, preserving the request handler's original route order. Returns true iff
 * it handled the request. The interleaved PUT /api/gui-meta/columns/:t/:c route
 * keeps its relative position within the block.
 */
export async function handleSchemaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: SchemaRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  // Several routes below reopen the same config and swap the active DB. `active`
  // is bound from the live ctx and re-synced from `ctx.active()` after every swap
  // so the rest of that route body sees the reopened DB — referentially identical
  // to the handler's inline `active = activeRef = next`.
  let active = ctx.active();
  const sessionId = ctx.sessionId;

  // ── Create entity (additive — not in audit log, irreversible from GUI) ──
  if (method === 'POST' && pathname === '/api/schema/entities') {
    const body = (await readJson<unknown>(req)) as { name?: unknown; icon?: unknown };
    const entityName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(entityName)) {
      sendJson(res, { error: 'Entity name must be a valid identifier' }, 400);
      return true;
    }
    if (active.validTables.has(entityName)) {
      sendJson(res, { error: `Entity already exists: ${entityName}` }, 400);
      return true;
    }
    // A soft-deleted table of this name still exists physically (hidden).
    // Refuse rather than CREATE-collide or silently resurrect its data.
    if (await physicalTableExists(active, entityName)) {
      sendJson(
        res,
        {
          error: `A deleted entity "${entityName}" exists — revert it instead, or purge it first.`,
        },
        400,
      );
      return true;
    }
    // Delegate to the same no-reopen primitive the chat/ingest paths use
    // (one source of truth for table DDL + canonical-context + audit).
    // `normalize:false` preserves the user's typed name. Object ownership
    // is recorded by a Postgres RLS trigger at the database.
    const created = await createUserEntity(active, entityName, [], sessionId, {
      normalize: false,
    });
    if (!created) {
      sendJson(res, { error: `Could not create entity "${entityName}"` }, 400);
      return true;
    }
    if (typeof body.icon === 'string' && body.icon.trim()) {
      await active.db.insert('_lattice_gui_meta', {
        entity_name: created,
        icon: body.icon.trim(),
        updated_at: new Date().toISOString(),
      });
    }
    sendJson(res, { ok: true, name: created });
    return true;
  }

  // ── Create a many-to-many relationship (junction table) ──────────
  // Creates a junction table with two ref columns linking `left` and
  // `right`, so it surfaces as an m2m edge in the Data Model graph.
  if (method === 'POST' && pathname === '/api/schema/junctions') {
    const body = (await readJson<unknown>(req)) as {
      left?: unknown;
      right?: unknown;
      name?: unknown;
    };
    const left = typeof body.left === 'string' ? body.left.trim() : '';
    const right = typeof body.right === 'string' ? body.right.trim() : '';
    if (!active.validTables.has(left) || !active.validTables.has(right)) {
      sendJson(res, { error: 'Both entities must exist' }, 400);
      return true;
    }
    if (active.junctionTables.has(left) || active.junctionTables.has(right)) {
      sendJson(res, { error: 'Cannot link a junction table' }, 400);
      return true;
    }
    // One many-to-many link per pair (either direction): refuse if a
    // junction already connects `left` and `right`. Mirrors the picker's
    // client-side exclusion so the model can't accumulate A_B + B_A.
    const linksBoth = (j: GuiTableSummary): boolean => {
      const bt = Object.values(j.relations).filter((r) => r.type === 'belongsTo');
      const tables = new Set(bt.map((r) => r.table));
      return bt.length === 2 && tables.has(left) && tables.has(right);
    };
    const existingJunction = getGuiEntities(active.configPath, active.outputDir).tables.find(
      (j) => active.junctionTables.has(j.name) && linksBoth(j),
    );
    if (existingJunction) {
      sendJson(
        res,
        { error: `"${left}" and "${right}" are already linked (${existingJunction.name})` },
        400,
      );
      return true;
    }
    const requested = typeof body.name === 'string' ? body.name.trim() : '';
    const jName = requested || `${left}_${right}`;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(jName)) {
      sendJson(res, { error: 'Relationship name must be a valid identifier' }, 400);
      return true;
    }
    if (active.validTables.has(jName) || active.db.getRegisteredTableNames().includes(jName)) {
      sendJson(res, { error: `A table named "${jName}" already exists` }, 400);
      return true;
    }
    if (await physicalTableExists(active, jName)) {
      sendJson(
        res,
        {
          error: `A deleted relationship "${jName}" exists — revert it instead, or purge it first.`,
        },
        400,
      );
      return true;
    }
    // Self-referential m2m needs two distinct column names.
    const leftCol = `${left}_id`;
    const rightCol = left === right ? `${right}_id_2` : `${right}_id`;
    // Same no-reopen materialization the chat path uses. Object ownership
    // is recorded by a Postgres RLS trigger at the database.
    await materializeJunction(
      active,
      jName,
      leftCol,
      left,
      rightCol,
      right,
      `Linked ${left} ↔ ${right}`,
      sessionId,
    );
    sendJson(res, { ok: true, name: jName });
    return true;
  }

  // ── Delete a whole table (the single, explicit table-drop path) ───
  // This is the ONLY DROP TABLE in the GUI. It is deliberately guarded:
  // owner-gated, never drops a native entity, and REFUSES while any other
  // table still has a foreign key pointing at it (so a delete can never
  // leave dangling references / a broken data model — the user removes
  // those links first). The client gates this behind a type-the-name
  // confirmation. The old, dangerous DELETE /api/schema/junctions/:name
  // route (which dropped a "junction" inferred only from FK count, and so
  // could drop a misclassified first-class entity) has been removed.
  if (method === 'DELETE' && /^\/api\/schema\/entities\/[^/]+$/.test(pathname)) {
    const name = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(name)) {
      sendJson(res, { error: `Unknown entity: ${name}` }, 400);
      return true;
    }
    if (isNativeEntity(name)) {
      sendJson(res, { error: `"${name}" is a built-in entity and cannot be deleted` }, 400);
      return true;
    }
    // Inbound-FK guard: refuse if another table links to this one.
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
      sendJson(
        res,
        {
          error: `Cannot delete "${name}" — these links point at it: ${inbound.join(', ')}. Delete those links first.`,
        },
        400,
      );
      return true;
    }
    // SOFT delete: remove the entity from the config + live registry
    // (hiding it from the GUI) but DO NOT drop the SQL table — its rows
    // stay intact so the recorded `schema.delete_entity` op can be reverted
    // with no snapshot. No reopen (shared with the assistant's delete tool).
    // Physical removal is a separate, API-only `POST /api/schema/purge`.
    await softDeleteUserEntity(active, name, sessionId);
    sendJson(res, { ok: true });
    return true;
  }

  if (method === 'PUT' && /^\/api\/gui-meta\/columns\/[^/]+\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/');
    const tableName = decodeURIComponent(parts[4] ?? '');
    const colName = decodeURIComponent(parts[5] ?? '');
    if (!active.validTables.has(tableName)) {
      sendJson(res, { error: `Unknown table: ${tableName}` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as {
      secret?: unknown;
      description?: unknown;
    };
    const settingSecret = 'secret' in body;
    const settingDescription = 'description' in body;
    // Secret is meaningful only for scalar data columns. System columns
    // (id/created_at/updated_at/deleted_at) and links (FK columns) can't
    // be marked secret — enforce here so the data model stays clean. The
    // guard applies only when `secret` is being set; a description-only
    // write is fine on any column.
    if (settingSecret) {
      if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
        sendJson(
          res,
          { error: `"${colName}" is a system column and cannot be marked secret` },
          400,
        );
        return true;
      }
      if (columnRefTarget(active.configPath, tableName, colName)) {
        sendJson(res, { error: 'Link (foreign-key) columns cannot be marked secret' }, 400);
        return true;
      }
    }
    const secret: 0 | 1 = body.secret === true ? 1 : 0;
    // Consolidated find-or-insert (shared with the set_definition AI tool
    // and the auto-generators) — applies only the provided fields.
    await upsertColumnMeta(active.db, tableName, colName, {
      ...(settingSecret ? { secret } : {}),
      ...(settingDescription
        ? { description: typeof body.description === 'string' ? body.description : null }
        : {}),
    });
    // The `_lattice_gui_column_meta.secret` write above is the local
    // model-context redaction (the assistant never sees a secret value).
    // On a cloud (Postgres) DB, ALSO enforce it in the database: mask the
    // column to non-owners via the audience view, so a member's connection
    // can't read it at all. SQLite is a no-op inside setColumnAudience.
    if (settingSecret && active.db.getDialect() === 'postgres') {
      const columnNames = Object.keys(active.db.getRegisteredColumns(tableName) ?? {});
      const pkCols = active.db.getPrimaryKey(tableName);
      await setColumnAudience(
        active.db,
        tableName,
        colName,
        secret ? 'owner' : '',
        columnNames,
        pkCols,
      );
    }
    sendJson(res, { ok: true });
    return true;
  }

  // ── Cloud table policy: per-table default row visibility + never-share ──
  // Owner-only (Postgres cloud); the underlying SQL functions also raise for
  // a non-owner, so the gate here is defense-in-depth + a clean error.
  if (
    method === 'POST' &&
    /^\/api\/schema\/entities\/[^/]+\/default-row-visibility$/.test(pathname)
  ) {
    const table = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    if (active.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(active.db))) {
      sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
      return true;
    }
    if (!(await canManageRoles(active.db))) {
      sendJson(res, { error: 'Only a cloud owner can change default row visibility' }, 403);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { visibility?: unknown };
    const visibility = body.visibility === 'everyone' ? 'everyone' : 'private';
    if (body.visibility !== 'everyone' && body.visibility !== 'private') {
      sendJson(res, { error: "visibility must be 'private' or 'everyone'" }, 400);
      return true;
    }
    await setTableDefaultVisibility(active.db, table, visibility);
    sendJson(res, { ok: true, table, visibility });
    return true;
  }
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/never-share$/.test(pathname)) {
    const table = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    if (active.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(active.db))) {
      sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
      return true;
    }
    if (!(await canManageRoles(active.db))) {
      sendJson(res, { error: 'Only a cloud owner can change never-share' }, 403);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { on?: unknown };
    if (typeof body.on !== 'boolean') {
      sendJson(res, { error: 'on must be a boolean' }, 400);
      return true;
    }
    await setTableNeverShare(active.db, table, body.on);
    sendJson(res, { ok: true, table, on: body.on });
    return true;
  }

  // ── Schema editing (rename entity / add column / rename column) ──
  // All three mutate the YAML + apply a SQL ALTER, then re-open the
  // Lattice instance so the in-memory schema matches the new config.
  // We don't audit-log schema changes (they're structural, not data).
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/rename$/.test(pathname)) {
    const oldName = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(oldName)) {
      sendJson(res, { error: `Unknown entity: ${oldName}` }, 400);
      return true;
    }
    if (isNativeEntity(oldName)) {
      sendJson(res, { error: `"${oldName}" is a built-in entity and cannot be modified` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { to?: unknown };
    const newName = typeof body.to === 'string' ? body.to.trim() : '';
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(newName)) {
      sendJson(res, { error: 'New name must be a valid identifier' }, 400);
      return true;
    }
    if (active.validTables.has(newName)) {
      sendJson(res, { error: `Entity already exists: ${newName}` }, 400);
      return true;
    }
    await execSql(active.db, `ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
    const doc = loadConfigDoc(active.configPath);
    const entity: unknown = doc.getIn(['entities', oldName]);
    doc.deleteIn(['entities', oldName]);
    doc.setIn(['entities', newName], entity);
    // Also rename in entityContexts if present.
    if (doc.getIn(['entityContexts', oldName])) {
      const entCtx: unknown = doc.getIn(['entityContexts', oldName]);
      doc.deleteIn(['entityContexts', oldName]);
      doc.setIn(['entityContexts', newName], entCtx);
    }
    saveConfigDoc(active.configPath, doc);
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    await recordSchemaOp(
      active,
      'schema.rename_entity',
      newName,
      { entity: oldName },
      { entity: newName },
      `Renamed table ${oldName} → ${newName}`,
      sessionId,
    );
    sendJson(res, { ok: true });
    return true;
  }
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/columns$/.test(pathname)) {
    const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(entityName)) {
      sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
      return true;
    }
    if (isNativeEntity(entityName)) {
      sendJson(res, { error: `"${entityName}" is a built-in entity and cannot be modified` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as {
      name?: unknown;
      type?: unknown;
      required?: unknown;
      ref?: unknown;
    };
    const colName = typeof body.name === 'string' ? body.name.trim() : '';
    const colType = typeof body.type === 'string' ? body.type : 'text';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
      sendJson(res, { error: 'Column name must be a valid identifier' }, 400);
      return true;
    }
    if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
      sendJson(res, { error: `"${colName}" is a reserved system column` }, 400);
      return true;
    }
    // Scalar data columns only. uuid is reserved for keys; relationships
    // ("links") are created via the dedicated links endpoint, not here.
    if (!ALLOWED_COLUMN_TYPES.has(colType)) {
      sendJson(res, { error: 'Column type must be one of: text, integer, real, boolean' }, 400);
      return true;
    }
    if (typeof body.ref === 'string' && body.ref) {
      sendJson(res, { error: 'Use “Add link” to create a relationship column' }, 400);
      return true;
    }
    // Validate the config edit BEFORE touching SQL so a failed config
    // mutation can never leave the physical schema ahead of the YAML
    // (no drift). The fields map must exist (it won't for a
    // table that isn't a declared config entity) and must not already
    // carry this column.
    const doc = loadConfigDoc(active.configPath);
    const fieldsNode: unknown = doc.getIn(['entities', entityName, 'fields']);
    if (
      !fieldsNode ||
      typeof fieldsNode !== 'object' ||
      typeof (fieldsNode as { toJSON?: unknown }).toJSON !== 'function'
    ) {
      sendJson(res, { error: `Cannot add columns to "${entityName}"` }, 400);
      return true;
    }
    const existingFields = (fieldsNode as { toJSON: () => Record<string, unknown> }).toJSON();
    if (colName in existingFields) {
      sendJson(res, { error: `Column "${colName}" already exists on ${entityName}` }, 400);
      return true;
    }
    const sqliteType = fieldToSqliteBaseType(colType as LatticeFieldDef['type']);
    await execSql(active.db, `ALTER TABLE "${entityName}" ADD COLUMN "${colName}" ${sqliteType}`);
    const fieldDef: Record<string, unknown> = { type: colType };
    if (body.required === true) fieldDef.required = true;
    doc.setIn(['entities', entityName, 'fields', colName], fieldDef);
    saveConfigDoc(active.configPath, doc);
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    await recordSchemaOp(
      active,
      'schema.add_column',
      entityName,
      null,
      { entity: entityName, column: colName, fieldDef },
      `Added column ${colName} to ${entityName}`,
      sessionId,
    );
    sendJson(res, { ok: true });
    return true;
  }
  if (
    method === 'POST' &&
    /^\/api\/schema\/entities\/[^/]+\/columns\/[^/]+\/rename$/.test(pathname)
  ) {
    const parts = pathname.split('/');
    const entityName = decodeURIComponent(parts[4] ?? '');
    const colName = decodeURIComponent(parts[6] ?? '');
    if (!active.validTables.has(entityName)) {
      sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
      return true;
    }
    if (isNativeEntity(entityName)) {
      sendJson(res, { error: `"${entityName}" is a built-in entity and cannot be modified` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { to?: unknown };
    const newCol = typeof body.to === 'string' ? body.to.trim() : '';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newCol)) {
      sendJson(res, { error: 'New column name must be a valid identifier' }, 400);
      return true;
    }
    if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
      sendJson(res, { error: `Cannot rename the system column "${colName}"` }, 400);
      return true;
    }
    if (columnRefTarget(active.configPath, entityName, colName)) {
      sendJson(res, { error: 'Foreign-key (link) column names cannot be changed' }, 400);
      return true;
    }
    if (SCHEMA_SYSTEM_COLUMNS.has(newCol)) {
      sendJson(res, { error: `"${newCol}" is a reserved system column` }, 400);
      return true;
    }
    // Validate the config edit BEFORE touching SQL (a failed
    // YAML mutation must never leave the physical column renamed ahead of
    // the config). Rebuild the fields map by key (object-safe) rather than
    // deleteIn+setIn on the deep path.
    const doc = loadConfigDoc(active.configPath);
    const fieldsNode: unknown = doc.getIn(['entities', entityName, 'fields']);
    if (
      !fieldsNode ||
      typeof fieldsNode !== 'object' ||
      typeof (fieldsNode as { toJSON?: unknown }).toJSON !== 'function'
    ) {
      sendJson(res, { error: `Cannot rename columns on "${entityName}"` }, 400);
      return true;
    }
    const fieldsObj = (fieldsNode as { toJSON: () => Record<string, unknown> }).toJSON();
    if (!(colName in fieldsObj)) {
      sendJson(res, { error: `Unknown column "${colName}" on ${entityName}` }, 400);
      return true;
    }
    if (newCol in fieldsObj) {
      sendJson(res, { error: `Column "${newCol}" already exists on ${entityName}` }, 400);
      return true;
    }
    await execSql(
      active.db,
      `ALTER TABLE "${entityName}" RENAME COLUMN "${colName}" TO "${newCol}"`,
    );
    const renamedFields: Record<string, unknown> = {};
    for (const k of Object.keys(fieldsObj)) {
      renamedFields[k === colName ? newCol : k] = fieldsObj[k];
    }
    doc.setIn(['entities', entityName, 'fields'], renamedFields);
    saveConfigDoc(active.configPath, doc);
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    await recordSchemaOp(
      active,
      'schema.rename_column',
      entityName,
      { entity: entityName, column: colName },
      { entity: entityName, column: newCol },
      `Renamed column ${colName} → ${newCol} on ${entityName}`,
      sessionId,
    );
    sendJson(res, { ok: true });
    return true;
  }

  // ── Add a link (foreign key) from an entity to another ───────────
  // A "link" is a relationship, distinct from a scalar column: it adds a
  // uuid FK column referencing `target`. Links can't be edited once
  // created — only destroyed (below). Owner-gated.
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/links$/.test(pathname)) {
    const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(entityName)) {
      sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { target?: unknown };
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!active.validTables.has(target)) {
      sendJson(res, { error: 'Target entity must exist' }, 400);
      return true;
    }
    if (active.junctionTables.has(target)) {
      sendJson(res, { error: 'Cannot link to a junction table' }, 400);
      return true;
    }
    // One link per target via this control: refuse if the entity already
    // has a foreign key pointing at `target` (the UI also excludes it
    // from the picker). Keeps the data model clean and avoids the
    // accidental <target>_id / <target>_id_2 duplication.
    const summary = getGuiEntities(active.configPath, active.outputDir).tables.find(
      (t) => t.name === entityName,
    );
    const alreadyLinked =
      summary !== undefined &&
      Object.values(summary.relations).some((r) => r.type === 'belongsTo' && r.table === target);
    if (alreadyLinked) {
      sendJson(res, { error: `"${entityName}" already links to "${target}"` }, 400);
      return true;
    }
    // Name the FK <target>_id, de-duplicating against existing columns.
    const existingCols = new Set(Object.keys(active.db.getRegisteredColumns(entityName) ?? {}));
    let colName = `${target}_id`;
    let n = 2;
    while (existingCols.has(colName)) colName = `${target}_id_${String(n++)}`;
    const linkType = fieldToSqliteBaseType('uuid');
    await execSql(active.db, `ALTER TABLE "${entityName}" ADD COLUMN "${colName}" ${linkType}`);
    // Write a plain FK field plus an explicit entity-level belongsTo relation
    // (the per-field `ref:` shorthand was removed in 4.0). The relation name
    // mirrors the old derivation: the column with a trailing `_id` stripped.
    const linkFieldDef = { type: 'uuid' };
    const relName = colName.endsWith('_id') ? colName.slice(0, -3) : colName;
    const relation = { type: 'belongsTo', table: target, foreignKey: colName };
    const doc = loadConfigDoc(active.configPath);
    doc.setIn(['entities', entityName, 'fields', colName], linkFieldDef);
    doc.setIn(['entities', entityName, 'relations', relName], relation);
    saveConfigDoc(active.configPath, doc);
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    await recordSchemaOp(
      active,
      'schema.add_link',
      entityName,
      null,
      {
        entity: entityName,
        column: colName,
        fieldDef: linkFieldDef,
        relationName: relName,
        relation,
      },
      `Added link ${entityName} → ${target}`,
      sessionId,
    );
    sendJson(res, { ok: true, column: colName });
    return true;
  }

  // ── Destroy a link (drop the FK column) ──────────────────────────
  // Links are destroy-only and owner-gated. Each link is managed
  // individually — including the legs of a (pure) junction table — and
  // dropping one only drops THAT foreign-key column (ALTER TABLE DROP
  // COLUMN), never a table. To remove a whole table, use
  // DELETE /api/schema/entities/:name.
  if (method === 'DELETE' && /^\/api\/schema\/entities\/[^/]+\/links\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/');
    const entityName = decodeURIComponent(parts[4] ?? '');
    const colName = decodeURIComponent(parts[6] ?? '');
    if (!active.validTables.has(entityName)) {
      sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
      return true;
    }
    const target = columnRefTarget(active.configPath, entityName, colName);
    if (!target) {
      sendJson(res, { error: `Not a link column: ${colName}` }, 400);
      return true;
    }
    // SOFT delete: remove the FK field AND its belongsTo relation from the
    // config (hiding the link) but DO NOT drop the SQL column — its values
    // stay, so revert restores them with no snapshot. The relation is now a
    // separate entity-level entry (the per-field `ref:` shorthand was removed
    // in 4.0), so deleting the field alone would leave an orphaned relation
    // pointing at a missing column — both must go, and both come back on
    // revert. Capture the field def + relation (name + spec) first.
    const doc = loadConfigDoc(active.configPath);
    const entityJs = (
      doc.toJS() as {
        entities?: Record<
          string,
          { fields?: Record<string, unknown>; relations?: Record<string, unknown> }
        >;
      }
    ).entities?.[entityName];
    const deletedFieldDef = entityJs?.fields?.[colName];
    const relationEntries = Object.entries(entityJs?.relations ?? {});
    const deletedRelation = relationEntries.find(
      ([, rel]) =>
        rel != null &&
        typeof rel === 'object' &&
        (rel as { type?: unknown }).type === 'belongsTo' &&
        (rel as { foreignKey?: unknown }).foreignKey === colName,
    );
    const deletedRelationName = deletedRelation?.[0];
    const deletedRelationDef = deletedRelation?.[1];
    doc.deleteIn(['entities', entityName, 'fields', colName]);
    if (deletedRelationName !== undefined) {
      doc.deleteIn(['entities', entityName, 'relations', deletedRelationName]);
    }
    saveConfigDoc(active.configPath, doc);
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    await recordSchemaOp(
      active,
      'schema.delete_link',
      entityName,
      {
        entity: entityName,
        column: colName,
        fieldDef: deletedFieldDef,
        ...(deletedRelationName !== undefined
          ? { relationName: deletedRelationName, relation: deletedRelationDef }
          : {}),
      },
      null,
      `Deleted link ${entityName} → ${target}`,
      sessionId,
    );
    sendJson(res, { ok: true });
    return true;
  }

  // ── Purge permanently (API only — NOT surfaced in the GUI) ────────
  // Soft-deleted tables/columns stay physically in the DB so they can be
  // reverted. This is the escape hatch to physically DROP an orphaned
  // (soft-deleted) object and reclaim space. Irreversible — after a purge,
  // the prior soft-delete can no longer be reverted (its data is gone).
  if (method === 'POST' && pathname === '/api/schema/purge') {
    const body = (await readJson<unknown>(req)) as {
      type?: unknown;
      name?: unknown;
      column?: unknown;
    };
    const type = body.type === 'column' ? 'column' : 'table';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const column = typeof body.column === 'string' ? body.column.trim() : '';
    if (!name) {
      sendJson(res, { error: 'name is required' }, 400);
      return true;
    }
    if (type === 'table') {
      // Must be orphaned: physically present but NOT live (soft-deleted).
      if (active.validTables.has(name)) {
        sendJson(
          res,
          { error: `"${name}" is a live table — soft-delete it first, then purge.` },
          400,
        );
        return true;
      }
      if (!(await physicalTableExists(active, name))) {
        sendJson(res, { error: `No soft-deleted table "${name}" to purge` }, 400);
        return true;
      }
      try {
        await execSql(active.db, `DROP TABLE IF EXISTS "${name}"`);
      } catch (err) {
        sendJson(
          res,
          {
            error: `Failed to purge "${name}": ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
        return true;
      }
      // Best-effort gui-meta cleanup (icon + column secret flags).
      for (const meta of [
        { table: '_lattice_gui_meta', col: 'entity_name' },
        { table: '_lattice_gui_column_meta', col: 'table_name' },
      ]) {
        const rows = (await active.db.query(meta.table, {
          filters: [{ col: meta.col, op: 'eq', val: name }],
        })) as { id: string }[];
        for (const r of rows) await active.db.delete(meta.table, r.id);
      }
      await recordSchemaAudit(
        active.db,
        active.feed,
        name,
        'schema.purge',
        { entity: name, type: 'table' },
        null,
        `Purged table ${name}`,
        'gui',
        sessionId,
      );
      await emitDdlEnvelope(active, name);
      sendJson(res, { ok: true });
      return true;
    }
    // type === 'column': the table is live, the column physically present
    // but not in the config (soft-deleted link/column).
    if (!column) {
      sendJson(res, { error: 'column is required for a column purge' }, 400);
      return true;
    }
    if (!active.validTables.has(name)) {
      sendJson(res, { error: `Unknown table: ${name}` }, 400);
      return true;
    }
    const registered = active.db.getRegisteredColumns(name) ?? {};
    if (column in registered) {
      sendJson(
        res,
        { error: `"${column}" is a live column — soft-delete it first, then purge.` },
        400,
      );
      return true;
    }
    if (!(await physicalColumnExists(active, name, column))) {
      sendJson(res, { error: `No soft-deleted column "${column}" on "${name}" to purge` }, 400);
      return true;
    }
    try {
      await execSql(active.db, `ALTER TABLE "${name}" DROP COLUMN "${column}"`);
    } catch (err) {
      sendJson(
        res,
        {
          error: `Failed to purge "${column}": ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
      return true;
    }
    await recordSchemaAudit(
      active.db,
      active.feed,
      name,
      'schema.purge',
      { entity: name, column, type: 'column' },
      null,
      `Purged column ${column} from ${name}`,
      'gui',
      sessionId,
    );
    await emitDdlEnvelope(active, name);
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
