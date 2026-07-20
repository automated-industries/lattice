import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { fullTextSearch } from '../../src/search/fts.js';

/**
 * The non-indexed (LIKE-fallback) search tier is what a GUI-created entity like
 * "people"/"contacts" uses (no full-text index). It used to ORDER BY recency ONLY,
 * so a name lookup was unreliable:
 *   - a free-text MENTION of a person (in some other row's notes) could outrank that
 *     person's own record just for being more recent, and
 *   - a name split across first/last columns never matched the full "First Last".
 * It now relevance-ranks (exact name > prefix > full phrase across the row's text >
 * all words present > any-column contains; recency only breaks ties) and matches the
 * concatenated text, so both cases resolve to the right record.
 */

const dbs: Lattice[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function makeDb(): Promise<Lattice> {
  const db = new Lattice(':memory:');
  dbs.push(db);
  db.define('people', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT',
      notes: 'TEXT',
      created_at: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('contacts', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      first_name: 'TEXT',
      last_name: 'TEXT',
      created_at: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();
  return db;
}

describe('LIKE-fallback name search — relevance over recency', () => {
  it("a person's own record outranks a newer row that merely MENTIONS the name", async () => {
    const db = await makeDb();
    // p1 is the actual person (older). p2 is a different, MORE RECENT person whose
    // notes mention p1 by name. A name search for p1 must return p1 first.
    await db.insert('people', {
      id: 'p1',
      name: 'Zoe Adams',
      notes: '',
      created_at: '2026-01-01T00:00:00Z',
    });
    await db.insert('people', {
      id: 'p2',
      name: 'John Smith',
      notes: 'Great intro chat with Zoe Adams last week.',
      created_at: '2026-06-01T00:00:00Z',
    });
    const r = await fullTextSearch(db.adapter, ['people'], { query: 'Zoe Adams' });
    const ids = r.groups[0]?.hits.map((h) => h.id) ?? [];
    // Both match, but the exact-name record ranks FIRST (old recency-only order put
    // the newer mention, p2, on top).
    expect(ids[0]).toBe('p1');
    expect(ids).toContain('p2');
  });

  it('finds a person whose name is split across first/last columns', async () => {
    const db = await makeDb();
    await db.insert('contacts', {
      id: 'c1',
      first_name: 'Jane',
      last_name: 'Doe',
      created_at: '2026-01-01T00:00:00Z',
    });
    const r = await fullTextSearch(db.adapter, ['contacts'], { query: 'Jane Doe' });
    const ids = r.groups[0]?.hits.map((h) => h.id) ?? [];
    // Old single-column LIKE never matched the full "Jane Doe" (it lives in no one
    // column); the concatenated-text match now finds it.
    expect(ids).toContain('c1');
  });
});
