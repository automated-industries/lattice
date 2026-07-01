/**
 * Shared builder for MCP-connector connected models — the same "Jira data
 * conventions" every connector reuses: a Lattice {@link TableDefinition} with the
 * standard lifecycle columns, a `source` descriptor (per-member `private`
 * visibility), an `outputFile`, and optional graph edges + a per-parent binding.
 */

import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef } from '../types.js';

/** Standard lifecycle columns every connected table carries (natural key = PK). */
function baseColumns(naturalKey: string): Record<string, string> {
  return {
    [naturalKey]: 'TEXT PRIMARY KEY',
    deleted_at: 'TEXT',
    created_at: 'TEXT',
    updated_at: 'TEXT',
  };
}

export interface McpModelArgs {
  connector: string;
  toolkit: string;
  table: string;
  model: string;
  naturalKey: string;
  columns: Record<string, string>;
  def: Partial<TableDefinition>;
  graphEdges?: ConnectedModelDef['graphEdges'];
  parent?: ConnectedModelDef['parent'];
}

/** Build a {@link ConnectedModelDef} for an MCP connector (mirrors `jira/models.ts`). */
export function mcpModel(args: McpModelArgs): ConnectedModelDef {
  const definition: TableDefinition = {
    columns: { ...baseColumns(args.naturalKey), ...args.columns },
    primaryKey: args.naturalKey,
    source: {
      connector: args.connector,
      toolkit: args.toolkit,
      model: args.model,
      naturalKey: args.naturalKey,
      defaultVisibility: 'private',
    },
    outputFile: `connectors/${args.toolkit}/${args.table}.md`,
    ...args.def,
  };
  const m: ConnectedModelDef = args.graphEdges
    ? {
        model: args.model,
        table: args.table,
        naturalKey: args.naturalKey,
        definition,
        graphEdges: args.graphEdges,
      }
    : { model: args.model, table: args.table, naturalKey: args.naturalKey, definition };
  if (args.parent) m.parent = args.parent;
  return m;
}

// --- Mapper helpers ----------------------------------------------------------

/** Coerce an unknown JSON value to a trimmed string, or undefined. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** JSON-encode an array/object column value, or undefined when absent. */
export function jsonCol(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/** Read a nested field by dotted path (tolerant of missing intermediates). */
export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Pull an array of items out of a tool result that may be the array itself, or an
 * object wrapping it under one of `keys` (e.g. `{ threads: [...] }`).
 */
export function arrayField(result: unknown, keys: string[]): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const k of keys) {
      const v = (result as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}
