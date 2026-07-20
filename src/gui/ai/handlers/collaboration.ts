import type { DeleteResolution } from '../../schema-ops.js';
import { upsertColumnMeta, upsertTableMeta } from '../../column-descriptions.js';
import { setRowVisibility, rowAccessSummaries } from '../../../cloud/members.js';
import { cascadeDashboardDataShare } from '../../dashboard-share-cascade.js';
import { setTableDefaultVisibility } from '../../../cloud/table-policy.js';
import { canManageRoles } from '../../../framework/cloud-connect.js';
import { visibilityDenialReason } from './permission.js';
import { requireString, requireTable } from './helpers.js';
import { NOT_HANDLED, type HandlerDeps, type GroupResult } from './types.js';
import type { DispatchCtx, ComputedOps } from './types.js';
import type { ComputedTableDef } from '../../../config/types.js';

// Bookkeeping columns a derived view never mirrors (the base PK is auto-projected as `id`).
const CONNECTED_MIRROR_SKIP = new Set([
  '_pk',
  'id',
  'deleted_at',
  'created_at',
  'updated_at',
  '_source_connector_id',
  '_source_model',
  '_source_synced_at',
]);

/**
 * A data-model change (add_column, …) targeting a CONNECTED external table can't be applied
 * to the table itself — it is a live, read-only mirror synced from the source, and we never
 * ask the user to change the source. Instead the change is redirected onto a computed table
 * DERIVED from it. This ensures such a derived view exists (reusing one already built on this
 * base), mirroring the connected table's user-meaningful columns as alias passthroughs, so the
 * assistant can then author the requested field's formula on it.
 */
async function ensureDerivedComputedView(
  ctx: DispatchCtx,
  computedOps: ComputedOps,
  baseTable: string,
  naturalKey: string,
  modelLabel: string,
): Promise<{ name: string; created: boolean }> {
  // Reuse a computed table already derived from this connected base.
  const existing = (await computedOps.list()).find((t) => t.def.base === baseTable);
  if (existing) return { name: existing.name, created: false };

  // Mirror the connected columns as alias passthroughs; omit the base PK (auto-projected as
  // `id`) and the soft-delete / timestamp / connector-lineage bookkeeping columns.
  const cols = ctx.db.getRegisteredColumns(baseTable) ?? {};
  const pk = new Set(ctx.db.getPrimaryKey(baseTable));
  const fields: ComputedTableDef['fields'] = {};
  for (const c of Object.keys(cols)) {
    if (!CONNECTED_MIRROR_SKIP.has(c) && !pk.has(c)) fields[c] = { kind: 'alias', source: c };
  }
  // A computed view needs at least one field; fall back to the natural key.
  if (Object.keys(fields).length === 0) fields[naturalKey] = { kind: 'alias', source: naturalKey };

  // Deterministic, collision-safe name from the external model name.
  const stem =
    (modelLabel || baseTable)
      .replace(/[^a-z0-9_]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'source';
  const taken = (n: string): boolean =>
    ctx.validTables.has(n) || ctx.db.getRegisteredTableNames().includes(n);
  let viewName = stem + '_derived';
  for (let i = 2; taken(viewName); i++) viewName = stem + '_derived_' + String(i);

  await computedOps.create(viewName, { base: baseTable, fields });
  ctx.validTables.add(viewName);
  ctx.computedTables?.add(viewName);
  return { name: viewName, created: true };
}

export async function handleCollaboration(deps: HandlerDeps): Promise<GroupResult> {
  const { ctx, name, args } = deps;
  switch (name) {
    case 'set_definition': {
      const table = requireTable(args.table, ctx.validTables);
      const description = requireString(args.description, 'description');
      const column = typeof args.column === 'string' && args.column ? args.column : undefined;
      if (column) await upsertColumnMeta(ctx.db, table, column, { description });
      else await upsertTableMeta(ctx.db, table, { description });
      return { ok: true, result: { ok: true, table, ...(column ? { column } : {}) } };
    }
    case 'set_visibility': {
      // Make a record (id present) or a whole table (id absent) private or
      // visible to everyone. Cloud-only; the database enforces owner-only (the
      // call raises for anything the user doesn't own), so this respects the
      // user's access by construction.
      const table = requireTable(args.table, ctx.validTables);
      const visibility =
        args.visibility === 'everyone'
          ? 'everyone'
          : args.visibility === 'private'
            ? 'private'
            : null;
      if (!visibility) {
        return { ok: false, error: "visibility must be 'private' or 'everyone'" };
      }
      if (ctx.db.getDialect() !== 'postgres') {
        return {
          ok: false,
          error: 'Sharing settings only apply to a shared cloud workspace (this is a local one).',
        };
      }
      const id = typeof args.id === 'string' && args.id ? args.id : undefined;
      // Deterministic permission pre-check: surface a clear refusal to the
      // assistant when the caller can't change this sharing, instead of letting
      // it proceed and (previously) report success it didn't have permission
      // for. Mirrors — does not replace — the owner-only enforcement in the
      // Postgres RLS functions (kept as defense-in-depth in the catch below).
      const denial = id
        ? visibilityDenialReason({
            kind: 'row',
            rowAccess: (await rowAccessSummaries(ctx.db, table, [id])).get(id),
          })
        : visibilityDenialReason({
            kind: 'table',
            canManageTableDefault: await canManageRoles(ctx.db),
          });
      if (denial) return { ok: false, error: denial };
      try {
        if (id) {
          await setRowVisibility(ctx.db, table, id, visibility);
          // Sharing a dashboard to everyone cascades to the data it reads so the
          // recipients get a populated page. One-way: never on 'private'.
          if (table === 'dashboards' && visibility === 'everyone') {
            await cascadeDashboardDataShare(ctx.db, id, 'everyone');
          }
          return { ok: true, result: { table, id, visibility } };
        }
        await setTableDefaultVisibility(ctx.db, table, visibility);
        return { ok: true, result: { table, visibility, scope: 'table' } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    case 'create_entity': {
      if (!ctx.createEntity) {
        return { ok: false, error: 'Creating tables is not available in this context' };
      }
      const name = requireString(args.name, 'name');
      const columns = Array.isArray(args.columns)
        ? args.columns.filter((c): c is string => typeof c === 'string')
        : [];
      const created = await ctx.createEntity(name, columns);
      if (!created) {
        return {
          ok: false,
          error: `Could not create table "${name}" — the name is invalid, reserved, or a table by that name already exists.`,
        };
      }
      // Make the new table usable by later tool calls in this same turn.
      ctx.validTables.add(created);
      return { ok: true, result: { entity: created } };
    }
    case 'add_column': {
      if (!ctx.addColumn) {
        return { ok: false, error: 'Adding columns is not available in this context' };
      }
      const table = requireTable(args.table, ctx.validTables);
      const column = requireString(args.column, 'column');
      // A connected external table is a live, read-only mirror — its shape is synced from the
      // source, so we never ALTER it and never ask the user to touch the source. Redirect the
      // change deterministically onto a computed table DERIVED from it: ensure that derived
      // view exists, then hand off to the assistant to author the requested field's formula
      // there (a lookup/alias, a calc, or an AI field).
      const connected = ctx.db.getConnectedSource(table);
      if (connected) {
        if (!ctx.computedOps) {
          return {
            ok: false,
            error:
              `"${table}" is a live, read-only view of a connected external database, so a column ` +
              `can't be added to it. It needs a computed table derived from it, which isn't available here.`,
          };
        }
        const view = await ensureDerivedComputedView(
          ctx,
          ctx.computedOps,
          table,
          connected.naturalKey,
          connected.model,
        );
        return {
          ok: true,
          result: {
            connected_source: true,
            base_table: table,
            computed_table: view.name,
            created_computed_table: view.created,
            column,
            next:
              `"${table}" is a live, read-only view of a connected external database — a column can't ` +
              `be added to it directly, and its source must not be changed. I ` +
              `${view.created ? 'created' : 'am using the existing'} computed table "${view.name}" derived ` +
              `from it. Now add the "${column}" field to "${view.name}" by calling update_computed_table with ` +
              `the right formula: an alias to a linked table's column (e.g. look up a name via its id), a ` +
              `calc, or an AI field. Do NOT modify the source database or ask the user to.`,
          },
        };
      }
      const r = await ctx.addColumn(table, column);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: { table, column: r.column } };
    }
    case 'create_relationship': {
      if (!ctx.createJunction) {
        return { ok: false, error: 'Creating relationships is not available in this context' };
      }
      const a = requireTable(args.table_a, ctx.validTables);
      const b = requireTable(args.table_b, ctx.validTables);
      const j = await ctx.createJunction(a, b);
      if (!j) {
        return {
          ok: false,
          error: `Could not create a relationship between "${a}" and "${b}" (one may be native, a junction, or invalid).`,
        };
      }
      ctx.validTables.add(j.junction);
      ctx.junctionTables.add(j.junction);
      // Tell the model the junction name + the two FK columns to use with `link`.
      return {
        ok: true,
        result: {
          junction: j.junction,
          link_columns: { [j.aFk]: j.tableA, [j.bFk]: j.tableB },
        },
      };
    }
    case 'delete_entity': {
      const target = requireString(args.name, 'name');
      // A computed table is a stored DEFINITION, not data — deleting one drops
      // the definition (its source rows are untouched), so there is no row
      // count to resolve and no needsResolution round-trip: route straight to
      // the computed delete, which refuses while other computed tables are
      // built on it.
      if (ctx.computedTables?.has(target)) {
        if (!ctx.computedOps) {
          return { ok: false, error: 'Deleting computed tables is not available in this context' };
        }
        await ctx.computedOps.delete(target);
        // Keep the in-turn allowlists consistent with the deletion.
        ctx.validTables.delete(target);
        ctx.computedTables.delete(target);
        return { ok: true, result: { deleted: target, computed: true } };
      }
      if (!ctx.deleteEntity) {
        return { ok: false, error: 'Deleting tables is not available in this context' };
      }
      // Optional resolution for a NON-empty table: delete its data too, or move
      // it into another table. Omitted → the tool reports the table isn't empty
      // and the assistant must ask the user before retrying.
      let resolution: DeleteResolution | undefined;
      if (args.resolution === 'delete_data') resolution = 'delete_data';
      else if (typeof args.move_to === 'string' && args.move_to) {
        resolution = { move_to: args.move_to };
      }
      const outcome = await ctx.deleteEntity(target, resolution);
      // Not deleted (table not empty + no resolution): hand the question back to
      // the model as a successful tool result so it asks the user what to do.
      if ('needsResolution' in outcome) return { ok: true, result: outcome };
      if (!outcome.ok) return { ok: false, error: outcome.error };
      // Keep the in-turn allowlist consistent with the deletion.
      ctx.validTables.delete(target);
      ctx.junctionTables.delete(target);
      return { ok: true, result: outcome };
    }
    default:
      return NOT_HANDLED;
  }
}
