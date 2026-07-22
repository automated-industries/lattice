/**
 * outputSchema → columns compiler — the AUTHORITATIVE-schema counterpart to `inferKind`.
 *
 * `inferKind` (schema-cache) derives a kind's columns by SAMPLING returned items — lossy, and
 * blind to a field that is null in the sample. When a read tool declares an `outputSchema` (the
 * structured-output contract added in the 2025-06-18 MCP revision, which the server MUST honor),
 * we compile that schema directly into columns instead of sampling: no network call, correct even
 * for an empty account, and the column set is a contract rather than a guess.
 *
 * The mapping targets the SAME SQL specs `inferKind`/`typedRecord` produce (TEXT/INTEGER/REAL),
 * so a schema-derived column and a sampled column of the same field are byte-compatible — a later
 * schema publish PROMOTES a provisional column in place instead of colliding with it.
 *
 * Pure + deterministic: no I/O, no persistence.
 */

import { RESERVED, ID_FIELDS, type McpColumnDesc, type McpKindDesc, type McpSqlSpec } from './schema-cache.js';

/** A permissive JSON-Schema shape — only the keywords the compiler reasons about. */
export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike | JsonSchemaLike[];
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  format?: string;
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  allOf?: JsonSchemaLike[];
  additionalProperties?: boolean | JsonSchemaLike;
}

/**
 * Wrapper keys under which a tool nests its record array (`{ results: [...] }`). Kept in sync with
 * the sampling unwrap list in `generic/connector.ts` (`itemsOf`) — a server that wraps its rows
 * one way for a live call wraps them the same way in its declared schema.
 */
const WRAP_KEYS = ['items', 'results', 'data', 'records', 'value', 'entries'];

/** The primary JSON-Schema type of a node: the first non-`null` member of a type union, or a type
 *  inferred from `properties`/`items` when `type` is omitted. */
function primaryType(s: JsonSchemaLike): string | undefined {
  if (Array.isArray(s.type)) {
    const t = s.type.find((x) => x !== 'null');
    if (t) return t;
  } else if (typeof s.type === 'string') {
    return s.type;
  }
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return undefined;
}

/** Resolve a single item schema from an `items` keyword (schema, or a tuple's first entry). */
function itemSchema(items: JsonSchemaLike['items']): JsonSchemaLike | null {
  if (!items) return null;
  return Array.isArray(items) ? (items[0] ?? null) : items;
}

/** Does a node describe an object with at least one named property? */
function hasProps(s: JsonSchemaLike): boolean {
  return primaryType(s) === 'object' && !!s.properties && Object.keys(s.properties).length > 0;
}

/**
 * Locate the per-RECORD object schema inside a tool's `outputSchema`, unwrapping a single array/
 * list property (a `WRAP_KEYS` member) or a bare array. Returns `{ item, wrapper }` where `wrapper`
 * is the property name the array lived under (or `null` for a bare array / single-object schema),
 * or `null` when the schema describes no modelable record.
 */
export function recordSchemaOf(
  out: JsonSchemaLike | undefined,
): { item: JsonSchemaLike; wrapper: string | null } | null {
  if (!out || typeof out !== 'object') return null;
  const t = primaryType(out);
  if (t === 'array') {
    const it = itemSchema(out.items);
    return it && hasProps(it) ? { item: it, wrapper: null } : null;
  }
  if (t === 'object' && out.properties) {
    for (const w of WRAP_KEYS) {
      const p = out.properties[w];
      if (p && primaryType(p) === 'array') {
        const it = itemSchema(p.items);
        if (it && hasProps(it)) return { item: it, wrapper: w };
      }
    }
    // No wrapper array → the object itself is one record (a single-record read tool).
    if (hasProps(out)) return { item: out, wrapper: null };
  }
  return null;
}

/** Collapse a nullable / anyOf / oneOf node to its first concrete non-`null` branch. */
function concreteBranch(s: JsonSchemaLike): JsonSchemaLike | null {
  const union = s.anyOf ?? s.oneOf;
  if (union) {
    for (const b of union) {
      if (primaryType(b) !== undefined && primaryType(b) !== 'null') return b;
    }
    return null;
  }
  return s;
}

/**
 * The SQL spec for a scalar property schema, or `null` to defer to the `data` JSON overflow.
 * `integer` → INTEGER; `number` → REAL; `string`/`boolean` → TEXT (booleans stringify, matching
 * `specFor`/`typedRecord`); `object`/`array`/unknown → null. Unwraps `["string","null"]`, `anyOf`,
 * `oneOf`, and infers from `enum` when `type` is absent. `format` (date-time, uri, …) does not
 * change the spec — a formatted string is still TEXT.
 */
export function jsonScalarSpec(s: JsonSchemaLike | undefined): McpSqlSpec | null {
  if (!s || typeof s !== 'object') return null;
  const branch = concreteBranch(s);
  if (!branch) return null;
  const t = primaryType(branch);
  if (t === undefined && Array.isArray(branch.enum) && branch.enum.length > 0) {
    // Enum with no declared type — infer from the first value.
    const v = branch.enum.find((x) => x !== null && x !== undefined);
    if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
    if (typeof v === 'string' || typeof v === 'boolean') return 'TEXT';
    return null;
  }
  if (t === 'integer') return 'INTEGER';
  if (t === 'number') return 'REAL';
  if (t === 'string' || t === 'boolean') return 'TEXT';
  return null; // object / array / null / unknown → overflow
}

/**
 * Compile a tool's `outputSchema` into a CONTRACTUAL {@link McpKindDesc}, or `null` when it
 * describes no modelable record (caller then falls back to sampling via `inferKind`). Column names
 * are case-folded to lowercase (SQLite identifiers are case-insensitive — `Name`/`name` collapse to
 * one column) mirroring `inferKind`. The natural key is the first {@link ID_FIELDS} scalar property,
 * preferring one that is `required`; nested/object/array properties defer to the `data` overflow;
 * a property literally named `data` (or any {@link RESERVED} name) is skipped.
 */
export function compileOutputSchema(
  kind: string,
  tool: string,
  out: JsonSchemaLike | undefined,
): McpKindDesc | null {
  const rec = recordSchemaOf(out);
  if (!rec) return null;
  const props = rec.item.properties ?? {};
  if (Object.keys(props).length === 0) return null;

  // Case-fold property names (lowercase, later duplicate wins) to match modeled column identifiers.
  const lowered = new Map<string, JsonSchemaLike>();
  for (const [n, schema] of Object.entries(props)) lowered.set(n.toLowerCase(), schema);
  const required = new Set((rec.item.required ?? []).map((r) => r.toLowerCase()));

  // Natural key: first id-ish scalar property, preferring a `required` one; else `_pk`.
  let naturalKey = '_pk';
  let fallback: string | null = null;
  for (const cand of ID_FIELDS) {
    const p = lowered.get(cand);
    if (p && jsonScalarSpec(p) !== null) {
      if (required.has(cand)) {
        naturalKey = cand;
        break;
      }
      fallback ??= cand;
    }
  }
  if (naturalKey === '_pk' && fallback) naturalKey = fallback;

  const columns: McpColumnDesc[] = [];
  for (const [name, schema] of lowered) {
    if (name === naturalKey || RESERVED.has(name)) continue;
    const spec = jsonScalarSpec(schema);
    if (spec === null) continue; // nested/object/array → data overflow
    columns.push({ name, sqlSpec: spec });
  }

  return { kind, tool, naturalKey, columns, provenance: 'contractual', origin: 'tool' };
}
