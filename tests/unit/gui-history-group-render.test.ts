import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';

/**
 * The version-history page collapses audit entries that share an operation-group
 * id (all the rows one bulk operation touched) into a single card with one
 * "Undo this change" control. The grouping decision is a pure helper
 * (groupHistoryEntries) factored out of the DOM-rendering code, so it is
 * extracted from the shipped appJs bundle and exercised here — mirroring how
 * gui-offline-retry.test.ts extracts the drain helpers. toContain guards check
 * the wiring (group card, endpoint, single control) is present in the bundle.
 */

interface Entry {
  id: string;
  op_group: string | null;
  [k: string]: unknown;
}
type RenderItem = { kind: 'entry'; entry: Entry } | { kind: 'group'; id: string; entries: Entry[] };

function loadGroupHelper(): (entries: Entry[]) => RenderItem[] {
  const start = appJs.indexOf('function groupHistoryEntries');
  const end = appJs.indexOf('function historyGroupHtml');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('could not locate groupHistoryEntries in appJs');
  }
  const slice = appJs.slice(start, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${slice}\n;return groupHistoryEntries;`) as () => (
    entries: Entry[],
  ) => RenderItem[];
  return factory();
}

const e = (id: string, group: string | null): Entry => ({ id, op_group: group });

describe('version-history bulk-operation grouping (client helper)', () => {
  const groupHistoryEntries = loadGroupHelper();

  it('collapses entries sharing an op_group into one group item, in feed order', () => {
    const items = groupHistoryEntries([
      e('a', null),
      e('b', 'g1'),
      e('c', 'g1'),
      e('d', 'g1'),
      e('f', null),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'entry' });
    expect(items[1]).toMatchObject({ kind: 'group', id: 'g1' });
    const group = items[1] as { kind: 'group'; entries: Entry[] };
    expect(group.entries.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(items[2]).toMatchObject({ kind: 'entry' });
  });

  it('keeps two different groups apart and positions each at its newest entry', () => {
    const items = groupHistoryEntries([e('a', 'g2'), e('b', 'g1'), e('c', 'g2'), e('d', 'g1')]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'group', id: 'g2' });
    expect(items[1]).toMatchObject({ kind: 'group', id: 'g1' });
  });

  it('degrades a single-entry group to a plain entry (no bulk affordance for one record)', () => {
    const items = groupHistoryEntries([e('a', 'g-solo'), e('b', null)]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'entry' });
    expect((items[0] as { entry: Entry }).entry.id).toBe('a');
  });

  it('treats a missing/null op_group as ungrouped', () => {
    const items = groupHistoryEntries([e('a', null), e('b', null)]);
    expect(items.every((i) => i.kind === 'entry')).toBe(true);
  });
});

describe('version-history bulk-operation card wiring (bundle guards)', () => {
  it('renders a group card with a single whole-group undo control', () => {
    expect(appJs).toContain('history-undo-group');
    expect(appJs).toContain('Undo this change');
    expect(appJs).toContain('op-bulk');
  });

  it('posts the group undo to the whole-group endpoint', () => {
    expect(appJs).toContain('/api/history/undo-group/');
  });

  it('routes render items through the grouping helper', () => {
    expect(appJs).toContain('groupHistoryEntries(data.entries)');
  });
});
