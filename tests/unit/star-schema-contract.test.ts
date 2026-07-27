import { describe, expect, it } from 'vitest';
import {
  MIN_TABLE_COLUMNS,
  MIN_TABLE_ROWS,
  admitModelTable,
  admitPlan,
  checkStarSchemaContract,
  isGenericTableName,
  type ModelTableCandidate,
} from '../../src/gui/model-contract.js';

/**
 * The star-schema validity contract: five named, individually-testable
 * conditions a proposed table must satisfy before it is allowed into the model.
 * The check returns per-condition results (not a bare boolean) so a caller can
 * tell the user WHICH condition failed rather than "the import was skipped".
 */

function candidate(over: Partial<ModelTableCandidate> = {}): ModelTableCandidate {
  return {
    name: 'invoices',
    columns: ['invoice_no', 'customer', 'amount'],
    rowCount: 12,
    naturalKey: 'invoice_no',
    ...over,
  };
}

describe('isGenericTableName', () => {
  it.each(['Table 1', 'Sheet3', 'untitled', 'unnamed', 'tab_2'])('flags %s', (name) => {
    expect(isGenericTableName(name)).toBe(true);
  });

  it.each(['Invoices', 'Q3 Revenue', 'holdings'])('passes %s', (name) => {
    expect(isGenericTableName(name)).toBe(false);
  });
});

describe('checkStarSchemaContract', () => {
  it('admits a well-formed table and reports all five conditions', () => {
    const r = checkStarSchemaContract(candidate());
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.conditions.map((c) => c.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
    expect(r.conditions.every((c) => c.ok)).toBe(true);
    expect(r.reason).toBe('');
  });

  it('C1 fails alone for a positional name, and names the condition', () => {
    const r = checkStarSchemaContract(candidate({ name: 'Sheet1' }));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['C1']);
    const c1 = r.conditions.find((c) => c.id === 'C1');
    expect(c1?.name).toBe('named');
    expect(c1?.reason).toContain('Sheet1');
    expect(r.reason).toContain('C1');
  });

  it('C2 fails alone for a single-column table', () => {
    const r = checkStarSchemaContract(candidate({ columns: ['amount'] }));
    expect(r.failed).toEqual(['C2']);
    expect(r.conditions.find((c) => c.id === 'C2')?.name).toBe('tabular');
    expect(r.conditions.find((c) => c.id === 'C2')?.reason).toContain(String(MIN_TABLE_COLUMNS));
  });

  it('C2 counts DISTINCT columns — repeated headers are one column', () => {
    expect(checkStarSchemaContract(candidate({ columns: ['amount', 'amount'] })).failed).toEqual([
      'C2',
    ]);
  });

  it.each([0, 1])('C3 fails alone at %i rows', (rowCount) => {
    const r = checkStarSchemaContract(candidate({ rowCount }));
    expect(r.failed).toEqual(['C3']);
    expect(r.conditions.find((c) => c.id === 'C3')?.name).toBe('populated');
    expect(r.conditions.find((c) => c.id === 'C3')?.reason).toContain(String(MIN_TABLE_ROWS));
  });

  it('C4 fails alone when the rows have no repeatable identity', () => {
    const r = checkStarSchemaContract(candidate({ naturalKey: null, uniformColumns: false }));
    expect(r.failed).toEqual(['C4']);
    expect(r.conditions.find((c) => c.id === 'C4')?.name).toBe('stable-grain');
  });

  it('C4 passes for a keyless table whose rows share one column set', () => {
    expect(checkStarSchemaContract(candidate({ naturalKey: null })).ok).toBe(true);
    expect(checkStarSchemaContract(candidate({ naturalKey: null, uniformColumns: true })).ok).toBe(
      true,
    );
  });

  it('C4 passes for a ragged table that still declares a natural key', () => {
    expect(
      checkStarSchemaContract(candidate({ naturalKey: 'invoice_no', uniformColumns: false })).ok,
    ).toBe(true);
  });

  it('C5 fails alone when the name collides with a sibling under normalization', () => {
    const r = checkStarSchemaContract(candidate({ name: 'Invoices' }), {
      siblingNames: ['invoices'],
    });
    expect(r.failed).toEqual(['C5']);
    expect(r.conditions.find((c) => c.id === 'C5')?.name).toBe('distinct');
    expect(r.conditions.find((c) => c.id === 'C5')?.reason).toContain('invoices');
  });

  it('reports every failing condition, not just the first', () => {
    const r = checkStarSchemaContract(
      candidate({ name: 'table_1', columns: ['a'], rowCount: 0, naturalKey: null }),
      { siblingNames: ['table 1'] },
    );
    expect(r.failed).toEqual(['C1', 'C2', 'C3', 'C5']);
    expect(r.ok).toBe(false);
  });

  it('honours explicit floors so a caller can relax a condition it does not enforce', () => {
    const r = checkStarSchemaContract(candidate({ columns: ['amount'], rowCount: 1 }), {
      minColumns: 1,
      minRows: 1,
    });
    expect(r.ok).toBe(true);
  });
});

describe('admitModelTable', () => {
  it('is the contract check for a table that is not yet in the model', () => {
    const r = admitModelTable(candidate({ name: 'sheet1' }));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['C1']);
  });

  it('exempts a table already registered in the workspace', () => {
    // A workspace seeded by an older release can legitimately hold a `table_1`;
    // re-importing into it must keep working rather than being refused.
    const r = admitModelTable(candidate({ name: 'table_1', columns: ['a'], rowCount: 0 }), {
      registered: ['table_1'],
    });
    expect(r.ok).toBe(true);
    expect(r.exempt).toBe(true);
    expect(r.failed).toEqual([]);
  });
});

describe('admitPlan', () => {
  it('splits admitted from rejected and names the failing condition per rejection', () => {
    const r = admitPlan([
      candidate({ name: 'invoices' }),
      candidate({ name: 'Sheet1' }),
      candidate({ name: 'line_items', columns: ['sku'], rowCount: 3 }),
    ]);
    expect(r.admitted.map((c) => c.name)).toEqual(['invoices']);
    expect(r.rejected.map((x) => x.name)).toEqual(['Sheet1', 'line_items']);
    expect(r.rejected[0]?.failed).toEqual(['C1']);
    expect(r.rejected[1]?.failed).toEqual(['C2']);
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0]).toContain('Sheet1');
    expect(r.notices[0]).toContain('C1');
  });

  it('applies C5 across the plan — the first table keeps the name, the second is rejected', () => {
    const r = admitPlan([candidate({ name: 'invoices' }), candidate({ name: 'Invoices' })]);
    expect(r.admitted.map((c) => c.name)).toEqual(['invoices']);
    expect(r.rejected[0]?.failed).toEqual(['C5']);
  });

  it('checks C5 against tables already registered in the workspace without rejecting them', () => {
    // `invoices` is already in the model: the incoming table of the same name is
    // an append into it, not a colliding new table.
    const r = admitPlan([candidate({ name: 'invoices' })], { registered: ['invoices'] });
    expect(r.rejected).toEqual([]);
    expect(r.admitted[0]?.name).toBe('invoices');
  });

  it('can enforce a subset of conditions and report the rest', () => {
    const r = admitPlan([candidate({ name: 'notes', columns: ['body'], rowCount: 9 })], {
      enforce: ['C1'],
    });
    expect(r.admitted.map((c) => c.name)).toEqual(['notes']);
    expect(r.rejected).toEqual([]);
    // Not enforced, but still reported so the outcome is never invisible.
    expect(r.reported[0]?.failed).toEqual(['C2']);
    expect(r.notices[0]).toContain('C2');
  });
});
