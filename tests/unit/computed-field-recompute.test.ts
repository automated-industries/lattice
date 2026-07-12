import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * #10 computed COLUMNS — the write-path recompute. A field marked `computed` is a real
 * materialized column derived on write: same-row `alias`/`calc` kinds recompute via a
 * single bounded `UPDATE … WHERE pk` after the row is written, dep-gated on update.
 */
describe('computed columns (#10) — same-row write-path recompute (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('derives a calc + alias column on insert and recomputes only when a dep changes', async () => {
    db = new Lattice(':memory:');
    db.define('line', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        qty: 'INTEGER',
        price: 'REAL',
        label: 'TEXT',
        total: 'REAL',
        headline: 'TEXT',
      },
      computedFields: {
        total: { kind: 'calc', expr: 'qty * price' },
        headline: { kind: 'alias', source: 'label' },
      },
      render: () => '',
      outputFile: 'l.md',
    });
    await db.init();

    // Insert: the user provides only the source columns; the computed columns derive.
    await db.insert('line', { id: 'l1', qty: 3, price: 2, label: 'Widget' });
    let row = (await db.get('line', 'l1'))!;
    expect(row.total).toBe(6); // 3 * 2, derived on insert
    expect(row.headline).toBe('Widget'); // alias of label

    // Updating a dependency recomputes the dependent computed column.
    await db.update('line', 'l1', { qty: 5 });
    row = (await db.get('line', 'l1'))!;
    expect(row.total).toBe(10); // 5 * 2

    // An update that touches only `label` recomputes `headline` (its dep) but leaves
    // `total` intact (dep-gated — qty/price were not touched).
    await db.update('line', 'l1', { label: 'Gadget' });
    row = (await db.get('line', 'l1'))!;
    expect(row.headline).toBe('Gadget');
    expect(row.total).toBe(10);
  });

  it('a computed column is queryable/filterable like any real column (it is one)', async () => {
    db = new Lattice(':memory:');
    db.define('ticket', {
      columns: { id: 'TEXT PRIMARY KEY', priority: 'INTEGER', is_urgent: 'INTEGER' },
      computedFields: { is_urgent: { kind: 'calc', expr: 'priority >= 3', type: 'boolean' } },
      render: () => '',
      outputFile: 't.md',
    });
    await db.init();
    await db.insert('ticket', { id: 't1', priority: 5 });
    await db.insert('ticket', { id: 't2', priority: 1 });

    // The materialized value is filterable in SQL (a view could not do this on the base).
    const urgent = await db.query('ticket', { filters: [{ col: 'is_urgent', op: 'eq', val: 1 }] });
    expect(urgent.map((r) => r.id)).toEqual(['t1']);
  });
});
