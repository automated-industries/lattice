import { describe, expect, it } from 'vitest';
import { detect } from '../../src/gui/planner/detect.js';
import type { ColumnStat, ModelProfile, TableProfile } from '../../src/gui/planner/types.js';

// ── fixture helpers ──────────────────────────────────────────────────────────
function col(name: string, over: Partial<ColumnStat> = {}): ColumnStat {
  return {
    name,
    sqlType: 'text',
    inferredType: 'text',
    distinctSampled: 0,
    distinctIsCapped: false,
    nullRate: 0,
    sampleValues: [],
    isForeignKey: false,
    isPrimaryKey: false,
    ...over,
  };
}
function table(name: string, over: Partial<TableProfile> = {}): TableProfile {
  return {
    name,
    tier: 'lattice',
    rowCount: 0,
    rowCountCapped: false,
    sampledRowCount: 0,
    primaryKey: ['id'],
    naturalKey: null,
    columns: [],
    relations: [],
    hasDefinition: false,
    ...over,
  };
}
function profile(tables: TableProfile[], over: Partial<ModelProfile> = {}): ModelProfile {
  return { tables, existingJunctions: [], existingComputed: [], skipped: [], ...over };
}
function vals(n: number, prefix = 'c'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1)}`);
}

describe('data-model planner — detect (pure rules engine)', () => {
  it('R1: AUTO relationship when the FK gate clears', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      rowCount: 50,
      sampledRowCount: 10,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    const orders = table('orders', {
      rowCount: 50,
      sampledRowCount: 50,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('customer', { distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    const ops = detect(profile([customers, orders]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'add_relationship',
      tier: 'auto',
      class: 'additive',
      target: { table: 'orders', column: 'customer', toTable: 'customers' },
      id: 'add_relationship:orders:customer:customers',
    });
    expect(ops[0].evidence.gatesPass).toBe(true);
  });

  it('R1: PROPOSE (not AUTO) when the source column is a tiny enum below the distinct floor', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      rowCount: 50,
      sampledRowCount: 10,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    const orders = table('orders', {
      rowCount: 50,
      sampledRowCount: 50,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('tier', { distinctSampled: 3, sampleValues: vals(3) }), // only 3 distinct → below minFkDistinct
      ],
    });
    const ops = detect(profile([customers, orders]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add_relationship', tier: 'propose' });
    expect(ops[0].evidence.gatesPass).toBe(false);
  });

  it('R1: PROPOSE (not AUTO) when the sample was capped (coverage not fully known)', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      rowCount: 5000,
      sampledRowCount: 200,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 200, distinctIsCapped: true, sampleValues: vals(200) }),
      ],
    });
    const orders = table('orders', {
      rowCount: 5000,
      sampledRowCount: 200,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('customer', { distinctSampled: 200, distinctIsCapped: true, sampleValues: vals(200) }),
      ],
    });
    const ops = detect(profile([customers, orders]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add_relationship', tier: 'propose' });
  });

  it('R5: PROPOSE extract_dimension for a repeated low-cardinality column', () => {
    const orders = table('orders', {
      rowCount: 100,
      sampledRowCount: 100,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('region', { distinctSampled: 4, sampleValues: ['east', 'west', 'north', 'south'] }),
      ],
    });
    const ops = detect(profile([orders]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'extract_dimension',
      tier: 'propose',
      class: 'restructure',
      target: { table: 'orders', column: 'region', toTable: 'region' },
    });
  });

  it('R8: PROPOSE retype for a TEXT column whose values are uniformly numeric', () => {
    const events = table('events', {
      rowCount: 40,
      sampledRowCount: 40,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('count', { sqlType: 'text', inferredType: 'integer', distinctSampled: 20 }),
      ],
    });
    const ops = detect(profile([events]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'retype_column',
      tier: 'propose',
      target: { table: 'events', column: 'count' },
      evidence: { from: 'text', to: 'integer' },
    });
  });

  it('R6: PROPOSE dedup when the natural key repeats within the sample', () => {
    const people = table('people', {
      naturalKey: 'email',
      rowCount: 10,
      sampledRowCount: 10,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('email', { distinctSampled: 8, sampleValues: vals(8, 'e') }),
      ],
    });
    const ops = detect(profile([people]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'dedup_rows',
      tier: 'propose',
      target: { table: 'people' },
    });
  });

  it('R7: PROPOSE merge for two tables with overlapping columns + same key', () => {
    const mk = (name: string): TableProfile =>
      table(name, {
        naturalKey: 'email',
        rowCount: 20,
        sampledRowCount: 20,
        columns: [
          col('id', { isPrimaryKey: true }),
          col('email', { distinctSampled: 20, sampleValues: vals(20, 'e') }),
          col('name', {}),
        ],
      });
    const ops = detect(profile([mk('contacts_a'), mk('contacts_b')]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'merge_tables',
      tier: 'propose',
      target: { table: 'contacts_b', toTable: 'contacts_a' },
      id: 'merge_tables:contacts_a::contacts_b',
    });
  });

  it('R9: PROPOSE canonical rename for a table name with whitespace', () => {
    const t = table('Sales Report', { columns: [col('id', { isPrimaryKey: true })] });
    const ops = detect(profile([t]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'canonical_rename',
      tier: 'propose',
      target: { table: 'Sales Report', toTable: 'sales_report' },
    });
  });

  it('convergence: a clean star schema yields an empty plan', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      hasDefinition: true,
      rowCount: 50,
      sampledRowCount: 50,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 50, sampleValues: vals(50) }),
        col('name', { distinctSampled: 50 }),
      ],
    });
    const orders = table('orders', {
      naturalKey: 'order_code',
      rowCount: 200,
      sampledRowCount: 200,
      relations: [
        {
          name: 'customer',
          kind: 'belongsTo',
          targetTable: 'customers',
          foreignKey: 'customer_id',
        },
      ],
      columns: [
        col('id', { isPrimaryKey: true }),
        col('order_code', { distinctSampled: 200, sampleValues: vals(200, 'o') }),
        col('customer_id', { isForeignKey: true, distinctSampled: 50, sampleValues: vals(50) }),
        col('amount', { sqlType: 'real', inferredType: 'real', distinctSampled: 150 }),
      ],
    });
    expect(detect(profile([customers, orders]))).toEqual([]);
  });

  it('idempotence: once R1 is applied, re-detecting does not re-propose it', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      rowCount: 50,
      sampledRowCount: 10,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    const ordersAfterApply = table('orders', {
      rowCount: 50,
      sampledRowCount: 50,
      // the applied relationship is now reflected on the profile
      relations: [
        { name: 'customer', kind: 'belongsTo', targetTable: 'customers', foreignKey: 'customer' },
      ],
      columns: [
        col('id', { isPrimaryKey: true }),
        col('customer', { isForeignKey: true, distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    expect(detect(profile([customers, ordersAfterApply]))).toEqual([]);
  });

  it('determinism: same profile → byte-identical plan across runs', () => {
    const customers = table('customers', {
      naturalKey: 'code',
      rowCount: 50,
      sampledRowCount: 10,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('code', { distinctSampled: 10, sampleValues: vals(10) }),
      ],
    });
    const orders = table('Order Lines', {
      naturalKey: 'line_id',
      rowCount: 100,
      sampledRowCount: 100,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('line_id', { distinctSampled: 90, sampleValues: vals(90, 'l') }), // repeats → dedup
        col('customer', { distinctSampled: 10, sampleValues: vals(10) }), // → auto relationship
        col('status', { distinctSampled: 3, sampleValues: ['open', 'closed', 'void'] }), // → dimension
        col('qty', { sqlType: 'text', inferredType: 'integer', distinctSampled: 30 }), // → retype
      ],
    });
    const p = profile([customers, orders]);
    const a = detect(p);
    const b = detect(p);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    // additive/auto ops sort before restructure/propose ops
    expect(a[0].kind).toBe('add_relationship');
    expect(a.map((o) => o.tier)).toEqual(
      [...a.map((o) => o.tier)].sort((x, y) => (x === 'auto' ? -1 : 1) - (y === 'auto' ? -1 : 1)),
    );
    // every distinct rule fired exactly once on this rich fixture
    expect(new Set(a.map((o) => o.kind))).toEqual(
      new Set([
        'add_relationship',
        'dedup_rows',
        'extract_dimension',
        'retype_column',
        'canonical_rename',
      ]),
    );
  });
});
