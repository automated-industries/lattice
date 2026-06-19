/**
 * Postgres dialect-parity for p8: computed columns (insert + update recompute)
 * and materialized rollups (incremental + refresh) on a real Postgres cluster.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('p8 computed + rollups (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const people = `__lattice_test_${runId}_people`;
  const posts = `__lattice_test_${runId}_posts`;
  const comments = `__lattice_test_${runId}_comments`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(people, {
      columns: { id: 'TEXT PRIMARY KEY', first: 'TEXT', last: 'TEXT', full_name: 'TEXT' },
      computed: {
        full_name: {
          deps: ['first', 'last'],
          compute: (r) => `${String(r.first)} ${String(r.last)}`,
        },
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(posts, {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', comment_count: 'INTEGER DEFAULT 0' },
      materializedRollups: {
        comment_count: { sourceTable: comments, foreignKey: 'post_id', fn: 'count' },
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(comments, {
      columns: { id: 'TEXT PRIMARY KEY', post_id: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    for (const t of [people, posts, comments]) {
      try {
        await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t}" CASCADE`);
      } catch {
        /* best effort */
      }
    }
    db.close();
  });

  it('computes + recomputes a derived column on Postgres', async () => {
    await db.insert(people, { id: 'p1', first: 'Ada', last: 'Lovelace' });
    expect((await db.get(people, 'p1'))!.full_name).toBe('Ada Lovelace');
    await db.update(people, 'p1', { last: 'Byron' });
    expect((await db.get(people, 'p1'))!.full_name).toBe('Ada Byron');
  });

  it('maintains a rollup incrementally + via refresh on Postgres', async () => {
    await db.insert(posts, { id: 'post1', title: 'Hi' });
    await db.insert(comments, { id: 'c1', post_id: 'post1', body: 'a' });
    await db.insert(comments, { id: 'c2', post_id: 'post1', body: 'b' });
    expect(Number((await db.get(posts, 'post1'))!.comment_count)).toBe(2);
    await db.delete(comments, 'c1');
    expect(Number((await db.get(posts, 'post1'))!.comment_count)).toBe(1);

    // direct insert bypassing propagation, then refresh
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "${comments}" (id, post_id, body) VALUES ('c3','post1','c')`,
    );
    await db.refreshMaterializedRollups(posts);
    expect(Number((await db.get(posts, 'post1'))!.comment_count)).toBe(2);
  });
});
