import { describe, it, expect } from 'vitest';
import { collectLinkables, applyTraceLinks, type TraceRef } from '../../src/gui/ai/trace-links.js';

const map = (entries: [string, TraceRef | null][]): Map<string, TraceRef | null> =>
  new Map(entries);

describe('collectLinkables', () => {
  it('harvests rows from list results with the table from the tool input', () => {
    const m = new Map<string, TraceRef | null>();
    collectLinkables(
      { table: 'invoices' },
      {
        rows: [
          { id: 'i1', number: 'INV-2081' },
          { id: 'i2', number: 'INV-2088' },
        ],
      },
      m,
    );
    expect(m.get('INV-2081')).toEqual({ table: 'invoices', id: 'i1' });
    expect(m.get('INV-2088')).toEqual({ table: 'invoices', id: 'i2' });
  });

  it('harvests a single-row result and prefers name over other label fields', () => {
    const m = new Map<string, TraceRef | null>();
    collectLinkables({ table: 'clients' }, { id: 'c1', name: 'Northwind Partners', title: 'x' }, m);
    expect(m.get('Northwind Partners')).toEqual({ table: 'clients', id: 'c1' });
  });

  it('poisons a label that maps to two different rows', () => {
    const m = new Map<string, TraceRef | null>();
    collectLinkables({ table: 'tasks' }, { rows: [{ id: 't1', title: 'Review' }] }, m);
    collectLinkables({ table: 'notes' }, { rows: [{ id: 'n9', title: 'Review' }] }, m);
    expect(m.get('Review')).toBeNull();
  });

  it('ignores results with no table input and short bare-number labels', () => {
    const m = new Map<string, TraceRef | null>();
    collectLinkables({}, { rows: [{ id: 'x', name: 'Real Label' }] }, m);
    collectLinkables({ table: 'metrics' }, { rows: [{ id: 'm1', name: '42' }] }, m);
    expect(m.size).toBe(0);
  });
});

describe('applyTraceLinks', () => {
  const northwind: [string, TraceRef] = ['Northwind Partners', { table: 'clients', id: 'c1' }];
  const inv: [string, TraceRef] = ['INV-2081', { table: 'invoices', id: 'i1' }];

  it('wraps a bare label in a lattice:// link', () => {
    expect(applyTraceLinks('Atlas is for Northwind Partners.', map([northwind]))).toBe(
      'Atlas is for [Northwind Partners](lattice://clients/c1).',
    );
  });

  it('leaves an existing markdown link untouched (no double wrap)', () => {
    const text = 'See [Northwind Partners](lattice://clients/c1) today.';
    expect(applyTraceLinks(text, map([northwind]))).toBe(text);
  });

  it('leaves inline code untouched', () => {
    const text = 'Run `INV-2081` locally.';
    expect(applyTraceLinks(text, map([inv]))).toBe(text);
  });

  it('does not match inside a longer word and links all bare occurrences', () => {
    const out = applyTraceLinks('INV-2081 supersedes INV-20815; INV-2081 is paid.', map([inv]));
    expect(out).toBe(
      '[INV-2081](lattice://invoices/i1) supersedes INV-20815; [INV-2081](lattice://invoices/i1) is paid.',
    );
  });

  it('skips poisoned (ambiguous) labels and URI-encodes ids', () => {
    const m = map([
      ['Review', null],
      ['Weekly Sync', { table: 'meetings', id: 'a b' }],
    ]);
    expect(applyTraceLinks('Review the Weekly Sync notes.', m)).toBe(
      'Review the [Weekly Sync](lattice://meetings/a%20b) notes.',
    );
  });
});
