import { describe, it, expect } from 'vitest';
import { normalizeText, keyFromColumns } from '../../src/dedup/normalize.js';
import { bigramDice, classifyPair } from '../../src/dedup/match.js';
import { findDuplicateGroups, type DedupItem } from '../../src/dedup/index.js';

describe('normalizeText', () => {
  it('lowercases, trims, and collapses whitespace by default', () => {
    expect(normalizeText('  ACME   Inc ')).toBe('acme inc');
  });
  it('coerces null/number to a string form', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
    expect(normalizeText(42)).toBe('42');
  });
  it('strips punctuation only when asked', () => {
    expect(normalizeText('A.C.M.E, Inc!', { stripPunctuation: true })).toBe('a c m e inc');
    expect(normalizeText('A.C.M.E, Inc!')).toBe('a.c.m.e, inc!');
  });
});

describe('keyFromColumns', () => {
  it('joins normalized columns and drops empty parts', () => {
    expect(keyFromColumns({ name: 'Acme', city: ' New York ' }, ['name', 'city'])).toBe('acme␟new york');
    expect(keyFromColumns({ name: 'Acme', city: null, state: 'NY' }, ['name', 'city', 'state'])).toBe('acme␟ny');
  });
  it('returns empty string when every column is empty (not a duplicate of another blank)', () => {
    expect(keyFromColumns({ a: null, b: '' }, ['a', 'b'])).toBe('');
  });
});

describe('bigramDice', () => {
  it('is 1 for identical strings', () => {
    expect(bigramDice('avista', 'avista')).toBe(1);
  });
  it('lands in the near band for "Avista" vs "Avista Utilities"', () => {
    const d = bigramDice('avista', 'avista utilities');
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(1);
  });
  it('is low for unrelated strings', () => {
    expect(bigramDice('acme', 'other co')).toBeLessThan(0.3);
  });
});

describe('classifyPair', () => {
  it('returns exact / near / none', () => {
    expect(classifyPair('acme', 'acme')).toBe('exact');
    expect(classifyPair('acme corp', 'acme corporation', 0.6)).toBe('near');
    expect(classifyPair('acme', 'zzzzzz', 0.82)).toBe('none');
  });
});

describe('findDuplicateGroups', () => {
  const items: DedupItem[] = [
    { id: '1', key: 'acme', createdAt: '2026-01-01' },
    { id: '2', key: 'acme', createdAt: '2026-01-02' },
    { id: '3', key: 'acme inc', createdAt: '2026-01-03' },
    { id: '4', key: 'other', createdAt: '2026-01-04' },
  ];

  it('groups exact matches, oldest first, ignoring singletons', () => {
    const groups = findDuplicateGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('exact');
    expect(groups[0]!.ids).toEqual(['1', '2']);
  });

  it('skips empty keys', () => {
    const groups = findDuplicateGroups([
      { id: 'a', key: '' },
      { id: 'b', key: '' },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('surfaces fuzzy near-duplicate groups among non-exact rows', () => {
    const fuzzy: DedupItem[] = [
      { id: 'a', key: 'avista', createdAt: '1' },
      { id: 'b', key: 'avista utilities', createdAt: '2' },
      { id: 'c', key: 'zebra', createdAt: '3' },
    ];
    const groups = findDuplicateGroups(fuzzy, { fuzzy: true, threshold: 0.45, blockPrefix: 3 });
    const near = groups.find((g) => g.kind === 'near');
    expect(near).toBeTruthy();
    expect(near!.ids.slice().sort()).toEqual(['a', 'b']);
  });

  it('does not produce fuzzy groups when fuzzy is off', () => {
    const fuzzy: DedupItem[] = [
      { id: 'a', key: 'avista', createdAt: '1' },
      { id: 'b', key: 'avista utilities', createdAt: '2' },
    ];
    expect(findDuplicateGroups(fuzzy, { fuzzy: false })).toHaveLength(0);
  });

  it('groups files by identical content key (the "file (1)" / "file (2)" case)', () => {
    // Mirrors the server content mode: same sha256 ⇒ same key ⇒ one group.
    const files: DedupItem[] = [
      { id: 'f1', key: 'sha:abc', createdAt: '1' },
      { id: 'f2', key: 'sha:abc', createdAt: '2' },
      { id: 'f3', key: 'sha:abc', createdAt: '3' },
      { id: 'f4', key: 'sha:def', createdAt: '4' },
    ];
    const groups = findDuplicateGroups(files);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ids).toEqual(['f1', 'f2', 'f3']);
  });
});
