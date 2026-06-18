import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice, SeedReconciliationError } from '../../src/lattice.js';
import { fullTextSearch } from '../../src/search/fts.js';
import type { StorageAdapter } from '../../src/db/adapter.js';

/**
 * Regression coverage for the soft-delete predicate simplification: a row is
 * "live" only when `deleted_at IS NULL`. Prior code also treated the empty
 * string (`''`) as live, via an `OR deleted_at = ''` branch carried in four
 * read paths (the natural-key family, the seed resolver, and both FTS paths).
 *
 * No library write path produces `''` — insert/restore write NULL, delete
 * writes a timestamp — so the empty-string state is reachable only by raw SQL
 * (legacy / externally inserted data). The empty-string branch therefore had
 * ZERO existing coverage. This file is the gate for the change: it injects
 * `deleted_at = ''` via the RAW adapter and proves the new behavior.
 *
 *  - CASE 1 proves the BREAK: an empty-string row reads as DELETED everywhere,
 *    and an upsert against its natural key INSERTs a duplicate. RED against the
 *    old predicate, GREEN after.
 *  - CASE 2 proves the documented normalization (`SET deleted_at = NULL WHERE
 *    deleted_at = ''`) restores the row to live across every path.
 *  - CASE 3 guards the NULL (live) and timestamp (deleted) cases — no
 *    behavior change expected.
 */
describe('deleted_at normalization — empty-string is no longer live', () => {
  let db: Lattice;
  let adapter: StorageAdapter;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    // FTS-indexed natural-key table → exercises the INDEXED FTS path
    // (indexedSearchTable / the NOT_DELETED const in fts.ts) plus the
    // natural-key lookup family (getByNaturalKey / upsertByNaturalKey).
    db.define('doc', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        title: 'TEXT',
        created_at: "TEXT DEFAULT (datetime('now'))",
        updated_at: "TEXT DEFAULT (datetime('now'))",
        deleted_at: 'TEXT',
      },
      fts: { fields: ['title'] },
      render: () => '',
      outputFile: '/dev/null',
    });
    // NON-FTS table → exercises the LIKE-fallback FTS path (likeSearchTable,
    // the INLINED predicate at fts.ts:265 that is routed through no const).
    db.define('plain', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        title: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    // Seed resolve fixture: a junction-linked pair so seed()'s batched
    // IN(...) resolve (seed-engine.ts NOT_DELETED) is exercised.
    db.define('person', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        name: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define('meeting', {
      columns: { id: 'TEXT PRIMARY KEY', slug: 'TEXT NOT NULL', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define('meeting_person', {
      columns: { meeting_id: 'TEXT NOT NULL', person_id: 'TEXT NOT NULL' },
      primaryKey: ['meeting_id', 'person_id'],
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    adapter = (db as unknown as { _adapter: StorageAdapter })._adapter;
  });

  afterEach(() => {
    db.close();
  });

  /** Resolve a meeting whose attendee links target `person` rows by slug. */
  function seedMeeting(attendees: string[], onUnresolvedLink?: 'collect' | 'throw') {
    return db.seed({
      table: 'meeting',
      naturalKey: 'slug',
      data: [{ slug: 'standup', attendees }],
      linkTo: {
        attendees: {
          junction: 'meeting_person',
          foreignKey: 'person_id',
          resolveBy: 'slug',
          resolveTable: 'person',
        },
      },
      ...(onUnresolvedLink ? { onUnresolvedLink } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // CASE 1 — proves the BREAK. RED on the old predicate, GREEN after the edits.
  // -------------------------------------------------------------------------
  describe('CASE 1 — an empty-string deleted_at reads as DELETED', () => {
    it('natural-key lookup omits the empty-string row, and upsert INSERTs a duplicate', async () => {
      await db.insert('doc', { id: 'd1', slug: 'alpha', title: 'budget review' });
      // RAW set deleted_at='' — no library write path produces this value.
      adapter.run("UPDATE doc SET deleted_at = '' WHERE id = 'd1'");

      // (b) getByNaturalKey treats '' as deleted → returns null.
      expect(await db.getByNaturalKey('doc', 'slug', 'alpha')).toBeNull();

      // (c) upsert can't see the hidden row → falls through to INSERT, leaving
      // TWO rows for the same natural key (the duplicate-insert hazard).
      await db.upsertByNaturalKey('doc', 'slug', 'alpha', { title: 'new budget' });
      const dupes = adapter.all("SELECT id FROM doc WHERE slug = 'alpha'");
      expect(dupes).toHaveLength(2);
    });

    it('both FTS paths (indexed + LIKE) omit the empty-string row', async () => {
      // Indexed path: `doc` has an FTS index.
      await db.insert('doc', { id: 'd1', slug: 'alpha', title: 'budget indexed' });
      // LIKE path: `plain` has no FTS index.
      await db.insert('plain', { id: 'p1', slug: 'beta', title: 'budget likepath' });
      adapter.run("UPDATE doc SET deleted_at = '' WHERE id = 'd1'");
      adapter.run("UPDATE plain SET deleted_at = '' WHERE id = 'p1'");

      const r = await fullTextSearch(adapter, ['doc', 'plain'], { query: 'budget' });
      // Both rows are hidden → no groups at all.
      expect(r.groups).toEqual([]);
    });

    it('the seed resolver does not resolve a link to an empty-string row', async () => {
      // Insert the person normally, then raw-hide it with deleted_at=''.
      await db.insert('person', { id: 'per1', slug: 'alice', name: 'Alice' });
      adapter.run("UPDATE person SET deleted_at = '' WHERE id = 'per1'");

      // collect mode: the link to alice is now unresolved.
      const result = await seedMeeting(['alice']);
      expect(result.linked).toBe(0);
      expect(result.unresolvedLinks.map((u) => u.name)).toEqual(['alice']);

      // throw mode: the same hidden target makes seed() raise.
      await expect(seedMeeting(['alice'], 'throw')).rejects.toBeInstanceOf(SeedReconciliationError);
    });
  });

  // -------------------------------------------------------------------------
  // CASE 2 — proves the documented normalization restores the row.
  // -------------------------------------------------------------------------
  describe('CASE 2 — normalizing "" → NULL restores the row to live', () => {
    it('after the normalization UPDATE the row reads live across every path', async () => {
      await db.insert('doc', { id: 'd1', slug: 'alpha', title: 'budget indexed' });
      await db.insert('plain', { id: 'p1', slug: 'beta', title: 'budget likepath' });
      await db.insert('person', { id: 'per1', slug: 'alice', name: 'Alice' });
      adapter.run("UPDATE doc SET deleted_at = '' WHERE id = 'd1'");
      adapter.run("UPDATE plain SET deleted_at = '' WHERE id = 'p1'");
      adapter.run("UPDATE person SET deleted_at = '' WHERE id = 'per1'");

      // Sanity: hidden before the migration (the CASE-1 state).
      expect(await db.getByNaturalKey('doc', 'slug', 'alpha')).toBeNull();

      // Run the documented normalization on every affected table.
      for (const t of ['doc', 'plain', 'person']) {
        adapter.run(`UPDATE "${t}" SET deleted_at = NULL WHERE deleted_at = ''`);
      }

      // Natural-key lookup now finds it (use the still-single-row 'doc').
      const row = await db.getByNaturalKey('doc', 'slug', 'alpha');
      expect(row?.id).toBe('d1');

      // FTS: both paths include the rows again.
      const r = await fullTextSearch(adapter, ['doc', 'plain'], { query: 'budget' });
      const ids = r.groups.flatMap((g) => g.hits.map((h) => h.id)).sort();
      expect(ids).toEqual(['d1', 'p1']);

      // Seed resolver resolves the link again.
      const result = await seedMeeting(['alice']);
      expect(result.linked).toBe(1);
      expect(result.unresolvedLinks).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CASE 3 — NULL stays live, a timestamp stays deleted. No behavior change.
  // -------------------------------------------------------------------------
  describe('CASE 3 — NULL is live, a timestamp is deleted', () => {
    it('a NULL deleted_at reads as LIVE everywhere', async () => {
      await db.insert('doc', { id: 'd1', slug: 'alpha', title: 'budget live' });

      expect((await db.getByNaturalKey('doc', 'slug', 'alpha'))?.id).toBe('d1');
      expect(await db.countActive('doc')).toBe(1);
      const r = await fullTextSearch(adapter, ['doc'], { query: 'budget' });
      expect(r.groups[0]?.hits.map((h) => h.id)).toEqual(['d1']);
    });

    it('a timestamp deleted_at reads as DELETED everywhere', async () => {
      await db.insert('doc', { id: 'd1', slug: 'alpha', title: 'budget gone' });
      await db.update('doc', 'd1', { deleted_at: new Date().toISOString() });

      expect(await db.getByNaturalKey('doc', 'slug', 'alpha')).toBeNull();
      expect(await db.countActive('doc')).toBe(0);
      const r = await fullTextSearch(adapter, ['doc'], { query: 'budget' });
      expect(r.groups).toEqual([]);
    });
  });
});
