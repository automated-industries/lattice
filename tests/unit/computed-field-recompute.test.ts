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

  it('derives computed columns on the upsert + natural-key paths (connector sync / seed)', async () => {
    // Regression: the sync + seed engines write via upsert / upsertByNaturalKey / enrichByNaturalKey,
    // NOT insert()/update(). Those paths must also recompute, or a computed field on a synced table
    // stays NULL.
    db = new Lattice(':memory:');
    db.define('contact', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        email: 'TEXT',
        score: 'INTEGER',
        is_vip: 'INTEGER',
        deleted_at: 'TEXT',
      },
      computedFields: { is_vip: { kind: 'calc', expr: 'score >= 90', type: 'boolean' } },
      render: () => '',
      outputFile: 'c.md',
    });
    await db.init();

    // upsert (the connector sync write path)
    await db.upsert('contact', { id: 'c1', email: 'a@x.com', score: 95 });
    expect((await db.get('contact', 'c1'))?.is_vip).toBe(1);

    // upsertByNaturalKey INSERT branch, then its UPDATE branch (seed / re-sync)
    await db.upsertByNaturalKey('contact', 'email', 'b@x.com', { score: 40 });
    let b = await db.query('contact', { filters: [{ col: 'email', op: 'eq', val: 'b@x.com' }] });
    expect(b[0]?.is_vip).toBe(0);
    await db.upsertByNaturalKey('contact', 'email', 'b@x.com', { score: 99 });
    b = await db.query('contact', { filters: [{ col: 'email', op: 'eq', val: 'b@x.com' }] });
    expect(b[0]?.is_vip).toBe(1); // recomputed on the natural-key update

    // enrichByNaturalKey (sparse enrich)
    await db.enrichByNaturalKey('contact', 'email', 'a@x.com', { score: 10 });
    expect((await db.get('contact', 'c1'))?.is_vip).toBe(0); // re-derived down from VIP
  });
});
