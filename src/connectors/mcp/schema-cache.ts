/**
 * Persisted + memoized schema descriptor for one MCP connection — the MCP analogue of
 * `db-source/schema-cache.ts`. The connector SPI's `models()` is SYNCHRONOUS, but discovering
 * an MCP server's record shapes means calling its read tools (async), so introspection happens
 * in the async connect/refresh path, persists a descriptor in the machine-local encrypted store
 * (keyed `mcp_schema:<connectionId>`), and `models()` reads it back synchronously via
 * {@link buildMcpModelDefs}. That turns a server's flat item stream into one TYPED table per
 * record kind (e.g. `deduction_types`, `company`), each namespaced per connection so two servers
 * never collide and each auto-groups under its own GUI schema header (via `mcp:<connId>` toolkit).
 */

import { createHash } from 'node:crypto';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';
import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef } from '../types.js';
import { slugify } from '../db-source/schema-cache.js';

/** SQL spec inferred for a modeled column. */
export type McpSqlSpec = 'TEXT' | 'INTEGER' | 'REAL';

export interface McpColumnDesc {
  name: string;
  sqlSpec: McpSqlSpec;
}

/** One record kind discovered on the server → one typed Lattice table. */
export interface McpKindDesc {
  /** Record kind slug (the table's identity within the connection), e.g. `deduction_types`. */
  kind: string;
  /** The server read tool whose items populate this kind (e.g. `list_deduction_types`). */
  tool: string;
  /** Modeled columns inferred from sampled items (excludes the natural key + lifecycle cols). */
  columns: McpColumnDesc[];
  /** The item field used as the natural key, or `_pk` when synthesized (no stable id field). */
  naturalKey: string;
}

export interface McpSchemaDescriptor {
  /** Sanitized slug namespacing this connection's tables (from the server brand / display name). */
  prefix: string;
  kinds: McpKindDesc[];
}

const MCP_TOOLKIT_PREFIX = 'mcp:';
const schemaKind = (connectionId: string): string => `mcp_schema:${connectionId}`;

/** The per-connection toolkit slug — mirrors db-source's `db_source:<id>` so each server groups
 *  under its own GUI schema header (classifySchema keys by toolkit). */
export function mcpToolkitFor(connectionId: string): string {
  return MCP_TOOLKIT_PREFIX + connectionId;
}

/** Recover the connection id from a per-connection MCP toolkit, or null for the legacy `mcp`. */
export function connectionIdFromToolkit(toolkit: string): string | null {
  return toolkit.startsWith(MCP_TOOLKIT_PREFIX)
    ? toolkit.slice(MCP_TOOLKIT_PREFIX.length) || null
    : null;
}

// In-process memo so repeated synchronous models() calls within a session don't re-decrypt.
const memo = new Map<string, McpSchemaDescriptor>();

export function getMcpSchemaDescriptor(connectionId: string): McpSchemaDescriptor | null {
  const cached = memo.get(connectionId);
  if (cached) return cached;
  const raw = getAssistantCredential(schemaKind(connectionId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as McpSchemaDescriptor;
    memo.set(connectionId, d);
    return d;
  } catch {
    return null;
  }
}

export function setMcpSchemaDescriptor(
  connectionId: string,
  descriptor: McpSchemaDescriptor,
): void {
  memo.set(connectionId, descriptor);
  setAssistantCredential(schemaKind(connectionId), JSON.stringify(descriptor));
}

export function clearMcpSchemaDescriptor(connectionId: string): void {
  memo.delete(connectionId);
  deleteAssistantCredential(schemaKind(connectionId));
}

/** The imported Lattice table name for a record kind (namespaced by the connection prefix). */
export function mcpTableName(prefix: string, kind: string): string {
  const raw = `mcp_${prefix}_${slugify(kind)}`;
  // Postgres silently truncates an identifier to 63 bytes; two names differing only past byte 63
  // would collapse to ONE physical table on cloud (SQLite has no such limit, so tests never see
  // it). Bound the FULL name here — the single namer every caller routes through — so the
  // app-level name is byte-identical to what the DB stores, and the de-collision that compares
  // these names operates on the real name. `raw` is pure ASCII (mcp_ + slug + slug), so a
  // character slice is a byte slice; 56 + '_' + 6 hex = 63.
  if (Buffer.byteLength(raw, 'utf8') <= 63) return raw;
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 6);
  return raw.slice(0, 56) + '_' + h;
}

// Reserved column names never modeled as their own data column: the lifecycle/base columns,
// plus `data` — which is the always-present JSON overflow column (a source field literally
// named `data` would otherwise be overwritten by the whole-item blob). Compared case-folded.
const RESERVED = new Set(['id', '_pk', 'deleted_at', 'created_at', 'updated_at', 'data']);

/**
 * A case-folded view of an object: keys lowercased, later duplicates winning. Modeled column
 * names are lowercase (SQLite identifiers are case-insensitive, so `Name` and `name` are ONE
 * column — declaring both fails CREATE TABLE), so item values are read back through this view
 * so an item's `Name`/`ID` still populates the `name`/`id` column.
 */
export function lowerKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = v;
  return out;
}
/** Stable id-ish fields preferred, in order, as the natural key when present + scalar. `name`
 *  is intentionally excluded — it is not a stable/unique identifier, so a kind with only a name
 *  synthesizes `_pk` instead. */
const ID_FIELDS = ['id', 'key', 'uid', 'guid', 'slug'];

/** The SQL spec for a JSON value: numbers → INTEGER/REAL, everything else → TEXT (JSON for objects). */
function specFor(v: unknown): McpSqlSpec {
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  return 'TEXT';
}

/** Derive a record-kind slug from a read tool name: strip a leading list_/get_/search_/fetch_/
 *  read_/find_/query_ verb, so `list_deduction_types` → `deduction_types`, `get_company` →
 *  `company`. (The remaining noun is kept as-is — no plural stripping.) Falls back to the
 *  slugified tool name. */
export function kindFromTool(tool: string): string {
  const base = tool.replace(/^(list|get|search|fetch|read|find|query)_/i, '');
  return slugify(base) || slugify(tool) || 'item';
}

/**
 * Infer a kind's modeled columns + natural key from a sample of its items. Scalar fields become
 * typed columns; nested objects/arrays are kept in the always-present `data` JSON overflow column
 * (added by {@link buildMcpModelDefs}), never as their own column. Pure + deterministic.
 */
export function inferKind(kind: string, tool: string, items: unknown[]): McpKindDesc {
  const cols = new Map<string, McpSqlSpec>();
  let naturalKey = '_pk';
  // Case-fold every item first: modeled column names are lowercase (SQLite identifiers are
  // case-insensitive), so `Name`/`name` and `id`/`ID` collapse to one column instead of
  // producing duplicate identifiers that CREATE TABLE rejects. ID_FIELDS + RESERVED are
  // already lowercase, so all comparisons below are consistent.
  const objects = items
    .filter(
      (it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it),
    )
    .map(lowerKeys);
  // Pick the natural key: the first ID-ish field that is present + scalar across the sample.
  for (const cand of ID_FIELDS) {
    if (objects.length > 0 && objects.every((o) => ['string', 'number'].includes(typeof o[cand]))) {
      naturalKey = cand;
      break;
    }
  }
  for (const o of objects) {
    for (const [k, v] of Object.entries(o)) {
      if (k === naturalKey || RESERVED.has(k)) continue;
      if (v === null || typeof v === 'object') continue; // nested → data overflow
      const prev = cols.get(k);
      const spec = specFor(v);
      // Widen INTEGER→REAL→TEXT if the sample disagrees (never narrow).
      cols.set(k, prev === 'TEXT' || spec === 'TEXT' ? 'TEXT' : prev === 'REAL' ? 'REAL' : spec);
    }
  }
  return {
    kind,
    tool,
    naturalKey,
    columns: [...cols.entries()].map(([name, sqlSpec]) => ({ name, sqlSpec })),
  };
}

/**
 * Build the Lattice {@link ConnectedModelDef}s for a connection's kinds — pure + synchronous so
 * `models()` returns immediately. Each kind maps to `mcp_<prefix>_<kind>` with the standard
 * lifecycle columns, its inferred typed columns, a `data` TEXT overflow for unmodeled/nested
 * fields, and a `source` descriptor (so rows land in the SOURCE·INPUTS tier + group by toolkit).
 */
export function buildMcpModelDefs(
  connectionId: string,
  descriptor: McpSchemaDescriptor,
): ConnectedModelDef[] {
  const toolkit = mcpToolkitFor(connectionId);
  return descriptor.kinds.map((k) => {
    const columns: Record<string, string> = {
      [k.naturalKey]: 'TEXT PRIMARY KEY',
      deleted_at: 'TEXT',
      created_at: 'TEXT',
      updated_at: 'TEXT',
    };
    for (const c of k.columns) {
      if (c.name === k.naturalKey) continue;
      columns[c.name] = c.sqlSpec;
    }
    columns.data = 'TEXT'; // JSON overflow for nested/unmodeled fields
    const ftsFields = k.columns
      .filter((c) => c.sqlSpec === 'TEXT')
      .map((c) => c.name)
      .slice(0, 4);
    const definition: TableDefinition = {
      columns,
      primaryKey: k.naturalKey,
      source: {
        connector: 'mcp',
        toolkit,
        model: k.kind,
        naturalKey: k.naturalKey,
        defaultVisibility: 'private',
      },
      outputFile: `connectors/mcp/${descriptor.prefix}/${slugify(k.kind)}.md`,
      description: `Synced from the ${descriptor.prefix} MCP server (${k.tool}).`,
      render: 'default-detail',
      ...(ftsFields.length ? { fts: { fields: ftsFields } } : {}),
    };
    return {
      model: k.kind,
      table: mcpTableName(descriptor.prefix, k.kind),
      naturalKey: k.naturalKey,
      definition,
    };
  });
}
