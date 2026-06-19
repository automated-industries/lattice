/**
 * Regression test for the batched-introspection boot path.
 *
 * `Lattice.init()` against a Postgres cloud used to issue one
 * `information_schema` round-trip per declared table (a CREATE check plus a
 * per-table column introspect, plus a post-migration per-table introspect
 * loop). On a high-RTT cloud that is hundreds of serial round-trips. The boot
 * path now does ONE whole-schema introspection up front, feeds it to
 * `applySchema` so a converged DB issues no per-table DDL, and reuses that map
 * for the column cache when nothing changed.
 *
 * What this pins:
 *   (a) a converged reopen (init against a schema that already has every table)
 *       still works and seeds the column cache;
 *   (b) create-only-missing still CONVERGES a genuinely-missing column — drop a
 *       column out-of-band, reopen, and the column is re-added (proves the
 *       optimization didn't turn "skip CREATE when the table exists" into
 *       "skip the missing-column diff");
 *   (c) `introspectAllColumns` returns the expected table -> columns map.
 *
 * Isolation: each test creates and drops its OWN throwaway Postgres schema and
 * routes the connection's `search_path` at it (so `current_schema()` resolves
 * there). Nothing touches the public schema or any shared/real cloud.
 *
 * Postgres-gated (real pg.Pool). How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { introspectAllColumnsAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const schemas: string[] = [];
const opened: Lattice[] = [];

/** A connection string whose search_path points at `schema`, so the adapter's
 *  `current_schema()`-scoped introspection + DDL all land in our throwaway. */
function schemaUrl(schema: string): string {
  const u = new URL(PG_URL!);
  // libpq `options=-c search_path=<schema>` is honored by node-postgres.
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

/** Define ~5 small entities on a fresh Lattice. */
function defineEntities(db: Lattice): void {
  db.define('authors', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'authors.md',
  });
  db.define('books', {
    columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'books.md',
  });
  db.define('tags', {
    columns: { id: 'TEXT PRIMARY KEY', slug: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'tags.md',
  });
  db.define('reviews', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', stars: 'INTEGER', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'reviews.md',
  });
  db.define('shelves', {
    columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'shelves.md',
  });
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) {
    await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('init batched introspection (regression)', () => {
  /** Create a throwaway schema and return a connection string scoped to it. */
  async function freshSchema(): Promise<{ schema: string; url: string }> {
    const schema = `lattice_bi_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    return { schema, url: schemaUrl(schema) };
  }

  it('(a) converged reopen: second init on an existing schema works + caches columns', async () => {
    const { url } = await freshSchema();

    const first = new Lattice(url);
    opened.push(first);
    defineEntities(first);
    await first.init();
    const id = await first.insert('books', { title: 'A' });
    expect(typeof id).toBe('string');
    first.close();
    opened.splice(opened.indexOf(first), 1);

    // Reopen on the SAME schema — every table already exists, so applySchema
    // mutates nothing and the column cache is seeded from the up-front map.
    const second = new Lattice(url);
    opened.push(second);
    defineEntities(second);
    await second.init();

    // Init converged and the row is still readable through the cached columns.
    const got = await second.get('books', id);
    expect(got?.title).toBe('A');
    // A write that exercises the (cached) column set still round-trips.
    const id2 = await second.insert('reviews', { body: 'good', stars: 4 });
    const r = await second.get('reviews', id2);
    expect(Number(r?.stars)).toBe(4);
  });

  it('(b) create-only-missing still converges a dropped column on reopen', async () => {
    const { schema, url } = await freshSchema();

    const first = new Lattice(url);
    opened.push(first);
    defineEntities(first);
    await first.init();
    first.close();
    opened.splice(opened.indexOf(first), 1);

    // Drop a declared column out-of-band — the table still exists, so the
    // boot path will SKIP its CREATE; the missing-column diff must still see
    // the gap and ALTER it back.
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`ALTER TABLE "${schema}"."reviews" DROP COLUMN "stars"`);
    const beforeCols = await admin.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'reviews'`,
      [schema],
    );
    expect(beforeCols.rows.map((r) => (r as { column_name: string }).column_name)).not.toContain(
      'stars',
    );
    await admin.end();

    const second = new Lattice(url);
    opened.push(second);
    defineEntities(second);
    await second.init();

    // The column was re-added by the boot path, and writes against it persist.
    const id = await second.insert('reviews', { body: 'reconverged', stars: 7 });
    const r = await second.get('reviews', id);
    expect(Number(r?.stars)).toBe(7);

    const admin2 = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    const afterCols = await admin2.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'reviews'`,
      [schema],
    );
    expect(afterCols.rows.map((r) => (r as { column_name: string }).column_name)).toContain(
      'stars',
    );
    await admin2.end();
  });

  it('(c) introspectAllColumns returns the expected table -> columns map', async () => {
    const { url } = await freshSchema();

    const db = new Lattice(url);
    opened.push(db);
    defineEntities(db);
    await db.init();

    const map = await introspectAllColumnsAsyncOrSync(db.adapter, [
      'authors',
      'books',
      'tags',
      'reviews',
      'shelves',
    ]);

    // Every declared table is present with its declared columns.
    expect(new Set(map.get('authors'))).toEqual(new Set(['id', 'name', 'deleted_at']));
    expect(new Set(map.get('books'))).toEqual(new Set(['id', 'title', 'deleted_at']));
    expect(new Set(map.get('tags'))).toEqual(new Set(['id', 'slug', 'deleted_at']));
    expect(new Set(map.get('reviews'))).toEqual(new Set(['id', 'body', 'stars', 'deleted_at']));
    expect(new Set(map.get('shelves'))).toEqual(new Set(['id', 'label', 'deleted_at']));
    // The internal migrations table is part of the schema too.
    expect(map.has('__lattice_migrations')).toBe(true);
  });
});
