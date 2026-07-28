import { describe, expect, it } from 'vitest';
import { classifyRole, classifyRoles, type RoleTable } from '../../src/import/roles.js';
import { detectShape } from '../../src/gui/planner/detect.js';
import type {
  ColumnStat,
  ModelProfile,
  TableProfile,
  ShapeOp,
} from '../../src/gui/planner/types.js';
import type { TableRole } from '../../src/import/roles.js';

/**
 * The table-role ladder: a deterministic, SHAPE-driven classification of what
 * each table IS (fact / dimension / link / document / reference), plus the two
 * plan ops built on it (assign a role unattended; offer to rename a table whose
 * name says nothing).
 *
 * The load-bearing property is that the ladder never reads a table's NAME: the
 * same shapes under different names must classify identically, because a name
 * is exactly the signal that is unreliable on imported data.
 */

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
function longVals(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${String(i)} `.padEnd(240, 'the quick brown fox '));
}
function belongsTo(name: string, targetTable: string, foreignKey: string) {
  return { name, kind: 'belongsTo' as const, targetTable, foreignKey };
}

/** A four-table star: a fact, two dimensions it references, a link table, a
 *  free-text document table and a standalone lookup. Shapes only — the names
 *  are deliberately meaningless in the renamed variant below. */
function starModel(n: (k: string) => string): TableProfile[] {
  const customers = table(n('customers'), {
    rowCount: 40,
    sampledRowCount: 40,
    naturalKey: 'code',
    columns: [
      col('id', { isPrimaryKey: true }),
      col('code', { distinctSampled: 40, sampleValues: vals(40) }),
      col('label', { distinctSampled: 38, sampleValues: vals(38, 'l') }),
    ],
  });
  const products = table(n('products'), {
    rowCount: 25,
    sampledRowCount: 25,
    naturalKey: 'sku',
    columns: [
      col('id', { isPrimaryKey: true }),
      col('sku', { distinctSampled: 25, sampleValues: vals(25, 's') }),
    ],
  });
  const orders = table(n('orders'), {
    rowCount: 900,
    sampledRowCount: 200,
    naturalKey: null,
    columns: [
      col('id', { isPrimaryKey: true }),
      col('customer_id', { isForeignKey: true }),
      col('product_id', { isForeignKey: true }),
      col('quantity', { inferredType: 'integer', distinctSampled: 30 }),
      col('total', { inferredType: 'real', distinctSampled: 180 }),
      col('placed_at', { inferredType: 'datetime', distinctSampled: 190 }),
    ],
    relations: [
      belongsTo('customer', n('customers'), 'customer_id'),
      belongsTo('product', n('products'), 'product_id'),
    ],
  });
  const orderTags = table(n('order_tags'), {
    rowCount: 300,
    sampledRowCount: 200,
    columns: [
      col('id', { isPrimaryKey: true }),
      col('order_id', { isForeignKey: true }),
      col('tag_id', { isForeignKey: true }),
    ],
    relations: [belongsTo('order', n('orders'), 'order_id'), belongsTo('tag', n('tags'), 'tag_id')],
  });
  const tags = table(n('tags'), {
    rowCount: 12,
    sampledRowCount: 12,
    naturalKey: 'slug',
    columns: [
      col('id', { isPrimaryKey: true }),
      col('slug', { distinctSampled: 12, sampleValues: vals(12, 't') }),
    ],
  });
  const articles = table(n('articles'), {
    rowCount: 60,
    sampledRowCount: 60,
    naturalKey: null,
    columns: [
      col('id', { isPrimaryKey: true }),
      col('headline', { distinctSampled: 60, sampleValues: vals(60, 'h') }),
      col('body', { distinctSampled: 60, sampleValues: longVals(20) }),
      col('summary', { distinctSampled: 60, sampleValues: longVals(20) }),
    ],
  });
  const currencies = table(n('currencies'), {
    rowCount: 6,
    sampledRowCount: 6,
    naturalKey: 'code',
    columns: [
      col('id', { isPrimaryKey: true }),
      col('code', { distinctSampled: 6, sampleValues: vals(6, 'x') }),
    ],
  });
  return [customers, products, orders, orderTags, tags, articles, currencies];
}

function rolesOf(tables: TableProfile[]): Record<string, TableRole> {
  const out: Record<string, TableRole> = {};
  for (const [name, v] of classifyRoles(tables)) out[name] = v.role;
  return out;
}

describe('table roles — the deterministic classification ladder', () => {
  it('classifies a star model by SHAPE (fact / dimension / link / document / reference)', () => {
    expect(rolesOf(starModel((k) => k))).toEqual({
      customers: 'dimension',
      products: 'dimension',
      orders: 'fact',
      order_tags: 'link',
      tags: 'dimension',
      articles: 'document',
      currencies: 'reference',
    });
  });

  it('is name-blind: renaming every table yields the SAME roles', () => {
    const alias: Record<string, string> = {
      customers: 't1',
      products: 't2',
      orders: 't3',
      order_tags: 't4',
      tags: 't5',
      articles: 't6',
      currencies: 't7',
    };
    const renamed = rolesOf(starModel((k) => alias[k] ?? k));
    const original = rolesOf(starModel((k) => k));
    for (const [name, role] of Object.entries(original)) {
      expect(renamed[alias[name] ?? name]).toBe(role);
    }
  });

  it('is deterministic: repeated runs and a shuffled table order agree', () => {
    const a = rolesOf(starModel((k) => k));
    const b = rolesOf(starModel((k) => k));
    const shuffled = rolesOf([...starModel((k) => k)].reverse());
    expect(b).toEqual(a);
    expect(shuffled).toEqual(a);
  });

  it('reports the grain and the provenance of each verdict', () => {
    const verdicts = classifyRoles(starModel((k) => k));
    expect(verdicts.get('customers')?.grain).toBe('one row per code');
    expect(verdicts.get('order_tags')?.grain).toBe('one row per orders + tags');
    expect(verdicts.get('orders')?.grain).toBe('one row per record');
    expect(verdicts.get('orders')?.rule).toBe('L3-fact');
    expect(verdicts.get('order_tags')?.unambiguous).toBe(true);
  });

  it('marks a shapeless table ambiguous rather than guessing confidently', () => {
    const blob = table('blob', {
      rowCount: 5000,
      sampledRowCount: 200,
      columns: [col('id', { isPrimaryKey: true }), col('value', { distinctSampled: 200 })],
    });
    const v = classifyRole(blob as RoleTable, { referencedRowCounts: [], referrerRowCounts: [] });
    expect(v.unambiguous).toBe(false);
    expect(v.rule).toBe('L6-fallback');
  });

  it('a two-key table with a payload column is a fact, not a link', () => {
    const lines = table('lines', {
      rowCount: 400,
      sampledRowCount: 200,
      columns: [
        col('id', { isPrimaryKey: true }),
        col('order_id', { isForeignKey: true }),
        col('product_id', { isForeignKey: true }),
        col('qty', { inferredType: 'integer', distinctSampled: 20 }),
      ],
      relations: [
        belongsTo('order', 'orders', 'order_id'),
        belongsTo('product', 'p', 'product_id'),
      ],
    });
    const v = classifyRole(lines as RoleTable, {
      referencedRowCounts: [50, 20],
      referrerRowCounts: [],
    });
    expect(v.role).toBe('fact');
    expect(v.unambiguous).toBe(true);
  });
});

describe('planner shape ops — assign_role (AUTO) + rename_generic_table (PROPOSE)', () => {
  const model = (): ModelProfile => profile(starModel((k) => k));

  it('assigns an unambiguous role unattended, and never re-proposes a stored one', () => {
    const none = new Map<string, TableRole | null>();
    const first = detectShape(model(), none).filter((o) => o.kind === 'assign_role');
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((o: ShapeOp) => o.tier === 'auto')).toBe(true);
    const orders = first.find((o) => o.target.table === 'orders');
    expect(orders?.evidence.role).toBe('fact');

    // Everything the first pass would assign is now stored → nothing left to do.
    const stored = new Map<string, TableRole | null>(
      first.map((o) => [o.target.table, o.evidence.role as TableRole]),
    );
    const second = detectShape(model(), stored).filter((o) => o.kind === 'assign_role');
    expect(second).toEqual([]);
  });

  it('offers to rename a placeholder-named table, using its key column', () => {
    const sheet = table('Sheet1', {
      rowCount: 30,
      sampledRowCount: 30,
      naturalKey: 'invoice_no',
      columns: [
        col('id', { isPrimaryKey: true }),
        col('invoice_no', { distinctSampled: 30, sampleValues: vals(30, 'i') }),
        col('amount', { inferredType: 'real', distinctSampled: 29 }),
      ],
    });
    const ops = detectShape(profile([sheet]), new Map()).filter(
      (o) => o.kind === 'rename_generic_table',
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      tier: 'propose',
      class: 'restructure',
      target: { table: 'Sheet1', toTable: 'invoice' },
    });
  });

  it('never proposes a rename for a table that already has a meaningful name', () => {
    const ops = detectShape(model(), new Map()).filter((o) => o.kind === 'rename_generic_table');
    expect(ops).toEqual([]);
  });

  it('withholds a rename when no non-placeholder name can be derived', () => {
    const sheet = table('table_1', {
      rowCount: 30,
      sampledRowCount: 30,
      naturalKey: null,
      columns: [col('id', { isPrimaryKey: true }), col('value', { distinctSampled: 30 })],
    });
    expect(detectShape(profile([sheet]), new Map())).toEqual([]);
  });
});
