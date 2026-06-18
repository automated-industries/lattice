import { describe, it, expect } from 'vitest';
import { parseConfigString } from '../../src/config/parser.js';
import { updateRow, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * 1.16.1 unit coverage:
 *  E — the per-field `ref:` shorthand was removed in 4.0; a config that still
 *      uses it must fail to parse with a clear error (no silent fallback).
 *  F — updateRow throws when a requested change leaves the row byte-identical
 *      (the read-only/blocked-write signature). The no-false-positive cases
 *      (real edit + same-value edit) are covered by the integration test.
 */

describe('4.0 — E: per-field ref: shorthand is rejected', () => {
  it('throws on a `ref:` field with a clear 4.0 error', () => {
    const cfg = [
      'db: ./x.db',
      'entities:',
      '  books:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      author_id: { type: uuid, ref: authors }',
      '',
    ].join('\n');
    expect(() => parseConfigString(cfg, '/tmp')).toThrow(/`ref:`.*removed in 4\.0/i);
  });
});

describe('1.16.1 — F: updateRow surfaces a write that did not persist', () => {
  it('throws when a requested change leaves the row unchanged', async () => {
    const stored = { id: '1', title: 'todo' };
    const ctx = {
      db: {
        get: () => Promise.resolve({ ...stored }), // before === after (write blocked)
        update: () => Promise.resolve(),
        getRegisteredColumns: () => ({ id: 'TEXT', title: 'TEXT' }),
        getDialect: () => 'sqlite',
      },
      feed: { publish: () => undefined },
      softDeletable: new Set<string>(),
      source: 'gui',
    } as unknown as MutationCtx;
    await expect(updateRow(ctx, 'tasks', '1', { title: 'done' })).rejects.toThrow(
      /read-only|did not persist/i,
    );
  });
});
