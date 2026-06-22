import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { computedColumnOrder, ComputedColumnCycleError } from '../../src/schema/computed.js';

/**
 * p8 — declarative computed columns + materialized rollups.
 */
describe('computed columns (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('computes a derived column on insert and recomputes on update', async () => {
    db = new Lattice(':memory:');
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', first: 'TEXT', last: 'TEXT', full_name: 'TEXT' },
      computed: {
        full_name: {
          deps: ['first', 'last'],
          compute: (r) => `${String(r.first)} ${String(r.last)}`,
        },
      },
      render: () => '',
      outputFile: 'p.md',
    });
    await db.init();
    await db.insert('people', { id: 'p1', first: 'Ada', last: 'Lovelace' });
    expect((await db.get('people', 'p1'))!.full_name).toBe('Ada Lovelace');

    await db.update('people', 'p1', { last: 'Byron' });
    expect((await db.get('people', 'p1'))!.full_name).toBe('Ada Byron');

    // an update that doesn't touch a dep leaves the computed value intact
    await db.update('people', 'p1', { id: 'p1' });
    expect((await db.get('people', 'p1'))!.full_name).toBe('Ada Byron');
  });

  it('chains computed columns in dependency order', async () => {
    db = new Lattice(':memory:');
    db.define('nums', {
      columns: { id: 'TEXT PRIMARY KEY', x: 'INTEGER', doubled: 'INTEGER', quad: 'INTEGER' },
      computed: {
        // quad depends on doubled which depends on x — must compute doubled first.
        quad: { deps: ['doubled'], compute: (r) => Number(r.doubled) * 2, type: 'INTEGER' },
        doubled: { deps: ['x'], compute: (r) => Number(r.x) * 2, type: 'INTEGER' },
      },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();
    await db.insert('nums', { id: 'n1', x: 3 });
    const row = await db.get('nums', 'n1');
    expect(row!.doubled).toBe(6);
    expect(row!.quad).toBe(12);
  });

  it('rejects a dependency cycle at init', () => {
    db = new Lattice(':memory:');
    expect(() =>
      db!.define('bad', {
        columns: { id: 'TEXT PRIMARY KEY', a: 'TEXT', b: 'TEXT' },
        computed: {
          a: { deps: ['b'], compute: (r) => String(r.b) },
          b: { deps: ['a'], compute: (r) => String(r.a) },
        },
        render: () => '',
        outputFile: 'b.md',
      }),
    ).toThrow(ComputedColumnCycleError);
  });

  it('refreshComputedColumns recomputes all rows', async () => {
    db = new Lattice(':memory:');
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', first: 'TEXT', last: 'TEXT', full_name: 'TEXT' },
      computed: {
        full_name: {
          deps: ['first', 'last'],
          compute: (r) => `${String(r.first)} ${String(r.last)}`,
        },
      },
      render: () => '',
      outputFile: 'p.md',
    });
    await db.init();
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    // Insert directly, bypassing the compute path.
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO people (id, first, last) VALUES ('p1','Ada','L')`,
    );
    expect((await db.get('people', 'p1'))!.full_name).toBeNull();
    const n = await db.refreshComputedColumns('people');
    expect(n).toBe(1);
    expect((await db.get('people', 'p1'))!.full_name).toBe('Ada L');
  });

  it('computedColumnOrder reports the cycle', () => {
    expect(() =>
      computedColumnOrder('t', {
        a: { deps: ['b'], compute: () => 0 },
        b: { deps: ['a'], compute: () => 0 },
      }),
    ).toThrow(/cycle/);
  });
});

describe('materialized rollups (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('posts', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', comment_count: 'INTEGER DEFAULT 0' },
      materializedRollups: {
        comment_count: { sourceTable: 'comments', foreignKey: 'post_id', fn: 'count' },
      },
      render: () => '',
      outputFile: 'p.md',
    });
    db.define('comments', {
      columns: { id: 'TEXT PRIMARY KEY', post_id: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'c.md',
    });
    await db.init();
    return db;
  }

  it('increments the parent rollup when a child is inserted', async () => {
    const d = await setup();
    await d.insert('posts', { id: 'p1', title: 'Hello' });
    expect(Number((await d.get('posts', 'p1'))!.comment_count)).toBe(0);
    await d.insert('comments', { id: 'c1', post_id: 'p1', body: 'nice' });
    await d.insert('comments', { id: 'c2', post_id: 'p1', body: 'good' });
    expect(Number((await d.get('posts', 'p1'))!.comment_count)).toBe(2);
  });

  it('decrements the parent rollup when a child is deleted', async () => {
    const d = await setup();
    await d.insert('posts', { id: 'p1', title: 'Hello' });
    await d.insert('comments', { id: 'c1', post_id: 'p1', body: 'nice' });
    await d.insert('comments', { id: 'c2', post_id: 'p1', body: 'good' });
    await d.delete('comments', 'c1');
    expect(Number((await d.get('posts', 'p1'))!.comment_count)).toBe(1);
  });

  it('refreshMaterializedRollups recomputes from scratch', async () => {
    const d = await setup();
    await d.insert('posts', { id: 'p1', title: 'Hello' });
    const { runAsyncOrSync } = await import('../../src/db/adapter.js');
    // Insert children directly (bypass incremental propagation).
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO comments (id, post_id, body) VALUES ('c1','p1','a')`,
    );
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO comments (id, post_id, body) VALUES ('c2','p1','b')`,
    );
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO comments (id, post_id, body) VALUES ('c3','p1','c')`,
    );
    expect(Number((await d.get('posts', 'p1'))!.comment_count)).toBe(0); // stale
    const n = await d.refreshMaterializedRollups('posts');
    expect(n).toBe(1);
    expect(Number((await d.get('posts', 'p1'))!.comment_count)).toBe(3);
  });
});
