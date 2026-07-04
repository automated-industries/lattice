import { describe, expect, it } from 'vitest';
import { buildComputedProposals } from '../../src/import/computed-proposals.js';
import type { WorkbookFormulaSummary } from '../../src/import/excel.js';
import { inferSchema } from '../../src/import/infer.js';

/** Order-line records with a formula-derived Total (the calc candidate). */
function orderRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    Sku: 'SKU-' + String(i),
    Price: 10 + i,
    Qty: (i % 5) + 1,
    Total: (10 + i) * ((i % 5) + 1),
  }));
}

/** The formula summary an Excel read of those orders would produce. */
function orderSummary(rows: number): WorkbookFormulaSummary {
  return {
    Orders: {
      columnLetters: { A: 'Sku', B: 'Price', C: 'Qty', D: 'Total' },
      columns: {
        Total: {
          total: rows,
          formulaRows: rows,
          patterns: { '[B]*[C]': rows },
          example: 'B2*C2',
        },
      },
    },
  };
}

/** Rows with a category-shaped text column just past dimension cardinality:
 *  150 rows, 75 distinct values (75 > 64, 75/150 = 0.5 ≤ 0.5). */
function ticketRows(column: string): Record<string, unknown>[] {
  return Array.from({ length: 150 }, (_, i) => ({
    Ref: 'T-' + String(i),
    [column]: 'Val ' + String(i % 75),
  }));
}

describe('buildComputedProposals — calc fields', () => {
  it('proposes a calc field for a dominant translatable formula column', () => {
    const data = { Orders: orderRows(20) };
    const plan = inferSchema(data);
    const proposals = buildComputedProposals({
      data,
      plan,
      rename: {},
      formulaSummary: orderSummary(20),
      existingTables: [],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ entity: 'orders', table: 'orders_computed' });
    expect(proposals[0]!.fields).toEqual([
      {
        name: 'total_calc',
        kind: 'calc',
        expr: '(price * qty)',
        sourceColumns: ['price', 'qty'],
        confidence: 1,
        example: 'B2*C2',
      },
    ]);
  });

  it('suffixes the table name deterministically on collision', () => {
    const data = { Orders: orderRows(20) };
    const plan = inferSchema(data);
    const proposals = buildComputedProposals({
      data,
      plan,
      rename: {},
      formulaSummary: orderSummary(20),
      existingTables: ['orders_computed', 'orders_computed_2'],
    });
    expect(proposals[0]?.table).toBe('orders_computed_3');
  });

  it('names the base table through the schema-match rename', () => {
    const data = { Orders: orderRows(20) };
    const plan = inferSchema(data);
    const proposals = buildComputedProposals({
      data,
      plan,
      rename: { orders: 'order_lines' },
      formulaSummary: orderSummary(20),
      existingTables: ['order_lines'],
    });
    expect(proposals[0]).toMatchObject({ entity: 'order_lines', table: 'order_lines_computed' });
  });

  it('drops the proposal when a referenced column did not survive as a scalar', () => {
    // 'Region' is consumed into a dimension (3 distinct over 20 rows), so a
    // formula referencing it has no base column to read.
    const data = {
      Orders: orderRows(20).map((r, i) => ({ ...r, Region: ['NA', 'EU', 'Asia'][i % 3] })),
    };
    const plan = inferSchema(data);
    expect(plan.dimensions.some((d) => d.name === 'region')).toBe(true);
    const summary: WorkbookFormulaSummary = {
      Orders: {
        columnLetters: { B: 'Price', C: 'Qty', D: 'Total', E: 'Region' },
        columns: {
          Total: {
            total: 20,
            formulaRows: 20,
            patterns: { 'IF([E]="NA",[B],0)': 20 },
            example: 'IF(E2="NA",B2,0)',
          },
        },
      },
    };
    expect(
      buildComputedProposals({
        data,
        plan,
        rename: {},
        formulaSummary: summary,
        existingTables: [],
      }),
    ).toEqual([]);
  });

  it('drops the proposal when the pattern is not dominant or not translatable', () => {
    const data = { Orders: orderRows(20) };
    const plan = inferSchema(data);
    const notDominant = orderSummary(20);
    notDominant.Orders!.columns.Total!.patterns = { '[B]*[C]': 10, '[B]+[C]': 10 };
    expect(
      buildComputedProposals({
        data,
        plan,
        rename: {},
        formulaSummary: notDominant,
        existingTables: [],
      }),
    ).toEqual([]);
    const untranslatable = orderSummary(20);
    untranslatable.Orders!.columns.Total!.patterns = { 'VLOOKUP([B],[C],2)': 20 };
    expect(
      buildComputedProposals({
        data,
        plan,
        rename: {},
        formulaSummary: untranslatable,
        existingTables: [],
      }),
    ).toEqual([]);
  });
});

describe('buildComputedProposals — classifier fields', () => {
  it('proposes a classifier for a category-named column just past dimension cardinality', () => {
    const data = { Tickets: ticketRows('Issue Type') };
    const plan = inferSchema(data);
    // Sanity: past the dimension cap, so it stayed a plain scalar column.
    expect(plan.dimensions).toEqual([]);
    const proposals = buildComputedProposals({
      data,
      plan,
      rename: {},
      formulaSummary: null,
      existingTables: [],
    });
    expect(proposals).toHaveLength(1);
    const field = proposals[0]!.fields[0]!;
    expect(field.name).toBe('issue_type_class');
    expect(field.kind).toBe('ai_classify');
    expect(field.input).toBe('issue_type');
    expect(field.prompt).toMatch(/issue_type/);
    // Starter labels: the most frequent values, capped at 8 — the engine
    // requires a non-empty label set.
    expect(field.labels).toHaveLength(8);
    expect(field.confidence).toBeGreaterThan(0);
    expect(field.confidence).toBeLessThanOrEqual(1);
  });

  it('does not propose without a category-suggesting name', () => {
    const data = { Tickets: ticketRows('Vendor Ref') };
    const proposals = buildComputedProposals({
      data,
      plan: inferSchema(data),
      rename: {},
      formulaSummary: null,
      existingTables: [],
    });
    expect(proposals).toEqual([]);
  });

  it('does not propose in dimension territory (low cardinality)', () => {
    // 10 distinct values over 150 rows → dimension extraction owns it.
    const data = {
      Tickets: Array.from({ length: 150 }, (_, i) => ({
        Ref: 'T-' + String(i),
        Status: 'S' + String(i % 10),
      })),
    };
    const plan = inferSchema(data);
    expect(plan.dimensions.some((d) => d.name === 'status')).toBe(true);
    expect(
      buildComputedProposals({ data, plan, rename: {}, formulaSummary: null, existingTables: [] }),
    ).toEqual([]);
  });

  it('does not propose for near-unique or oversized value sets', () => {
    // 300 distinct over 600 rows is within ratio but past the 256 cap.
    const oversized = {
      Tickets: Array.from({ length: 600 }, (_, i) => ({
        Ref: 'T-' + String(i),
        Category: 'C' + String(i % 300),
      })),
    };
    expect(
      buildComputedProposals({
        data: oversized,
        plan: inferSchema(oversized),
        rename: {},
        formulaSummary: null,
        existingTables: [],
      }),
    ).toEqual([]);
    // Near-unique: 100 distinct over 150 rows (ratio 0.67 > 0.5).
    const nearUnique = {
      Tickets: Array.from({ length: 150 }, (_, i) => ({
        Ref: 'T-' + String(i),
        Category: 'C' + String(i % 100),
      })),
    };
    expect(
      buildComputedProposals({
        data: nearUnique,
        plan: inferSchema(nearUnique),
        rename: {},
        formulaSummary: null,
        existingTables: [],
      }),
    ).toEqual([]);
  });

  it('does not propose for small tables', () => {
    // Same shape but under the 50-row floor.
    const data = {
      Tickets: Array.from({ length: 40 }, (_, i) => ({
        Ref: 'T-' + String(i),
        // 35 distinct over 40 rows would ALSO fail cardinality; use a shape
        // that passes everything except the row floor to isolate the gate:
        // 66 distinct needs ≥ 132 rows, impossible under 50 — so assert the
        // row floor with an otherwise-valid name and accept the combined gate.
        Category: 'C' + String(i),
      })),
    };
    expect(
      buildComputedProposals({
        data,
        plan: inferSchema(data),
        rename: {},
        formulaSummary: null,
        existingTables: [],
      }),
    ).toEqual([]);
  });

  it('caps classifiers at one per entity and three per import', () => {
    // One entity with TWO qualifying columns → only the first proposes.
    const twoColumns = {
      Tickets: Array.from({ length: 150 }, (_, i) => ({
        Ref: 'T-' + String(i),
        Category: 'C' + String(i % 75),
        Segment: 'S' + String(i % 75),
      })),
    };
    const perEntity = buildComputedProposals({
      data: twoColumns,
      plan: inferSchema(twoColumns),
      rename: {},
      formulaSummary: null,
      existingTables: [],
    });
    expect(perEntity).toHaveLength(1);
    expect(perEntity[0]!.fields).toHaveLength(1);
    expect(perEntity[0]!.fields[0]!.name).toBe('category_class');

    // Four entities with qualifying columns → three classifiers per import.
    const rows = (key: string) =>
      Array.from({ length: 150 }, (_, i) => ({
        [key + ' Id']: 'K-' + String(i),
        Category: 'C' + String(i % 75),
      }));
    const fourEntities = { A1: rows('A'), B1: rows('B'), C1: rows('C'), D1: rows('D') };
    const capped = buildComputedProposals({
      data: fourEntities,
      plan: inferSchema(fourEntities),
      rename: {},
      formulaSummary: null,
      existingTables: [],
    });
    expect(capped).toHaveLength(3);
  });
});
