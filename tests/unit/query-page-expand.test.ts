import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * p3 — Query primitives II: keyset pagination, distinctOn, and relation include
 * (batched, no N+1). SQLite.
 */
describe('p3 query primitives (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  // --- P-PAGE -------------------------------------------------------------
  describe('queryPage (keyset)', () => {
    async function setup(n: number): Promise<Lattice> {
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', seq: 'INTEGER', name: 'TEXT' },
        render: () => '',
        outputFile: 'i.md',
      });
      await db.init();
      for (let i = 0; i < n; i++) {
        await db.insert('items', {
          id: `i${String(i).padStart(3, '0')}`,
          seq: i,
          name: `n${String(i)}`,
        });
      }
      return db;
    }

    it('walks every row across pages with no gaps or repeats', async () => {
      const d = await setup(25);
      const seen: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await d.queryPage('items', { orderBy: 'seq', limit: 10, cursor });
        seen.push(...page.rows.map((r) => Number(r.seq)));
        pages++;
        if (!page.nextCursor) {
          expect(page.hasMore).toBe(false);
          break;
        }
        cursor = page.nextCursor;
        if (pages > 10) throw new Error('pagination did not terminate');
      }
      expect(pages).toBe(3); // 10 + 10 + 5
      expect(seen).toEqual([...Array(25).keys()]);
    });

    it('supports descending order', async () => {
      const d = await setup(5);
      const page = await d.queryPage('items', { orderBy: 'seq', orderDir: 'desc', limit: 3 });
      expect(page.rows.map((r) => Number(r.seq))).toEqual([4, 3, 2]);
      const page2 = await d.queryPage('items', {
        orderBy: 'seq',
        orderDir: 'desc',
        limit: 3,
        cursor: page.nextCursor!,
      });
      expect(page2.rows.map((r) => Number(r.seq))).toEqual([1, 0]);
    });

    it('defaults orderBy to the primary key and applies filters', async () => {
      const d = await setup(10);
      const page = await d.queryPage('items', {
        filters: [{ col: 'seq', op: 'gte', val: 5 }],
        limit: 3,
      });
      expect(page.rows).toHaveLength(3);
      expect(Number(page.rows[0]!.seq)).toBe(5);
    });

    it('throws on a malformed cursor', async () => {
      const d = await setup(3);
      await expect(d.queryPage('items', { cursor: 'not-base64-json!!' })).rejects.toThrow(/cursor/);
    });

    it('paginates a COMPOSITE-PK table with no gaps or repeats', async () => {
      db = new Lattice(':memory:');
      db.define('events', {
        columns: { tenant: 'TEXT', seq: 'INTEGER', score: 'INTEGER', name: 'TEXT' },
        primaryKey: ['tenant', 'seq'],
        render: () => '',
        outputFile: 'e.md',
      });
      await db.init();
      // Many rows share the SAME orderBy value (score) but differ in the composite
      // PK — exactly what a single-column tie-break would skip or duplicate.
      const rows: { tenant: string; seq: number; score: number; name: string }[] = [];
      let k = 0;
      for (const tenant of ['a', 'b', 'c']) {
        for (let seq = 0; seq < 5; seq++) {
          rows.push({ tenant, seq, score: k % 3, name: `r${String(k)}` });
          k++;
        }
      }
      for (const r of rows) await db.insert('events', r);

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await db.queryPage('events', { orderBy: 'score', limit: 4, cursor });
        for (const row of page.rows) {
          const key = `${String(row.tenant)}/${String(row.seq)}`;
          expect(seen.has(key)).toBe(false); // no duplicate across pages
          seen.add(key);
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(rows.length); // every row returned exactly once — no gaps
    });
  });

  // --- P-DEDUP ------------------------------------------------------------
  describe('distinctOn', () => {
    async function setup(): Promise<Lattice> {
      db = new Lattice(':memory:');
      db.define('events', {
        columns: { id: 'TEXT PRIMARY KEY', user_id: 'TEXT', ts: 'INTEGER', kind: 'TEXT' },
        render: () => '',
        outputFile: 'e.md',
      });
      await db.init();
      await db.insert('events', { id: 'e1', user_id: 'u1', ts: 10, kind: 'a' });
      await db.insert('events', { id: 'e2', user_id: 'u1', ts: 30, kind: 'b' });
      await db.insert('events', { id: 'e3', user_id: 'u2', ts: 20, kind: 'c' });
      return db;
    }

    it('returns one row per distinct value, picking by orderBy', async () => {
      const d = await setup();
      // latest event per user (orderBy ts desc → highest ts survives)
      const rows = await d.query('events', {
        distinctOn: 'user_id',
        orderBy: 'ts',
        orderDir: 'desc',
      });
      const byUser = new Map(rows.map((r) => [r.user_id, r]));
      expect(byUser.size).toBe(2);
      expect(byUser.get('u1')!.id).toBe('e2'); // ts 30 wins
      expect(byUser.get('u2')!.id).toBe('e3');
    });

    it('honors a projection alongside distinctOn', async () => {
      const d = await setup();
      const rows = await d.query('events', {
        distinctOn: 'user_id',
        orderBy: 'ts',
        orderDir: 'desc',
        projection: ['user_id', 'kind'],
      });
      expect(Object.keys(rows[0]!).sort()).toEqual(['kind', 'user_id']);
    });
  });

  // --- P-EXPAND -----------------------------------------------------------
  describe('include (relation expansion)', () => {
    async function setup(): Promise<Lattice> {
      db = new Lattice(':memory:');
      db.define('authors', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        relations: { posts: { type: 'hasMany', table: 'posts', foreignKey: 'author_id' } },
        render: () => '',
        outputFile: 'a.md',
      });
      db.define('posts', {
        columns: { id: 'TEXT PRIMARY KEY', author_id: 'TEXT', title: 'TEXT' },
        relations: { author: { type: 'belongsTo', table: 'authors', foreignKey: 'author_id' } },
        render: () => '',
        outputFile: 'p.md',
      });
      await db.init();
      await db.insert('authors', { id: 'a1', name: 'Ada' });
      await db.insert('authors', { id: 'a2', name: 'Bo' });
      await db.insert('posts', { id: 'p1', author_id: 'a1', title: 'First' });
      await db.insert('posts', { id: 'p2', author_id: 'a1', title: 'Second' });
      await db.insert('posts', { id: 'p3', author_id: 'a2', title: 'Third' });
      return db;
    }

    it('expands a belongsTo relation to a single row', async () => {
      const d = await setup();
      const posts = await d.query('posts', { include: ['author'], orderBy: 'id' });
      expect((posts[0]!.author as { name: string }).name).toBe('Ada');
      expect((posts[2]!.author as { name: string }).name).toBe('Bo');
    });

    it('expands a hasMany relation to an array', async () => {
      const d = await setup();
      const authors = await d.query('authors', { include: ['posts'], orderBy: 'id' });
      expect((authors[0]!.posts as unknown[]).length).toBe(2); // Ada → 2 posts
      expect((authors[1]!.posts as unknown[]).length).toBe(1); // Bo → 1 post
    });

    it('throws for an undeclared relation', async () => {
      const d = await setup();
      await expect(d.query('posts', { include: ['nope'] })).rejects.toThrow(
        /not a declared relation/,
      );
    });
  });
});
