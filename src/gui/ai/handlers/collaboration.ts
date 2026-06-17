import type { DeleteResolution } from '../../schema-ops.js';
import { upsertColumnMeta, upsertTableMeta } from '../../column-descriptions.js';
import { setRowVisibility, rowAccessSummaries } from '../../../cloud/members.js';
import { setTableDefaultVisibility } from '../../../cloud/table-policy.js';
import { canManageRoles } from '../../../framework/cloud-connect.js';
import { visibilityDenialReason } from './permission.js';
import { requireString, requireTable } from './helpers.js';
import { NOT_HANDLED, type HandlerDeps, type GroupResult } from './types.js';

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
      if (!ctx.deleteEntity) {
        return { ok: false, error: 'Deleting tables is not available in this context' };
      }
      const target = requireString(args.name, 'name');
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
