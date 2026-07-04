import type { ComputedTableDef, ComputedFieldDef } from '../../../config/types.js';
import { narrowComputedDef } from '../../../config/parser.js';
import { requireString } from './helpers.js';
import { NOT_HANDLED, type HandlerDeps, type GroupResult, type DispatchResult } from './types.js';

/**
 * Computed-table tool group: preview / create / update / refresh. Every
 * mutation runs through the `ctx.computedOps` closure bundle the server
 * injects — the same audited, revertible primitives the computed-table
 * builder routes use — so an assistant-made computed table lands in the
 * activity feed and the session undo stack exactly like a builder action.
 *
 * The tools take `fields` as an ARRAY of `{name, kind, ...}` objects (the
 * shape a model produces most reliably); this group normalizes that into the
 * `Record<name, ComputedFieldDef>` the engine defines, preserving order, and
 * validates each field through the SAME config narrower the YAML and HTTP
 * paths use — the assistant can never accept a definition those would reject.
 */

/** Preview row cap: enough to judge a definition, small enough for a prompt. */
const PREVIEW_DEFAULT_LIMIT = 10;
const PREVIEW_MAX_LIMIT = 50;

const NOT_AVAILABLE: DispatchResult = {
  ok: false,
  error: 'Computed tables are not available in this context',
};

/** One `{name, kind, ...}` array item, split into the field name + raw definition. */
interface FieldItem {
  name: string;
  raw: Record<string, unknown>;
}

/**
 * Normalize a tool call's field array. Structural checks only (an array of
 * objects, non-empty string names, no duplicates) — the per-kind shape rules
 * stay with {@link narrowComputedDef}, the shared validator.
 */
function parseFieldItems(raw: unknown, label: string): FieldItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label} must be a non-empty array of {name, kind, ...} field objects`);
  }
  const items: FieldItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`every ${label} item must be an object with a "name" and a "kind"`);
    }
    const { name, ...rest } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`every ${label} item needs a non-empty string "name"`);
    }
    const trimmed = name.trim();
    if (seen.has(trimmed)) throw new Error(`duplicate field name "${trimmed}" in ${label}`);
    seen.add(trimmed);
    items.push({ name: trimmed, raw: rest });
  }
  return items;
}

/**
 * Shape-validate each field item independently through the shared config
 * narrower, so a bad field is reported BY NAME instead of aborting the whole
 * definition at the first problem. Returns the fields that passed (in item
 * order) plus a per-field error list.
 */
function shapeFields(
  table: string,
  base: string,
  items: FieldItem[],
): { fields: Record<string, ComputedFieldDef>; errors: { name: string; error: string }[] } {
  const fields: Record<string, ComputedFieldDef> = {};
  const errors: { name: string; error: string }[] = [];
  for (const item of items) {
    try {
      const def = narrowComputedDef(table, { base, fields: { [item.name]: item.raw } });
      const field = def.fields[item.name];
      if (field) fields[item.name] = field;
    } catch (e) {
      errors.push({ name: item.name, error: (e as Error).message });
    }
  }
  return { fields, errors };
}

/** Fold per-field errors into one actionable message for the model. */
function fieldErrorSummary(errors: { name: string; error: string }[], okNames: string[]): string {
  return (
    `${String(errors.length)} field(s) failed — fix these and preview again: ` +
    errors.map((f) => `${f.name}: ${f.error}`).join('; ') +
    (okNames.length > 0 ? `. Fields that compiled cleanly: ${okNames.join(', ')}.` : '')
  );
}

export async function handleComputed(deps: HandlerDeps): Promise<GroupResult> {
  const { ctx, name, args } = deps;
  switch (name) {
    case 'preview_computed_table': {
      if (!ctx.computedOps) return NOT_AVAILABLE;
      const base = requireString(args.base, 'base');
      const items = parseFieldItems(args.fields, 'fields');
      const limit = Math.min(
        PREVIEW_MAX_LIMIT,
        Math.max(
          1,
          typeof args.limit === 'number' ? Math.floor(args.limit) : PREVIEW_DEFAULT_LIMIT,
        ),
      );
      const { fields, errors } = shapeFields('preview', base, items);

      // Whole-definition dry run when every field passed shape validation.
      let wholeDefError: string | null = null;
      if (errors.length === 0) {
        try {
          const p = await ctx.computedOps.preview({ base, fields }, limit);
          const hasAi = Object.keys(p.pendingAi).length > 0;
          // The compiled SQL is deliberately omitted from the result: it is
          // bulky, and the assistant must never surface SQL to the user anyway.
          return {
            ok: true,
            result: {
              columns: p.columns,
              rowCount: p.rows.length,
              rows: p.rows,
              ...(hasAi
                ? {
                    pendingAiValues: p.pendingAi,
                    note:
                      'AI fields read as empty in a preview — their values are filled after ' +
                      'the table is created (and by refresh_computed_table).',
                  }
                : {}),
            },
          };
        } catch (e) {
          wholeDefError = (e as Error).message;
        }
      }

      // Something failed. Probe each shape-valid field ALONE (fields never
      // reference each other, only the base) so the error names exactly the
      // failing field(s) and the model can fix those and keep the rest.
      const failing = [...errors];
      const okNames: string[] = [];
      for (const [fieldName, fieldDef] of Object.entries(fields)) {
        try {
          await ctx.computedOps.preview({ base, fields: { [fieldName]: fieldDef } }, 1);
          okNames.push(fieldName);
        } catch (e) {
          failing.push({ name: fieldName, error: (e as Error).message });
        }
      }
      if (failing.length === 0) {
        // Every field compiles alone but the whole definition failed — a
        // definition-level problem (e.g. an unknown base); report it as-is.
        return { ok: false, error: wholeDefError ?? 'preview failed' };
      }
      return { ok: false, error: fieldErrorSummary(failing, okNames) };
    }

    case 'create_computed_table': {
      if (!ctx.computedOps) return NOT_AVAILABLE;
      const tableName = requireString(args.name, 'name').trim();
      const base = requireString(args.base, 'base');
      const items = parseFieldItems(args.fields, 'fields');
      const { fields, errors } = shapeFields(tableName, base, items);
      if (errors.length > 0) {
        return { ok: false, error: fieldErrorSummary(errors, Object.keys(fields)) };
      }
      await ctx.computedOps.create(tableName, { base, fields });
      // Make the new view usable by later tool calls in this same turn
      // (mirrors create_entity's allowlist update).
      ctx.validTables.add(tableName);
      ctx.computedTables?.add(tableName);
      return { ok: true, result: { created: tableName } };
    }

    case 'update_computed_table': {
      if (!ctx.computedOps) return NOT_AVAILABLE;
      const tableName = requireString(args.name, 'name');
      if (args.set_fields === undefined && args.remove_fields === undefined) {
        return {
          ok: false,
          error: 'Provide set_fields and/or remove_fields — there is nothing to change.',
        };
      }
      const existing = (await ctx.computedOps.list()).find((t) => t.name === tableName);
      if (!existing) return { ok: false, error: `Unknown computed table "${tableName}"` };

      // Merge onto the EXISTING definition: removals first, then set_fields
      // replacing in place by field name (declaration order preserved) with
      // unmatched names appended. The base never changes on an update.
      const entries: [string, ComputedFieldDef][] = Object.entries(existing.def.fields);
      if (args.remove_fields !== undefined) {
        const raw = args.remove_fields;
        const remove = Array.isArray(raw)
          ? raw.filter((f): f is string => typeof f === 'string' && f.length > 0)
          : [];
        if (!Array.isArray(raw) || raw.length === 0 || remove.length !== raw.length) {
          return { ok: false, error: 'remove_fields must be a non-empty array of field names' };
        }
        for (const r of remove) {
          const i = entries.findIndex(([n]) => n === r);
          if (i === -1) {
            return { ok: false, error: `"${tableName}" has no field named "${r}" to remove` };
          }
          entries.splice(i, 1);
        }
      }
      if (args.set_fields !== undefined) {
        const items = parseFieldItems(args.set_fields, 'set_fields');
        const { fields, errors } = shapeFields(tableName, existing.def.base, items);
        if (errors.length > 0) {
          return { ok: false, error: fieldErrorSummary(errors, Object.keys(fields)) };
        }
        for (const item of items) {
          const fieldDef = fields[item.name];
          if (!fieldDef) continue; // unreachable — every error-free item narrowed
          const i = entries.findIndex(([n]) => n === item.name);
          if (i === -1) entries.push([item.name, fieldDef]);
          else entries[i] = [item.name, fieldDef];
        }
      }
      if (entries.length === 0) {
        return {
          ok: false,
          error:
            'A computed table needs at least one field. To remove the whole computed view, ' +
            'use delete_entity instead.',
        };
      }
      const def: ComputedTableDef = {
        base: existing.def.base,
        fields: Object.fromEntries(entries),
        ...(existing.def.description !== undefined
          ? { description: existing.def.description }
          : {}),
      };
      await ctx.computedOps.update(tableName, def);
      return { ok: true, result: { updated: tableName, fields: entries.map(([n]) => n) } };
    }

    case 'refresh_computed_table': {
      if (!ctx.computedOps) return NOT_AVAILABLE;
      const tableName = requireString(args.name, 'name');
      const results = await ctx.computedOps.refresh(tableName);
      if (results.length === 0) {
        return {
          ok: true,
          result: {
            refreshed: tableName,
            note: 'This computed view has no AI fields — every value is always live and needs no refresh.',
          },
        };
      }
      return {
        ok: true,
        result: {
          refreshed: tableName,
          fields: results.map(({ field, status, filled, pending, error }) => ({
            field,
            status,
            filled,
            pending,
            ...(error !== undefined ? { error } : {}),
          })),
        },
      };
    }

    default:
      return NOT_HANDLED;
  }
}
