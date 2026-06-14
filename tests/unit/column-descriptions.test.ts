import { describe, it, expect } from 'vitest';
import {
  resolveColumnDescription,
  builtinColumnDescription,
} from '../../src/gui/column-descriptions.js';

describe('column descriptions', () => {
  it('built-ins cover the native entities and common system columns', () => {
    expect(builtinColumnDescription('files', 'sha256')).toContain('SHA-256');
    expect(builtinColumnDescription('files', 'ref_kind')).toContain('blob');
    expect(builtinColumnDescription('secrets', 'value')).toContain('encrypted');
    // System columns are described for every table.
    expect(builtinColumnDescription('anything', 'created_at')).toBe('When this row was created.');
    expect(builtinColumnDescription('anything', 'id')).toContain('Primary key');
    // No built-in for an unknown user column.
    expect(builtinColumnDescription('widgets', 'colour')).toBeUndefined();
  });

  it('resolve: authored wins, blank falls through to built-in, else undefined', () => {
    // Authored value overrides the built-in.
    expect(resolveColumnDescription('files', 'sha256', 'my own note')).toBe('my own note');
    // Blank/whitespace authored value clears the override back to the built-in.
    expect(resolveColumnDescription('files', 'sha256', '   ')).toContain('SHA-256');
    expect(resolveColumnDescription('files', 'sha256', null)).toContain('SHA-256');
    // No authored, no built-in → undefined (caller falls back to type/role).
    expect(resolveColumnDescription('widgets', 'colour')).toBeUndefined();
    // Authored value on an otherwise-undescribed column.
    expect(resolveColumnDescription('widgets', 'colour', 'Hex colour.')).toBe('Hex colour.');
  });
});
