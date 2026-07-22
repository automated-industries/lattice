import { describe, it, expect } from 'vitest';
import { diffDescriptor, mergeDescriptor } from '../../src/connectors/mcp/schema-drift.js';
import type { McpKindDesc, McpSchemaDescriptor } from '../../src/connectors/mcp/schema-cache.js';

/**
 * Drift reconciliation core (pure): diff a freshly-discovered descriptor against the persisted one
 * and merge NON-DESTRUCTIVELY — add new kinds/columns, freeze existing natural keys + column types,
 * promote provisional→contractual, and freeze (never drop) a vanished kind.
 */

const K = (
  kind: string,
  cols: string[],
  opts: { naturalKey?: string; provenance?: 'contractual' | 'provisional'; retired?: boolean } = {},
): McpKindDesc => ({
  kind,
  tool: `list_${kind}`,
  naturalKey: opts.naturalKey ?? 'id',
  columns: cols.map((c) => ({ name: c, sqlSpec: 'TEXT' as const })),
  ...(opts.provenance ? { provenance: opts.provenance } : {}),
  ...(opts.retired ? { retired: true } : {}),
});

const desc = (kinds: McpKindDesc[]): McpSchemaDescriptor => ({ version: 2, prefix: 'ex', kinds });

describe('diffDescriptor', () => {
  it('detects added kinds, added columns + promotion, and vanished (retired) kinds', () => {
    const prev = desc([K('a', ['x'], { provenance: 'provisional' }), K('b', ['y'])]);
    const next = desc([
      K('a', ['x', 'z'], { provenance: 'contractual', naturalKey: 'key' }), // gained z + declared
      K('c', ['w']), // new
    ]); // b vanished

    const d = diffDescriptor(prev, next);
    expect(d.addedKinds).toEqual(['c']);
    expect(d.retiredKinds).toEqual(['b']);
    expect(d.changedKinds).toHaveLength(1);
    expect(d.changedKinds[0]!.kind).toBe('a');
    expect(d.changedKinds[0]!.addedColumns.map((c) => c.name)).toEqual(['z']);
    expect(d.changedKinds[0]!.promoted).toBe(true);
  });

  it('reports nothing for an identical descriptor', () => {
    const prev = desc([K('a', ['x']), K('b', ['y'])]);
    const d = diffDescriptor(prev, prev);
    expect(d.addedKinds).toEqual([]);
    expect(d.changedKinds).toEqual([]);
    expect(d.retiredKinds).toEqual([]);
  });

  it('does not re-retire a kind already marked retired', () => {
    const prev = desc([K('a', ['x']), K('old', ['z'], { retired: true })]);
    const next = desc([K('a', ['x'])]); // 'old' still absent
    expect(diffDescriptor(prev, next).retiredKinds).toEqual([]);
  });
});

describe('mergeDescriptor', () => {
  it('freezes natural key, adds columns, promotes, and keeps a vanished kind frozen', () => {
    const prev = desc([K('a', ['x'], { provenance: 'provisional' }), K('b', ['y'])]);
    const next = desc([
      K('a', ['x', 'z'], { provenance: 'contractual', naturalKey: 'key' }),
      K('c', ['w']),
    ]);
    const merged = mergeDescriptor(prev, next, diffDescriptor(prev, next));

    // Order preserved: prev kinds first (a, b), new kind appended (c).
    expect(merged.kinds.map((k) => k.kind)).toEqual(['a', 'b', 'c']);

    const a = merged.kinds.find((k) => k.kind === 'a')!;
    expect(a.naturalKey).toBe('id'); // FROZEN — the re-inferred 'key' is ignored (PK can't change)
    expect(a.columns.map((c) => c.name)).toEqual(['x', 'z']); // existing kept + new added
    expect(a.provenance).toBe('contractual'); // promoted in place

    const b = merged.kinds.find((k) => k.kind === 'b')!;
    expect(b.retired).toBe(true); // vanished → frozen, NOT dropped
    expect(b.columns.map((c) => c.name)).toEqual(['y']); // its columns (and rows) are preserved

    const c = merged.kinds.find((k) => k.kind === 'c')!;
    expect(c.retired).toBeUndefined();
  });

  it('never re-types an existing column (keeps the frozen spec)', () => {
    const prev = desc([{ ...K('a', []), columns: [{ name: 'n', sqlSpec: 'INTEGER' }] }]);
    // The live server now describes `n` as TEXT — the existing INTEGER spec must be kept.
    const next = desc([{ ...K('a', []), columns: [{ name: 'n', sqlSpec: 'TEXT' }] }]);
    const merged = mergeDescriptor(prev, next, diffDescriptor(prev, next));
    const a = merged.kinds.find((k) => k.kind === 'a')!;
    expect(a.columns.find((c) => c.name === 'n')!.sqlSpec).toBe('INTEGER');
  });
});
