import { describe, it, expect } from 'vitest';
import {
  REGISTRY,
  getFunction,
  functionNames,
  mutatingFunctions,
} from '../../src/gui/ai/registry.js';

describe('Lattice function registry', () => {
  it('has unique function names', () => {
    const names = functionNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('every function has a non-empty description and a valid args schema', () => {
    for (const fn of REGISTRY) {
      expect(fn.description.length).toBeGreaterThan(0);
      expect(fn.args.type).toBe('object');
      expect(fn.args.additionalProperties).toBe(false);
      // Every name listed in `required` must exist in `properties`.
      for (const req of fn.args.required ?? []) {
        expect(Object.keys(fn.args.properties)).toContain(req);
      }
    }
  });

  it('looks up a function by name', () => {
    const fn = getFunction('create_row');
    expect(fn).toBeDefined();
    expect(fn?.mutates).toBe(true);
    expect(fn?.category).toBe('row');
    expect(fn?.args.required).toContain('table');
    expect(fn?.args.required).toContain('values');
  });

  it('returns undefined for an unknown function', () => {
    expect(getFunction('definitely_not_a_function')).toBeUndefined();
  });

  it('classifies reads as non-mutating and writes as mutating', () => {
    expect(getFunction('list_entities')?.mutates).toBe(false);
    expect(getFunction('get_row')?.mutates).toBe(false);
    expect(getFunction('delete_row')?.mutates).toBe(true);
    expect(getFunction('create_entity')?.mutates).toBe(true);
  });

  it('mutatingFunctions returns only the writes', () => {
    const muts = mutatingFunctions();
    expect(muts.length).toBeGreaterThan(0);
    expect(muts.every((fn) => fn.mutates)).toBe(true);
    expect(muts.some((fn) => fn.name === 'list_entities')).toBe(false);
  });

  it('covers the core CRUD + schema + history + database surface', () => {
    const names = new Set(functionNames());
    for (const expected of [
      'list_entities',
      'list_rows',
      'create_row',
      'update_row',
      'delete_row',
      'link',
      'unlink',
      'create_entity',
      'rename_entity',
      'add_column',
      'rename_column',
      'undo',
      'redo',
      'revert',
      'list_databases',
      'switch_database',
      'create_database',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});
