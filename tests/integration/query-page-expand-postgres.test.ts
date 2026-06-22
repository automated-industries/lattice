/**
 * Postgres dialect-parity for p3: keyset pagination, distinctOn (the Postgres
 * `DISTINCT ON` path vs SQLite's window emulation), and batched relation include.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('p3 query primitives (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const events = `__lattice_test_${runId}_events`;
  const authors = `__lattice_test_${runId}_authors`;
  const posts = `__lattice_test_${runId}_posts`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(events, {
      columns: { id: 'TEXT PRIMARY KEY', user_id: 'TEXT', ts: 'INTEGER', kind: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(authors, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      relations: { posts: { type: 'hasMany', table: posts, foreignKey: 'author_id' } },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(posts, {
      columns: { id: 'TEXT PRIMARY KEY', author_id: 'TEXT', title: 'TEXT' },
      relations: { author: { type: 'belongsTo', table: authors, foreignKey: 'author_id' } },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    for (let i = 0; i < 12; i++)
      await db.insert(events, {
        id: `e${String(i)}`,
        user_id: `u${String(i % 3)}`,
        ts: i,
        kind: 'k',
      });
    await db.insert(authors, { id: 'a1', name: 'Ada' });
    await db.insert(authors, { id: 'a2', name: 'Bo' });
    await db.insert(posts, { id: 'p1', author_id: 'a1', title: 'First' });
    await db.insert(posts, { id: 'p2', author_id: 'a1', title: 'Second' });
    await db.insert(posts, { id: 'p3', author_id: 'a2', title: 'Third' });
  });

  afterAll(async () => {
    for (const t of [events, authors, posts]) {
      try {
        await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t}" CASCADE`);
      } catch {
        /* best effort */
      }
    }
    db.close();
  });

  it('keyset pagination walks all rows on Postgres', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await db.queryPage(events, { orderBy: 'ts', limit: 5, cursor });
      seen.push(...page.rows.map((r) => Number(r.ts)));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...Array(12).keys()]);
  });

  it('distinctOn via DISTINCT ON returns one row per group (latest per user)', async () => {
    const rows = await db.query(events, { distinctOn: 'user_id', orderBy: 'ts', orderDir: 'desc' });
    const byUser = new Map(rows.map((r) => [r.user_id, Number(r.ts)]));
    expect(byUser.size).toBe(3);
    // u0 has ts 0,3,6,9 → latest 9; u1 → 10; u2 → 11
    expect(byUser.get('u0')).toBe(9);
    expect(byUser.get('u1')).toBe(10);
    expect(byUser.get('u2')).toBe(11);
  });

  it('include batches relations on Postgres', async () => {
    const withAuthor = await db.query(posts, { include: ['author'], orderBy: 'id' });
    expect((withAuthor[0]!.author as { name: string }).name).toBe('Ada');
    const withPosts = await db.query(authors, { include: ['posts'], orderBy: 'id' });
    expect((withPosts[0]!.posts as unknown[]).length).toBe(2);
  });
});
