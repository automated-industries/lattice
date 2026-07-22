import { describe, it, expect } from 'vitest';
import {
  recordSchemaOf,
  jsonScalarSpec,
  compileOutputSchema,
  type JsonSchemaLike,
} from '../../src/connectors/mcp/schema-compile.js';

/**
 * outputSchema-first schema derivation: compile a read tool's DECLARED outputSchema into a
 * contractual kind (columns + natural key) with no sampling. The mapping targets the same SQL
 * specs `inferKind` produces, so contractual + provisional columns of a field stay compatible.
 */

const obj = (properties: Record<string, JsonSchemaLike>, required?: string[]): JsonSchemaLike => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

describe('recordSchemaOf', () => {
  it('unwraps a single array property under a wrapper key', () => {
    const out = obj({ results: { type: 'array', items: obj({ id: { type: 'string' } }) } });
    const rec = recordSchemaOf(out);
    expect(rec?.wrapper).toBe('results');
    expect(rec?.item.properties?.id).toBeDefined();
  });

  it('unwraps a bare array of records', () => {
    const out: JsonSchemaLike = { type: 'array', items: obj({ key: { type: 'string' } }) };
    const rec = recordSchemaOf(out);
    expect(rec?.wrapper).toBeNull();
    expect(rec?.item.properties?.key).toBeDefined();
  });

  it('treats a bare object schema as a single record', () => {
    const out = obj({ name: { type: 'string' }, count: { type: 'integer' } });
    const rec = recordSchemaOf(out);
    expect(rec?.wrapper).toBeNull();
    expect(Object.keys(rec?.item.properties ?? {})).toEqual(['name', 'count']);
  });

  it('returns null for a scalar or property-less schema', () => {
    expect(recordSchemaOf({ type: 'string' })).toBeNull();
    expect(recordSchemaOf({ type: 'object' })).toBeNull();
    expect(recordSchemaOf(undefined)).toBeNull();
    expect(recordSchemaOf({ type: 'array', items: { type: 'string' } })).toBeNull();
  });
});

describe('jsonScalarSpec', () => {
  it('maps scalar JSON-Schema types to the same specs inferKind uses', () => {
    expect(jsonScalarSpec({ type: 'string' })).toBe('TEXT');
    expect(jsonScalarSpec({ type: 'string', format: 'date-time' })).toBe('TEXT');
    expect(jsonScalarSpec({ type: 'integer' })).toBe('INTEGER');
    expect(jsonScalarSpec({ type: 'number' })).toBe('REAL');
    expect(jsonScalarSpec({ type: 'boolean' })).toBe('TEXT');
  });

  it('defers objects and arrays to the data overflow', () => {
    expect(jsonScalarSpec({ type: 'object', properties: { a: { type: 'string' } } })).toBeNull();
    expect(jsonScalarSpec({ type: 'array', items: { type: 'string' } })).toBeNull();
  });

  it('unwraps nullable unions and anyOf/oneOf to the concrete branch', () => {
    expect(jsonScalarSpec({ type: ['string', 'null'] })).toBe('TEXT');
    expect(jsonScalarSpec({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toBe('INTEGER');
    expect(jsonScalarSpec({ oneOf: [{ type: 'null' }, { type: 'number' }] })).toBe('REAL');
  });

  it('infers a type from an enum with no declared type', () => {
    expect(jsonScalarSpec({ enum: ['active', 'closed'] })).toBe('TEXT');
    expect(jsonScalarSpec({ enum: [1, 2, 3] })).toBe('INTEGER');
  });
});

describe('compileOutputSchema', () => {
  it('compiles columns + an id-ish natural key and tags provenance contractual', () => {
    const out = obj(
      {
        id: { type: 'string' },
        summary: { type: 'string' },
        count: { type: 'integer' },
        rate: { type: 'number' },
        active: { type: 'boolean' },
      },
      ['id'],
    );
    const k = compileOutputSchema('issues', 'search_issues', out);
    expect(k).not.toBeNull();
    expect(k!.naturalKey).toBe('id');
    expect(k!.provenance).toBe('contractual');
    expect(k!.origin).toBe('tool');
    const byName = Object.fromEntries(k!.columns.map((c) => [c.name, c.sqlSpec]));
    expect(byName).toEqual({ summary: 'TEXT', count: 'INTEGER', rate: 'REAL', active: 'TEXT' });
    // the natural key is never also a data column
    expect(k!.columns.find((c) => c.name === 'id')).toBeUndefined();
  });

  it('prefers a required id-ish field as the natural key over an earlier optional one', () => {
    // `id` is present but optional; `key` is required → prefer `key`.
    const out = obj({ id: { type: 'string' }, key: { type: 'string' } }, ['key']);
    const k = compileOutputSchema('t', 'list_t', out);
    expect(k!.naturalKey).toBe('key');
  });

  it('case-folds column names and defers nested + reserved fields to overflow', () => {
    const out = obj({
      Name: { type: 'string' },
      Fields: { type: 'object', properties: { x: { type: 'string' } } },
      data: { type: 'string' }, // RESERVED — must never become its own column
    });
    const k = compileOutputSchema('t', 'get_t', out);
    const names = k!.columns.map((c) => c.name);
    expect(names).toContain('name'); // case-folded
    expect(names).not.toContain('fields'); // nested → overflow
    expect(names).not.toContain('data'); // reserved
    expect(k!.naturalKey).toBe('_pk'); // no id-ish field
  });

  it('returns null when the schema describes no modelable record', () => {
    expect(compileOutputSchema('t', 'x', { type: 'string' })).toBeNull();
    expect(compileOutputSchema('t', 'x', undefined)).toBeNull();
  });
});
