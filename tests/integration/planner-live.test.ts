import { describe, expect, it } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  buildModelProfile,
  type IntrospectDb,
  type StructuralInput,
} from '../../src/gui/planner/introspect.js';
import { detect } from '../../src/gui/planner/detect.js';

/**
 * End-to-end against a REAL Lattice (SQLite): the introspect layer's bounded,
 * PK-ordered reads + value canonicalization run through actual SQL, and the pure
 * rules engine detects a foreign key over the live model. This is the proof that
 * the fixture-level unit tests correspond to real database behavior.
 */

function idb(db: Lattice): IntrospectDb {
  return {
    getRegisteredTableNames: () => db.getRegisteredTableNames(),
    getRegisteredColumns: (t) => db.getRegisteredColumns(t),
    getRegisteredFieldTypes: (t) => db.getRegisteredFieldTypes(t),
    getPrimaryKey: (t) => db.getPrimaryKey(t),
    isComputedTable: (n) => db.isComputedTable(n),
    getConnectedSource: (t) => db.getConnectedSource(t),
    connectedTables: () => db.connectedTables(),
    query: (t, o) => db.query(t, o),
    boundedCount: (t, o) => db.boundedCount(t, o),
  };
}

const lattice = (name: string): StructuralInput => ({
  name,
  tier: 'lattice',
  relations: [],
  hasDefinition: false,
  junctionPair: null,
});

describe('planner — live SQLite introspect + detect', () => {
  it('profiles a real DB and detects the FK relationship orders.customer → customers', async () => {
    const db = new Lattice(':memory:');
    db.define('customers', {
      columns: { id: 'TEXT PRIMARY KEY', code: 'TEXT', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define('orders', {
      columns: { id: 'TEXT PRIMARY KEY', customer: 'TEXT', amount: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    for (let i = 1; i <= 10; i++)
      await db.insert('customers', {
        id: `id${String(i)}`,
        code: `c${String(i)}`,
        name: `Cust ${String(i)}`,
      });
    for (let i = 1; i <= 30; i++) {
      await db.insert('orders', {
        id: `o${String(i)}`,
        customer: `c${String((i % 10) + 1)}`,
        amount: String(i * 5),
      });
    }

    const profile = await buildModelProfile(idb(db), [lattice('customers'), lattice('orders')]);

    const orders = profile.tables.find((t) => t.name === 'orders')!;
    const customerCol = orders.columns.find((c) => c.name === 'customer')!;
    expect(customerCol.distinctSampled).toBe(10); // real bounded read + JS distinct
    expect(customerCol.inferredType).toBe('text');
    const customers = profile.tables.find((t) => t.name === 'customers')!;
    expect(customers.naturalKey).toBe('code'); // preferred stable key wins over `name`

    const ops = detect(profile);
    const rel = ops.find((o) => o.kind === 'add_relationship');
    expect(rel).toMatchObject({
      tier: 'auto',
      target: { table: 'orders', column: 'customer', toTable: 'customers' },
    });
    // amount is TEXT holding numbers → the retype signal is detected too (propose).
    expect(ops.some((o) => o.kind === 'retype_column' && o.target.column === 'amount')).toBe(true);
    db.close();
  });

  it('an unrelated table yields no relationship', async () => {
    const db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    for (let i = 1; i <= 12; i++)
      await db.insert('notes', { id: `n${String(i)}`, body: `unique body ${String(i)}` });

    const profile = await buildModelProfile(idb(db), [lattice('notes')]);
    const ops = detect(profile);
    expect(ops.find((o) => o.kind === 'add_relationship')).toBeUndefined();
    db.close();
  });
});
