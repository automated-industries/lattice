import { describe, it, expect } from 'vitest';
import {
  collectFromMarkdown,
  collectLinkables,
  applyTraceLinks,
  appendSources,
  enrichExistingLinks,
  type TraceRef,
} from '../../src/gui/ai/trace-links.js';

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

describe('case-insensitive and context-file harvesting', () => {
  it('harvests the row label from a get_row_context {files} result via the self-file H1', () => {
    const m = new Map<string, TraceRef | null>();
    collectLinkables(
      { table: 'dbq_essays', id: 'e7' },
      {
        files: [
          {
            name: 'ESSAY.md',
            content:
              '---\ndbq_essays_id: e7\n---\n\n# Technology as a Tool of Colonial Conquest and Exploitation\n\n- **thesis:** ...\n',
          },
        ],
      },
      m,
    );
    expect(m.get('Technology as a Tool of Colonial Conquest and Exploitation')).toEqual({
      table: 'dbq_essays',
      id: 'e7',
    });
  });

  it('matches a distinctive label case-insensitively, keeping the prose casing', () => {
    const m = new Map<string, TraceRef | null>([
      ['Technology as a Tool of Colonial Conquest', { table: 'dbq_essays', id: 'e7' }],
    ]);
    expect(
      applyTraceLinks('Your thesis on technology as a tool of colonial conquest was strong.', m),
    ).toBe(
      'Your thesis on [technology as a tool of colonial conquest](lattice://dbq_essays/e7) was strong.',
    );
  });

  it('keeps short single-word labels exact-case only', () => {
    const m = new Map<string, TraceRef | null>([['Review', { table: 'tasks', id: 't1' }]]);
    expect(applyTraceLinks('Please review the plan; the Review is due.', m)).toBe(
      'Please review the plan; the [Review](lattice://tasks/t1) is due.',
    );
  });

  it('does not double-wrap a case-insensitive hit inside a link made by the exact pass', () => {
    const m = new Map<string, TraceRef | null>([
      ['Atlas Migration Plan', { table: 'projects', id: 'p1' }],
    ]);
    expect(applyTraceLinks('See Atlas Migration Plan and atlas migration plan.', m)).toBe(
      'See [Atlas Migration Plan](lattice://projects/p1) and [atlas migration plan](lattice://projects/p1).',
    );
  });
});

describe('appendSources', () => {
  it('cites a focused read the answer never referenced', () => {
    const focused = new Map([
      ['dbq_essays/e7', { table: 'dbq_essays', id: 'e7', label: 'Technology Essay' }],
    ]);
    expect(appendSources('Your position was that technology drove conquest.', focused)).toBe(
      'Your position was that technology drove conquest.\n\nSources: [Technology Essay](lattice://dbq_essays/e7)',
    );
  });

  it('skips refs already linked in the text and appends nothing when all are covered', () => {
    const focused = new Map([
      ['dbq_essays/e7', { table: 'dbq_essays', id: 'e7', label: 'Technology Essay' }],
    ]);
    const text = 'See [Technology Essay](lattice://dbq_essays/e7).';
    expect(appendSources(text, focused)).toBe(text);
  });

  it('cites only refs relevant to the answer — unrelated reads are never footered', () => {
    const focused = new Map<string, { table: string; id: string; label: string }>();
    // Eight unrelated reads (labels share nothing with the answer) + one relevant.
    for (let i = 0; i < 8; i++) {
      focused.set(`notes/n${i}`, { table: 'notes', id: `n${i}`, label: `Quarterly Budget ${i}` });
    }
    focused.set('dbq_essays/e7', {
      table: 'dbq_essays',
      id: 'e7',
      label: 'Technology as a Tool of Colonial Conquest and Exploitation',
    });
    const out = appendSources(
      'Your position: technology drove colonial conquest and exploitation of colonies.',
      focused,
      3,
    );
    expect(out).toContain('Sources: ');
    expect((out.match(/lattice:\/\//g) ?? []).length).toBe(1); // only the relevant essay
    expect(out).toContain('lattice://dbq_essays/e7');
    expect(out).not.toContain('lattice://notes/');
  });

  it('appends nothing when no focused ref is relevant to the answer', () => {
    const focused = new Map([
      ['notes/n1', { table: 'notes', id: 'n1', label: 'Quarterly Budget Review' }],
    ]);
    expect(appendSources('Summary of something unrelated entirely.', focused)).toBe(
      'Summary of something unrelated entirely.',
    );
  });
});

describe('collectFromMarkdown (thread-history links)', () => {
  it('harvests label, table, and decoded id from prior assistant links', () => {
    const linkables = new Map<string, TraceRef | null>();
    const focused = new Map<string, { table: string; id: string; label: string }>();
    collectFromMarkdown(
      'Sources: [Technology Essay](lattice://dbq_essays/e%207) and [Atlas Migration](lattice://projects/p1).',
      linkables,
      focused,
    );
    expect(linkables.get('Technology Essay')).toEqual({ table: 'dbq_essays', id: 'e 7' });
    expect(focused.get('projects/p1')).toEqual({
      table: 'projects',
      id: 'p1',
      label: 'Atlas Migration',
    });
  });

  it('poisons a label that conflicts with an already-harvested ref', () => {
    const linkables = new Map<string, TraceRef | null>([
      ['Atlas Migration', { table: 'projects', id: 'p1' }],
    ]);
    collectFromMarkdown('[Atlas Migration](lattice://notes/n9)', linkables);
    expect(linkables.get('Atlas Migration')).toBeNull();
  });
});

describe('source-field detection (?f= emission)', () => {
  it('carries ?f=<column> when the answer quotes a field near-verbatim', () => {
    const thesis =
      'Technology enabled industrialized Western powers to conquer and exploit less developed colonies through superior weaponry, medicine, and infrastructure.';
    const m = map([['Colonial Tech Essay', { table: 'dbq_essays', id: 'e7', fields: { thesis } }]]);
    const answer = `Your position: ${thesis} You also noted winners and losers. See Colonial Tech Essay.`;
    const out = applyTraceLinks(answer, m);
    expect(out).toContain('(lattice://dbq_essays/e7?f=thesis)');
  });

  it('omits ?f= when the answer only paraphrases (no shared 8-word run)', () => {
    const m = map([
      [
        'Colonial Tech Essay',
        {
          table: 'dbq_essays',
          id: 'e7',
          fields: {
            thesis:
              'Technology enabled Western powers to conquer colonies through many overwhelming means and methods entirely.',
          },
        },
      ],
    ]);
    const out = applyTraceLinks('The Colonial Tech Essay argues conquest was tech-driven.', m);
    expect(out).toContain('(lattice://dbq_essays/e7)');
    expect(out).not.toContain('?f=');
  });

  it('appendSources carries ?f= for a quoted focused read', () => {
    const thesis =
      'Global silver flow reshaped trade networks across three continents and transformed economic and social structures during the early modern period.';
    const focused = new Map([
      [
        'dbq_essays/e9',
        { table: 'dbq_essays', id: 'e9', label: 'Silver Flow DBQ', fields: { thesis } },
      ],
    ]);
    const out = appendSources(`You argued: ${thesis}`, focused);
    expect(out).toContain('Sources: [Silver Flow DBQ](lattice://dbq_essays/e9?f=thesis)');
  });

  it('collectFromMarkdown strips a ?f= query from harvested ids', () => {
    const linkables = new Map<string, TraceRef | null>();
    collectFromMarkdown('[Silver Flow DBQ](lattice://dbq_essays/e9?f=thesis)', linkables);
    expect(linkables.get('Silver Flow DBQ')).toEqual({ table: 'dbq_essays', id: 'e9' });
  });
});

describe('enrichExistingLinks', () => {
  it('adds ?f= to a model-emitted link when the answer quotes a known field', () => {
    const thesis =
      'Technology enabled industrialized Western powers to conquer and exploit less developed colonies through superior weaponry and infrastructure.';
    const focused = new Map([
      ['dbq_essays/e7', { table: 'dbq_essays', id: 'e7', label: 'DBQ', fields: { thesis } }],
    ]);
    const text = `Per [the DBQ essay](lattice://dbq_essays/e7): ${thesis}`;
    expect(enrichExistingLinks(text, focused)).toContain('(lattice://dbq_essays/e7?f=thesis)');
  });

  it('leaves links with an existing query or unknown refs untouched', () => {
    const focused = new Map([
      [
        'dbq_essays/e7',
        { table: 'dbq_essays', id: 'e7', label: 'DBQ', fields: { thesis: 'word '.repeat(20) } },
      ],
    ]);
    const t1 = '[DBQ](lattice://dbq_essays/e7?f=title)';
    const t2 = '[Other](lattice://notes/n1)';
    expect(enrichExistingLinks(t1, focused)).toBe(t1);
    expect(enrichExistingLinks(t2, focused)).toBe(t2);
  });
});
