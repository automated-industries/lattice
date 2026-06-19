import { describe, it, expect, vi } from 'vitest';
import { parseConfigString } from '../../src/config/parser.js';
import { updateRow, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * 1.16.1 unit coverage:
 *  E — a one-to-many `ref:` field parses into a belongsTo relation, silently.
 *  F — updateRow throws when a requested change leaves the row byte-identical
 *      (the read-only/blocked-write signature). The no-false-positive cases
 *      (real edit + same-value edit) are covered by the integration test.
 */

describe('E: one-to-many ref: parses without warning', () => {
  it('parses a `ref:` field into the belongsTo relation and emits no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = [
      'db: ./x.db',
      'entities:',
      '  authors:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '  books:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      author_id: { type: uuid, ref: authors }',
      '',
    ].join('\n');
    const parsed = parseConfigString(cfg, '/tmp');
    const calls = warn.mock.calls.flat().join(' ');
    warn.mockRestore();
    expect(calls).not.toMatch(/one-to-many|deprecat/i);
    const books = parsed.tables.find((t) => t.name === 'books');
    expect(books?.definition.relations?.author).toBeTruthy();
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
