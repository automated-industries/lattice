import { describe, it, expect } from 'vitest';
import {
  kindFromTool,
  inferKind,
  buildMcpModelDefs,
  mcpToolkitFor,
  connectionIdFromToolkit,
  mcpTableName,
  type McpSchemaDescriptor,
} from '../../src/connectors/mcp/schema-cache.js';

/**
 * #5 typed MCP modeling — the pure, synchronous core: turn a server's read tools + sampled
 * items into one TYPED table per record kind, namespaced per connection. Mirrors db-source's
 * schema-cache (descriptor → buildModelDefs) so the same sync/prune/edge substrate drives it.
 */

describe('kindFromTool', () => {
  it('strips a leading verb + trailing plural to name the kind', () => {
    expect(kindFromTool('list_deduction_types')).toBe('deduction_types');
    expect(kindFromTool('get_company')).toBe('company');
    expect(kindFromTool('search_employees')).toBe('employees');
    expect(kindFromTool('benefits')).toBe('benefits');
  });
});

describe('per-connection toolkit', () => {
  it('round-trips the connection id through the toolkit slug', () => {
    expect(mcpToolkitFor('abc-123')).toBe('mcp:abc-123');
    expect(connectionIdFromToolkit('mcp:abc-123')).toBe('abc-123');
    // The legacy shared toolkit is NOT per-connection.
    expect(connectionIdFromToolkit('mcp')).toBeNull();
  });
});

describe('inferKind', () => {
  it('models scalar fields as typed columns, picks an id-ish natural key, defers nested to overflow', () => {
    const k = inferKind('deduction_types', 'list_deduction_types', [
      { code: 'MED', name: 'Medical (pretax)', pretax: true, rate: 1.5, meta: { plan: 'x' } },
      { code: 'DEN', name: 'Dental (pretax)', pretax: true, rate: 2 },
    ]);
    expect(k.kind).toBe('deduction_types');
    expect(k.tool).toBe('list_deduction_types');
    // `code` is the first ID-ish scalar field present across the sample.
    // (ID_FIELDS has no 'code', so the natural key synthesizes to _pk here.)
    expect(k.naturalKey).toBe('_pk');
    const byName = Object.fromEntries(k.columns.map((c) => [c.name, c.sqlSpec]));
    expect(byName.code).toBe('TEXT');
    expect(byName.name).toBe('TEXT');
    expect(byName.pretax).toBe('TEXT'); // boolean is non-number → TEXT
    expect(byName.rate).toBe('REAL'); // 1.5 present → REAL wins over INTEGER
    // Nested object is NOT a column (goes to the `data` overflow).
    expect(byName.meta).toBeUndefined();
  });

  it('uses an id/key field as the natural key when present and scalar', () => {
    const k = inferKind('company', 'get_company', [{ id: 'co_1', name: 'Acme', employees: 600 }]);
    expect(k.naturalKey).toBe('id');
    expect(k.columns.find((c) => c.name === 'id')).toBeUndefined(); // the key isn't a data column
    expect(k.columns.find((c) => c.name === 'employees')?.sqlSpec).toBe('INTEGER');
  });

  it('case-folds column names so Name/name and id/ID collapse to one column (SQLite identifiers are case-insensitive)', () => {
    // Declaring both `Name` and `name` (or `id` and `ID`) fails CREATE TABLE — SQLite folds case.
    const k = inferKind('user', 'list_users', [
      { ID: 'u1', Name: 'Ada', name: 'ada-lower', Active: true },
      { id: 'u2', name: 'Bob' },
    ]);
    // The natural key resolves case-insensitively — ID/id → the `id` PK.
    expect(k.naturalKey).toBe('id');
    const names = k.columns.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate identifiers
    expect(names).toEqual(names.map((n) => n.toLowerCase())); // all lowercase
    expect(names).toContain('name');
    expect(names).not.toContain('Name');
    expect(names).not.toContain('id'); // the (case-folded) natural key is never a data column
  });

  it('never models a field literally named `data` — it is the reserved JSON overflow column', () => {
    const k = inferKind('thing', 'list_things', [{ id: 't1', data: 42, label: 'x' }]);
    expect(k.columns.find((c) => c.name === 'data')).toBeUndefined();
    expect(k.columns.find((c) => c.name === 'label')?.sqlSpec).toBe('TEXT');
  });
});

describe('buildMcpModelDefs', () => {
  it('emits one typed, per-connection-namespaced table per kind + a data overflow column', () => {
    const descriptor: McpSchemaDescriptor = {
      prefix: 'justworks',
      kinds: [
        {
          kind: 'deduction_types',
          tool: 'list_deduction_types',
          naturalKey: '_pk',
          columns: [
            { name: 'code', sqlSpec: 'TEXT' },
            { name: 'name', sqlSpec: 'TEXT' },
          ],
        },
        {
          kind: 'company',
          tool: 'get_company',
          naturalKey: 'id',
          columns: [{ name: 'name', sqlSpec: 'TEXT' }],
        },
      ],
    };
    const defs = buildMcpModelDefs('conn-jw', descriptor);
    expect(defs.map((d) => d.table)).toEqual([
      'mcp_justworks_deduction_types',
      'mcp_justworks_company',
    ]);
    const ded = defs[0]!;
    expect(ded.model).toBe('deduction_types');
    expect(ded.naturalKey).toBe('_pk');
    // Faithful columns: the natural key (_pk here), the load-bearing deleted_at, the typed
    // columns, and the data overflow — but NOT created_at/updated_at (never set by sync).
    expect(Object.keys(ded.definition.columns)).toEqual(
      expect.arrayContaining(['_pk', 'deleted_at', 'code', 'name', 'data']),
    );
    expect(Object.keys(ded.definition.columns)).not.toContain('created_at');
    expect(Object.keys(ded.definition.columns)).not.toContain('updated_at');
    expect(ded.definition.source?.toolkit).toBe('mcp:conn-jw');
    expect(ded.definition.source?.connector).toBe('mcp');
    // The company kind keys on `id` (auto-projected), not _pk.
    expect(defs[1]!.definition.columns.id).toBe('TEXT PRIMARY KEY');
    expect(mcpTableName('justworks', 'company')).toBe('mcp_justworks_company');
  });
});

describe('mcpTableName byte-bounding (Postgres 63-byte identifier limit)', () => {
  it('leaves a short name unchanged', () => {
    expect(mcpTableName('justworks', 'company')).toBe('mcp_justworks_company');
  });

  it('bounds the full name to <= 63 bytes AND keeps two long kinds that would truncate-collide distinct', () => {
    // Long prefix + two kinds differing only past byte 63: under raw Postgres identifier
    // truncation both would collapse to one physical table (silently mixing rows); the bounded
    // namer must keep them distinct.
    const prefix = 'p'.repeat(40);
    const a = 'k'.repeat(18) + 'a' + 'z'.repeat(15);
    const b = 'k'.repeat(18) + 'b' + 'z'.repeat(15);
    const ta = mcpTableName(prefix, a);
    const tb = mcpTableName(prefix, b);
    expect(Buffer.byteLength(ta, 'utf8')).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(tb, 'utf8')).toBeLessThanOrEqual(63);
    expect(ta).not.toBe(tb);
  });
});
