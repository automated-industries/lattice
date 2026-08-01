import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http.js';
import type { GuiRequestContext } from './request-context.js';
import { getGuiEntities, type GuiTableSummary } from './data.js';
import { recordSchemaAudit } from './mutations.js';
import { loadConfigDoc, saveConfigDoc } from './config-io.js';
import { reopenSameConfig } from './lifecycle.js';
import {
  physicalTableExists,
  physicalColumnExists,
  emitDdlEnvelope,
  recordSchemaOp,
  materializeJunction,
  createUserEntity,
  softDeleteUserEntity,
  aiDeleteEntity,
  inboundLinksTo,
  describeInboundLinks,
  removeInboundLinks,
  AI_DELETE_ROW_CAP,
  renameUserEntity,
  purgeUserEntity,
  renameUserColumn,
  dropColumnCarryingPolicy,
  RenameRefused,
  addUserLink,
  removeUserLink,
  setColumnMeta,
  columnRefTarget,
  SCHEMA_SYSTEM_COLUMNS,
} from './schema-ops.js';
import { assertNotComputedSource } from './computed-ops.js';
import { fieldToSqliteBaseType } from '../config/parser.js';
import type { LatticeFieldDef } from '../config/types.js';
import { isNativeEntity } from '../framework/native-entities.js';
import {
  cloudRlsInstalled,
  canManageRoles,
  isScopedCloudMember,
} from '../framework/cloud-connect.js';
import { cloudErrorCode } from '../cloud/errors.js';
import { setTableDefaultVisibility, setTableNeverShare } from '../cloud/table-policy.js';

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

// The only column types a user may CREATE. `uuid` is reserved for keys
// (the id PK + foreign keys) and enforced by Lattice, not user-selectable.
const ALLOWED_COLUMN_TYPES = new Set(['text', 'integer', 'real', 'boolean']);

/**
 * Ordered, first-match dispatcher for the schema create/alter/delete routes.
 * server.ts calls it right after handleTablesRoutes and before the version-history
 * routes, preserving the request handler's original route order. Returns true iff
 * it handled the request. The interleaved PUT /api/gui-meta/columns/:t/:c route
 * keeps its relative position within the block.
 */
/**
 * Owner-gate for a config/DDL-mutating schema route on a secured cloud. Returns
 * true (and writes a 403) when the caller is a scoped member — postgres + RLS
 * installed + cannot manage roles. Returns false (no response written) for
 * local/sqlite, an unsecured cloud, or the owner, so the caller proceeds.
 *
 * These routes mutate the OWNER's on-disk config (saveConfigDoc is a raw
 * writeFileSync, which several run BEFORE any DB DDL) and/or run schema DDL —
 * neither of which Postgres RLS protects. So a scoped member could otherwise
 * corrupt the owner's config over HTTP even though RLS blocks the DB write.
 *
 * THIS IS NO LONGER THE RULE — it is this transport's early answer to it. The
 * rule itself now travels with each operation (see the shared owner gate), which
 * is what makes it apply to a command, to the assistant, and to a library call
 * as well; for a long time it lived only here, and a member refused in the
 * browser could perform the identical change from a terminal. What is left for
 * a route is refusing before it parses a body it will not use, and knowing that
 * "owner only" is 403 on HTTP. The wording is built from the same sentence the
 * operation raises, so the two cannot say different things about the same
 * situation.
 */
export async function denyIfNotCloudOwner(
  db: Parameters<typeof isScopedCloudMember>[0],
  res: ServerResponse,
  verb: string,
): Promise<boolean> {
  if (!(await isScopedCloudMember(db))) return false;
  sendJson(res, { error: `Only a cloud owner can ${verb}` }, 403);
  return true;
}

/**
 * Turn the tagged owner-only refusal a capability throws into this transport's
 * answer for it. Rethrows anything else — an unrecognised failure is a real
 * fault and must read as one.
 *
 * The gate itself lives with the operation, not here, so a command and a library
 * caller inherit it. What is left for the adapter is the part only the adapter
 * knows: that "owner only" is 403 on HTTP.
 */
export function denyOwnerOnly(e: unknown, res: ServerResponse): boolean {
  if (cloudErrorCode(e) !== 'cloud_owner_only') return false;
  sendJson(res, { error: (e as Error).message }, 403);
  return true;
}

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
  // @capability schema.create-table
  if (method === 'POST' && pathname === '/api/schema/entities') {
    if (await denyIfNotCloudOwner(active.db, res, 'create a table')) return true;
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
  // @capability schema.create-junction
  if (method === 'POST' && pathname === '/api/schema/junctions') {
    if (await denyIfNotCloudOwner(active.db, res, 'create a link table')) return true;
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
    // EXCLUSIVITY: a belongsTo nesting between the pair (either direction)
    // conflicts with a many-to-many — refuse with a distinct wording so the
    // client surfaces it (the duplicate-junction swallow must not eat this).
    const allTables = getGuiEntities(active.configPath, active.outputDir).tables;
    const nestsIn = (child: string, parent: string): boolean => {
      const t = allTables.find((x) => x.name === child);
      return (
        t !== undefined &&
        Object.values(t.relations).some((r) => r.type === 'belongsTo' && r.table === parent)
      );
    };
    if (left !== right && (nestsIn(left, right) || nestsIn(right, left))) {
      const child = nestsIn(left, right) ? left : right;
      const parent = child === left ? right : left;
      sendJson(
        res,
        {
          error: `"${child}" is nested inside "${parent}" — un-nest it before creating a relationship between them`,
        },
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
  // owner-gated, never drops a native entity, and REFUSES while a first-class
  // table still has a foreign key pointing at it (so a delete can never leave
  // dangling references / a broken data model) unless `?cascade=1` says to take
  // those rows too. Link tables that exist only to express a relationship with
  // this entity go with it either way — they are part of the relationship, not
  // independent objects, and could never be removed on their own. The client
  // gates this behind a type-the-name confirmation. The old, dangerous
  // DELETE /api/schema/junctions/:name route (which dropped a "junction"
  // inferred only from FK count, and so could drop a misclassified first-class
  // entity) has been removed.
  // @capability schema.delete-table
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
    if (active.computedTables.has(name)) {
      sendJson(
        res,
        {
          error: `"${name}" is a computed table — delete it via DELETE /api/computed-tables/${name}`,
        },
        400,
      );
      return true;
    }
    // Computed-source guard: refuse (naming the dependents, no cascade) while
    // any computed table still reads from this one.
    try {
      assertNotComputedSource(active, name);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    // Owner-gate: dropping a table mutates the owner's config; RLS alone doesn't
    // gate this DDL/config path.
    if (await denyIfNotCloudOwner(active.db, res, 'delete tables')) return true;
    // Inbound-link guard. Classification is shared with the assistant's delete
    // tool (inboundLinksTo) so the two guards read the model identically and
    // cannot drift apart.
    const inbound = inboundLinksTo(active, name);
    const externalLinks = inbound.filter((l) => !l.owned);
    const cascadeParam = url.searchParams.get('cascade');
    const cascade = cascadeParam === '1' || cascadeParam === 'true';
    if (externalLinks.length > 0 && !cascade) {
      sendJson(
        res,
        {
          error:
            `Cannot delete "${name}" — these links point at it: ` +
            `${await describeInboundLinks(active, externalLinks)}. Delete it together with those linked ` +
            `rows (cascade), or merge "${name}" into another table to carry the links across.`,
        },
        400,
      );
      return true;
    }
    // Remove the link side first — the link tables this entity owns, plus (only
    // when cascading) the rows that point at it. Audited + reversible, and
    // refused up front if the cascade is too large, so a refusal never leaves
    // the model half-deleted.
    const links = await removeInboundLinks(
      active,
      name,
      inbound,
      ctx.buildMutationCtx(),
      { cascade, rowBudget: AI_DELETE_ROW_CAP },
      sessionId,
    );
    if (!links.ok) {
      sendJson(res, { error: links.error }, 400);
      return true;
    }
    // SOFT delete: remove the entity from the config + live registry
    // (hiding it from the GUI) but DO NOT drop the SQL table — its rows
    // stay intact so the recorded `schema.delete_entity` op can be reverted
    // with no snapshot. No reopen (shared with the assistant's delete tool).
    // Physical removal is a separate, API-only `POST /api/schema/purge`.
    const undoId = await softDeleteUserEntity(active, name, sessionId);
    // `undoId` is the delete_entity audit id — the client offers a one-click undo
    // pointed at exactly this change (restores the table from the recorded def).
    sendJson(res, {
      ok: true,
      undoId,
      ...(links.cascadedLinkRows > 0 ? { cascadedLinkRows: links.cascadedLinkRows } : {}),
      ...(links.droppedLinkTables.length > 0 ? { droppedLinkTables: links.droppedLinkTables } : {}),
    });
    return true;
  }

  // Masking a column and defining it are one call because they are one operation:
  // the mask goes on the database first and the stored flag is what redacts the
  // value from the assistant. What stays here is reading the two fields off the
  // request and turning a refusal into a status.
  // @capability schema.set-column-meta
  if (method === 'PUT' && /^\/api\/gui-meta\/columns\/[^/]+\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/');
    const tableName = decodeURIComponent(parts[4] ?? '');
    const colName = decodeURIComponent(parts[5] ?? '');
    const body = (await readJson<unknown>(req)) as {
      secret?: unknown;
      description?: unknown;
    };
    let outcome;
    try {
      outcome = await setColumnMeta(active, tableName, colName, {
        ...('secret' in body ? { secret: body.secret === true } : {}),
        ...('description' in body
          ? { description: typeof body.description === 'string' ? body.description : null }
          : {}),
      });
    } catch (e) {
      // The gate travels with the operation, and it words its own refusal (which
      // reads differently for masking than for defining). Asking it, rather than
      // re-deciding here, is what keeps the two surfaces saying one thing.
      if (denyOwnerOnly(e, res)) return true;
      throw e;
    }
    if (!outcome.ok) {
      sendJson(res, { error: outcome.error }, 400);
      return true;
    }
    sendJson(res, { ok: true });
    return true;
  }

  // ── Cloud table policy: per-table default row visibility + never-share ──
  // Owner-only (Postgres cloud); the underlying SQL functions also raise for
  // a non-owner, so the gate here is defense-in-depth + a clean error.
  // @capability cloud.table-default-visibility
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
  // @capability cloud.table-never-share
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
  // @capability schema.rename-table
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/rename$/.test(pathname)) {
    if (await denyIfNotCloudOwner(active.db, res, 'rename a table')) return true;
    const oldName = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(oldName)) {
      sendJson(res, { error: `Unknown entity: ${oldName}` }, 400);
      return true;
    }
    if (isNativeEntity(oldName)) {
      sendJson(res, { error: `"${oldName}" is a built-in entity and cannot be modified` }, 400);
      return true;
    }
    if (active.computedTables.has(oldName)) {
      sendJson(res, { error: `"${oldName}" is a computed table and cannot be renamed` }, 400);
      return true;
    }
    // A connected external table is a live, read-only mirror: its rows sync under THIS name, so a
    // renamed copy would just re-sync under the original name and orphan the renamed one. Refuse
    // the shape change (mirrors the row-write + add/rename-column guards) — the mirror is read-only.
    if (active.db.getConnectedSource(oldName)) {
      sendJson(
        res,
        {
          error: `"${oldName}" is a live, read-only view of a connected external source and can't be renamed. To change what it's called, rename it in the source (or disconnect the connector).`,
        },
        400,
      );
      return true;
    }
    // A computed table's compiled SQL references its sources by name — a rename
    // would break those projections, so refuse while any depend on this table.
    try {
      assertNotComputedSource(active, oldName);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
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
    // Rename through the shared cascade primitive rather than a bare ALTER.
    // A table name is stored in many places — other tables' relations, the link
    // tables named after it, computed definitions, per-table and per-column
    // metadata, lineage, dashboards, and on a cloud the column policy and the
    // masking view members read through. Renaming only the table and the config
    // left every one of those pointing at a name that no longer exists.
    //
    // The cloud policy is the one that mattered most: the reopen below triggers
    // member-access reconciliation, which rebuilds the masking view from the
    // column policy. With the policy still keyed to the OLD name the rebuild
    // found nothing to mask, took the no-masking-needed branch, and re-granted
    // members raw SELECT — so every member silently gained cleartext read on
    // columns the owner had marked secret, while the GUI still showed them as
    // masked. The primitive repoints the policy and regenerates the view as part
    // of the rename, and refuses before writing anything rather than
    // half-applying. It records the revertible rename op itself, with the
    // inventory of what moved.
    const renamed = await renameUserEntity(active, oldName, newName, sessionId);
    if (!renamed.ok) {
      sendJson(res, { error: renamed.error }, 400);
      return true;
    }
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    active = ctx.active();
    // `undoId` is the rename_entity audit id — the client offers a one-click undo
    // that renames the table back (fails loudly if the old name is taken again).
    sendJson(res, { ok: true, cascade: renamed.cascade, undoId: renamed.auditId });
    return true;
  }
  // @capability schema.add-column
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/columns$/.test(pathname)) {
    if (await denyIfNotCloudOwner(active.db, res, "change a table's columns")) return true;
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
    // A column can be present in the database while the config no longer declares
    // it — removing a link deliberately leaves its column behind so the removal
    // stays revertible, and a config can drift for other reasons too. addColumn()
    // is idempotent: it skips the ALTER when the column is already there. So
    // declaring a field over one of those would quietly adopt whatever the old
    // column still holds, and the user would see the previous values appear under
    // a name they just created. Refuse, and say which situation this is.
    if ((await active.db.introspectColumns(entityName)).includes(colName)) {
      sendJson(
        res,
        {
          error:
            `"${colName}" already exists on ${entityName} in the database, left behind by an ` +
            `earlier definition, and still holds its values. Revert that change to get the ` +
            `column back with its data, or choose a different name.`,
        },
        409,
      );
      return true;
    }
    const sqliteType = fieldToSqliteBaseType(colType as LatticeFieldDef['type']);
    // Route the DDL through the library's own add-column capability rather than
    // emitting the statement here. It asserts both identifiers, takes the schema
    // lock so a concurrent add of the same column can't race, refreshes the
    // registered column set, and — on a cloud where the caller is a scoped member
    // with no ALTER privilege — goes through the owner-side helper instead of
    // failing. All of that is the database's job, not the request handler's.
    await active.db.addColumn(entityName, colName, sqliteType);
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
  // @capability schema.rename-column
  if (
    method === 'POST' &&
    /^\/api\/schema\/entities\/[^/]+\/columns\/[^/]+\/rename$/.test(pathname)
  ) {
    // Owner-only, like every other schema mutation in this file — renaming a table
    // (:515) and changing a table's columns (:588) are both gated, and this route
    // changes the shape of the shared schema exactly as they do. It was the single
    // schema-mutation route without the check.
    //
    // Postgres would refuse the DDL for a scoped member anyway, so this is not the
    // only thing between a member and the owner's schema. But relying on that means
    // the refusal arrives as a raw privilege error from inside a multi-step carry,
    // after the config edit has already been considered. An explicit gate refuses in
    // one place, before anything is touched, and says why.
    if (await denyIfNotCloudOwner(active.db, res, 'rename a column')) return true;
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
    // The rename goes through the one primitive that carries every COLUMN-name-
    // keyed store with it — never a bare rename statement of its own. On a
    // hosted workspace the per-column masking policy is keyed by (table,
    // column), so a bare rename strands the mask under a name the table no
    // longer has a column for, and the next rebuild of the member read view
    // serves the renamed column in cleartext to the whole team.
    //
    // The carry has to run while THIS `active` is still open — the reopen below
    // disposes it — so the configuration write is bracketed with the DDL and the
    // reopen stays outside.
    try {
      await renameUserColumn(active, entityName, colName, newCol, () => {
        const renamedFields: Record<string, unknown> = {};
        for (const k of Object.keys(fieldsObj)) {
          renamedFields[k === colName ? newCol : k] = fieldsObj[k];
        }
        doc.setIn(['entities', entityName, 'fields'], renamedFields);
        saveConfigDoc(active.configPath, doc);
      });
    } catch (err) {
      if (err instanceof RenameRefused) {
        sendJson(res, { error: err.message }, 400);
        return true;
      }
      throw err;
    }
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
  //
  // Both halves of a link — the foreign-key column and the belongsTo relation
  // over it — and the rules that keep the model coherent belong to the
  // capability, so a script inherits them. The owner-only rule is one of those
  // rules and moved with them: the capability throws the tagged refusal and this
  // adapter turns it into the status. What stays here is reading the target off
  // the request and the reopen this server needs for its own next request.
  // @capability schema.add-link
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/links$/.test(pathname)) {
    const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(entityName)) {
      sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { target?: unknown };
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    let outcome: Awaited<ReturnType<typeof addUserLink>>;
    try {
      outcome = await addUserLink(active, entityName, target, sessionId);
    } catch (e) {
      if (denyOwnerOnly(e, res)) return true;
      throw e;
    }
    if (!outcome.ok) {
      sendJson(res, { error: outcome.error }, 400);
      return true;
    }
    // The reopen is this server's own business: the next request has to see the
    // new column and the new relation. Nothing below reads `active` again.
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    sendJson(res, { ok: true, column: outcome.column });
    return true;
  }

  // ── Merge one entity into another (move rows, then remove the source) ──
  // Drag-to-merge in the Model → Tables explorer. Migrates every row of
  // <source> into <target> with the SAME reversible primitive the assistant uses
  // (aiDeleteEntity move_to): best-effort column mapping, soft-delete the
  // originals, then soft-delete the emptied source — all through the audited
  // mutation primitives, so the whole merge is reversible from history. The
  // delete leg unregisters the source in place (no reopen), exactly as the chat
  // delete_entity path does, so the bound `active` stays consistent. Owner-gated.
  // @capability schema.merge-tables
  if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/merge$/.test(pathname)) {
    const source = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!active.validTables.has(source)) {
      sendJson(res, { error: `Unknown entity: ${source}` }, 400);
      return true;
    }
    if (await denyIfNotCloudOwner(active.db, res, 'merge tables')) return true;
    const body = (await readJson<unknown>(req)) as { target?: unknown };
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!active.validTables.has(target)) {
      sendJson(res, { error: 'Target entity must exist' }, 400);
      return true;
    }
    if (source === target) {
      sendJson(res, { error: 'Cannot merge an entity into itself' }, 400);
      return true;
    }
    const outcome = await aiDeleteEntity(active, source, { move_to: target }, sessionId);
    // move_to is always supplied, so `needsResolution` is unreachable here — but
    // surface it rather than silently returning 200 if that ever changes.
    if ('needsResolution' in outcome) {
      sendJson(res, { error: outcome.message, rowCount: outcome.rowCount }, 400);
      return true;
    }
    // An ok:false here is a precondition failure (row cap exceeded, inbound FK,
    // native/junction target) — client-actionable, so 400, not a 500 server fault.
    if (!outcome.ok) {
      sendJson(res, { error: outcome.error }, 400);
      return true;
    }
    sendJson(res, {
      ok: true,
      merged: source,
      into: target,
      movedRows: outcome.movedRows ?? 0,
      rewiredLinks: outcome.rewiredLinks ?? 0,
    });
    return true;
  }

  // ── Destroy a link (drop the FK column) ──────────────────────────
  // Links are destroy-only and owner-gated. Each link is managed
  // individually — including the legs of a (pure) junction table — and
  // removing one hides only THAT foreign-key column, never a table. To remove
  // a whole table, use DELETE /api/schema/entities/:name.
  //
  // The removal is soft — the column and its values stay, so the recorded op
  // reverts with no snapshot — and that pairing belongs to the capability, as
  // does the owner-only rule (thrown tagged, mapped to a status here). What
  // stays here is the response and the reopen.
  // @capability schema.remove-link
  if (method === 'DELETE' && /^\/api\/schema\/entities\/[^/]+\/links\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/');
    const entityName = decodeURIComponent(parts[4] ?? '');
    const colName = decodeURIComponent(parts[6] ?? '');
    let outcome: Awaited<ReturnType<typeof removeUserLink>>;
    try {
      outcome = await removeUserLink(active, entityName, colName, sessionId);
    } catch (e) {
      if (denyOwnerOnly(e, res)) return true;
      throw e;
    }
    if (!outcome.ok) {
      sendJson(res, { error: outcome.error }, 400);
      return true;
    }
    ctx.swapActive(await reopenSameConfig(active, deps.autoRender));
    // `undoId` is the delete_link audit id — the client offers a one-click undo
    // that re-adds the link field + relation from the recorded def.
    sendJson(res, { ok: true, undoId: outcome.undoId });
    return true;
  }

  // ── Purge permanently (API only — NOT surfaced in the GUI) ────────
  // Soft-deleted tables/columns stay physically in the DB so they can be
  // reverted. This is the escape hatch to physically DROP an orphaned
  // (soft-deleted) object and reclaim space. Irreversible — after a purge,
  // the prior soft-delete can no longer be reverted (its data is gone).
  // @capability schema.purge
  if (method === 'POST' && pathname === '/api/schema/purge') {
    if (await denyIfNotCloudOwner(active.db, res, 'purge tables')) return true;
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
        // Takes the masking view and the name-keyed cloud policy with it — the
        // view because the table cannot be dropped while it depends on it, the
        // policy because the next table to take this name would otherwise
        // inherit this one's sharing, defaults and column masking.
        await purgeUserEntity(active, name);
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
      // Not a bare DROP COLUMN: on a hosted workspace the member read view
      // depends on the column (so the drop is refused outright without taking
      // the view down first), and the column's masking policy is keyed by its
      // name (so left behind, the next column given that name inherits a mask
      // nobody wrote for it).
      await dropColumnCarryingPolicy(active.db, name, column);
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
