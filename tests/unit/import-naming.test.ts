import { describe, expect, it } from 'vitest';
import {
  MAX_NAME_ASSIST_CALLS,
  resolveImportNames,
  type NameAssist,
} from '../../src/gui/import-naming.js';
import { applySourceNameFallback } from '../../src/import/name-policy.js';
import { isGenericTableName } from '../../src/gui/model-contract.js';

/**
 * The import name resolver: deterministic first, with a BOUNDED model assist
 * used only to break ties between keys that would otherwise collapse onto the
 * same file-derived label. With no assist configured the resolver still returns
 * a complete, non-generic answer — a missing model degrades the NAMES, never the
 * import.
 */

const keys = (names: string[]): { key: string }[] => names.map((key) => ({ key }));

describe('resolveImportNames — deterministic path', () => {
  it('passes a meaningful key through unchanged', async () => {
    const r = await resolveImportNames(keys(['Invoices', 'Line Items']), {
      sourceName: 'ledger.xlsx',
    });
    expect(r.names).toEqual({ Invoices: 'Invoices', 'Line Items': 'Line Items' });
    expect(r.assistUsed).toBe(false);
    expect(r.assistCalls).toBe(0);
    expect(r.assistUnavailable).toBe(false);
  });

  it('names a single anonymous key from the file it came from', async () => {
    const r = await resolveImportNames(keys(['Sheet1']), { sourceName: 'Q3 Report.xlsx' });
    expect(r.names).toEqual({ Sheet1: 'Q3 Report' });
    // One anonymous key is not a tie — no assist is wanted.
    expect(r.assistUnavailable).toBe(false);
  });

  it('is deterministic with no provider: repeated runs give the same names', async () => {
    const input = keys(['Sheet1', 'Sheet2', 'table_1']);
    const a = await resolveImportNames(input, { sourceName: 'Q3 Report.xlsx' });
    const b = await resolveImportNames(input, { sourceName: 'Q3 Report.xlsx' });
    expect(a.names).toEqual(b.names);
    expect(Object.values(a.names)).toEqual(['Q3 Report', 'Q3 Report 2', 'Q3 Report 3']);
  });

  it('never emits a generic name, even from a generically-named file', async () => {
    const r = await resolveImportNames(keys(['Sheet1', 'table_1', 'untitled', 'unnamed']), {
      sourceName: 'untitled.xlsx',
    });
    for (const [key, name] of Object.entries(r.names)) {
      expect(isGenericTableName(name), `${key} -> ${name}`).toBe(false);
    }
  });

  it('avoids names already taken in the workspace', async () => {
    const r = await resolveImportNames(keys(['Sheet1']), {
      sourceName: 'Q3 Report.xlsx',
      taken: ['q3_report'],
    });
    expect(r.names.Sheet1).toBe('Q3 Report 2');
  });

  it('reports that a tie needed the assist when none is configured', async () => {
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2']), {
      sourceName: 'Q3 Report.xlsx',
    });
    expect(r.assistUnavailable).toBe(true);
    expect(r.assistUsed).toBe(false);
    // ...and still returns a complete, non-generic answer.
    expect(Object.values(r.names)).toEqual(['Q3 Report', 'Q3 Report 2']);
  });

  it('matches the deterministic source-key fallback exactly (one naming policy)', async () => {
    // The confirm-card apply door re-derives names with applySourceNameFallback.
    // With no assist the resolver MUST agree with it, or a proposal and its apply
    // would create differently-named tables from the same bytes.
    const data: Record<string, unknown> = {
      Sheet1: [{ a: 1 }],
      Sheet2: [{ b: 2 }],
      Customers: [{ c: 3 }],
    };
    const fallback = Object.keys(applySourceNameFallback(data, 'Q3 Report.xlsx'));
    const r = await resolveImportNames(keys(Object.keys(data)), {
      sourceName: 'Q3 Report.xlsx',
    });
    expect(Object.values(r.names)).toEqual(fallback);
  });
});

describe('resolveImportNames — bounded assist', () => {
  function counting(
    suggest: (k: string[]) => Record<string, string>,
  ): NameAssist & { calls: number } {
    const assist = {
      calls: 0,
      suggest(input: { keys: string[] }) {
        assist.calls++;
        return Promise.resolve(suggest(input.keys));
      },
    };
    return assist;
  }

  it('calls the assist at most once for a whole import, however many ties', async () => {
    const assist = counting((ks) => Object.fromEntries(ks.map((k, i) => [k, `Region ${i + 1}`])));
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4']), {
      sourceName: 'Q3 Report.xlsx',
      assist,
    });
    expect(assist.calls).toBe(1);
    expect(r.assistCalls).toBe(1);
    expect(r.assistCalls).toBeLessThanOrEqual(MAX_NAME_ASSIST_CALLS);
    expect(r.assistUsed).toBe(true);
    expect(Object.values(r.names)).toEqual(['Region 1', 'Region 2', 'Region 3', 'Region 4']);
  });

  it('never calls the assist when there is no tie to break', async () => {
    const assist = counting(() => ({}));
    await resolveImportNames(keys(['Invoices', 'Sheet1']), {
      sourceName: 'ledger.xlsx',
      assist,
    });
    expect(assist.calls).toBe(0);
  });

  it('honours a caller-supplied call cap of zero (assist disabled)', async () => {
    const assist = counting(() => ({ Sheet1: 'East', Sheet2: 'West' }));
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2']), {
      sourceName: 'Q3 Report.xlsx',
      assist,
      maxAssistCalls: 0,
    });
    expect(assist.calls).toBe(0);
    expect(r.assistUnavailable).toBe(true);
    expect(Object.values(r.names)).toEqual(['Q3 Report', 'Q3 Report 2']);
  });

  it('rejects a generic suggestion and reports it rather than accepting it', async () => {
    const assist = counting(() => ({ Sheet1: 'Table 1', Sheet2: 'Western Region' }));
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2']), {
      sourceName: 'Q3 Report.xlsx',
      assist,
    });
    expect(r.names.Sheet2).toBe('Western Region');
    expect(r.names.Sheet1).toBe('Q3 Report');
    expect(r.assistNotes.join(' ')).toContain('Table 1');
    expect(isGenericTableName(r.names.Sheet1 ?? '')).toBe(false);
  });

  it('rejects a suggestion that collides with a name already used', async () => {
    const assist = counting(() => ({ Sheet1: 'East', Sheet2: 'east' }));
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2']), {
      sourceName: 'Q3 Report.xlsx',
      assist,
    });
    expect(r.names.Sheet1).toBe('East');
    expect(r.names.Sheet2).toBe('Q3 Report');
    expect(r.assistNotes.join(' ')).toContain('east');
  });

  it('surfaces an assist failure in the result instead of swallowing it', async () => {
    const assist: NameAssist = {
      suggest: () => Promise.reject(new Error('model provider unreachable')),
    };
    const r = await resolveImportNames(keys(['Sheet1', 'Sheet2']), {
      sourceName: 'Q3 Report.xlsx',
      assist,
    });
    expect(r.assistNotes.join(' ')).toContain('model provider unreachable');
    expect(r.assistUnavailable).toBe(true);
    // The import still gets a complete, deterministic answer.
    expect(Object.values(r.names)).toEqual(['Q3 Report', 'Q3 Report 2']);
  });
});
