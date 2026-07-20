import { describe, it, expect, vi } from 'vitest';
import { parseConfigString } from '../../src/config/parser.js';
import { updateRow, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * 1.16.1 unit coverage:
 *  E — the per-field `ref:` shorthand is accepted in 4.0; a config that still uses
 *      it parses cleanly and SILENTLY (no deprecation warning) into a belongsTo
 *      relation (relation name = field name minus a trailing `_id`), and the GUI
 *      auto-upgrades it to an explicit `relations:` block on disk.
 *  F — updateRow throws when a requested change leaves the row byte-identical
 *      (the read-only/blocked-write signature). The no-false-positive cases
 *      (real edit + same-value edit) are covered by the integration test.
 */

describe('4.0 — E: per-field ref: shorthand is accepted (auto-upgraded), silently', () => {
  it('parses a `ref:` field into a belongsTo relation and emits no deprecation warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = [
      'db: ./x.db',
      'entities:',
      '  books:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      author_id: { type: uuid, ref: authors }',
      '',
    ].join('\n');
    const { tables } = parseConfigString(cfg, '/tmp');
    // Silent: no deprecation / one-to-many warning is emitted.
    const calls = warn.mock.calls.flat().join(' ');
    warn.mockRestore();
    expect(calls).not.toMatch(/one-to-many|deprecat/i);
    // Relation name = field name with a trailing `_id` stripped (author_id → author).
    const def = tables.find((t) => t.name === 'books')!.definition;
    expect(def.relations?.author).toMatchObject({
      type: 'belongsTo',
      table: 'authors',
      foreignKey: 'author_id',
    });
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
        isComputedTable: () => false,
        getConnectedSource: () => null,
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
