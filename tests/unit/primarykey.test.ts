import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

function makeDb(): Lattice {
  return new Lattice(':memory:');
}

describe('Custom primary key', () => {
  let db: Lattice;

  afterEach(() => db.close());

  // -------------------------------------------------------------------------
  // Default behaviour (backward compat)
  // -------------------------------------------------------------------------

  describe('default PK (id)', () => {
    beforeEach(async () => {
      db = makeDb();
      db.define('bots', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
        render: () => '',
        outputFile: 'bots.md',
      });
      await db.init();
    });

    it('insert auto-generates UUID when id is absent', async () => {
      const id = await db.insert('bots', { name: 'Alpha' });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const row = await db.get('bots', id);
      expect(row?.name).toBe('Alpha');
    });

    it('insert uses provided id when present', async () => {
      const id = await db.insert('bots', { id: 'bot-1', name: 'Alpha' });
      expect(id).toBe('bot-1');
    });

    it('get, update, delete accept a string id', async () => {
      await db.insert('bots', { id: 'bot-1', name: 'Alpha' });
      await db.update('bots', 'bot-1', { name: 'Beta' });
      const row = await db.get('bots', 'bot-1');
      expect(row?.name).toBe('Beta');
      await db.delete('bots', 'bot-1');
      expect(await db.get('bots', 'bot-1')).toBeNull();
    });

    it('upsert conflicts on id', async () => {
      await db.insert('bots', { id: 'bot-1', name: 'Alpha' });
      await db.upsert('bots', { id: 'bot-1', name: 'Alpha Updated' });
      const row = await db.get('bots', 'bot-1');
      expect(row?.name).toBe('Alpha Updated');
    });
  });

  // -------------------------------------------------------------------------
  // Custom single-column PK
  // -------------------------------------------------------------------------

  describe('custom single-column PK', () => {
    beforeEach(async () => {
      db = makeDb();
      db.define('posts', {
        columns: { slug: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL', views: 'INTEGER DEFAULT 0' },
        primaryKey: 'slug',
        render: () => '',
        outputFile: 'posts.md',
      });
      await db.init();
    });

    it('insert uses the custom PK and returns its value', async () => {
      const pk = await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
      expect(pk).toBe('hello-world');
    });

    it('get works with the custom PK value as string', async () => {
      await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
      const row = await db.get('posts', 'hello-world');
      expect(row?.title).toBe('Hello World');
    });

    it('update uses the custom PK in WHERE', async () => {
      await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
      await db.update('posts', 'hello-world', { title: 'Updated' });
      const row = await db.get('posts', 'hello-world');
      expect(row?.title).toBe('Updated');
    });

    it('delete uses the custom PK in WHERE', async () => {
      await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
      await db.delete('posts', 'hello-world');
      expect(await db.get('posts', 'hello-world')).toBeNull();
    });

    it('upsert conflicts on the custom PK', async () => {
      await db.insert('posts', { slug: 'hello-world', title: 'Hello World', views: 0 });
      await db.upsert('posts', { slug: 'hello-world', title: 'Hello World', views: 42 });
      const row = await db.get('posts', 'hello-world');
      expect(row?.views).toBe(42);
    });

    it('upsertBy finds existing row and updates', async () => {
      await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
      const pk = await db.upsertBy('posts', 'slug', 'hello-world', { title: 'Overwrite' });
      expect(pk).toBe('hello-world');
      const row = await db.get('posts', 'hello-world');
      expect(row?.title).toBe('Overwrite');
    });

    it('does NOT auto-generate a UUID for custom PK', async () => {
      // With a custom PK, Lattice never auto-generates a UUID — the caller owns the value.
      // To enforce presence, mark the PK column NOT NULL. Use a fresh db with that constraint.
      const strictDb = new Lattice(':memory:');
      strictDb.define('posts', {
        columns: { slug: 'TEXT NOT NULL PRIMARY KEY', title: 'TEXT NOT NULL' },
        primaryKey: 'slug',
        render: () => '',
        outputFile: 'posts.md',
      });
      await strictDb.init();
      // Inserting without slug violates NOT NULL — SQLite throws synchronously.
      expect(() => strictDb.insert('posts', { title: 'No slug' })).toThrow();
      strictDb.close();
    });
  });

  // -------------------------------------------------------------------------
  // Composite primary key
  // -------------------------------------------------------------------------

  describe('composite primary key', () => {
    beforeEach(async () => {
      db = makeDb();
      db.define('seats', {
        columns: {
          event_id: 'TEXT NOT NULL',
          seat_no: 'INTEGER NOT NULL',
          holder: 'TEXT',
        },
        tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
        primaryKey: ['event_id', 'seat_no'],
        render: () => '',
        outputFile: 'seats.md',
      });
      await db.init();
    });

    it('insert returns the value of the first PK column', async () => {
      const pk = await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
      expect(pk).toBe('evt-1');
    });

    it('get accepts a Record with all PK columns', async () => {
      await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
      const row = await db.get('seats', { event_id: 'evt-1', seat_no: 5 });
      expect(row?.holder).toBe('Alice');
    });

    it('get returns null when PK has no match', async () => {
      await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
      const row = await db.get('seats', { event_id: 'evt-1', seat_no: 99 });
      expect(row).toBeNull();
    });

    it('update by composite PK Record', async () => {
      await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
      await db.update('seats', { event_id: 'evt-1', seat_no: 5 }, { holder: 'Bob' });
      const row = await db.get('seats', { event_id: 'evt-1', seat_no: 5 });
      expect(row?.holder).toBe('Bob');
    });

    it('delete by composite PK Record', async () => {
      await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
      await db.delete('seats', { event_id: 'evt-1', seat_no: 5 });
      const row = await db.get('seats', { event_id: 'evt-1', seat_no: 5 });
      expect(row).toBeNull();
    });

    it('only deletes the matching composite key row', async () => {
      await db.insert('seats', { event_id: 'evt-1', seat_no: 1, holder: 'Alice' });
      await db.insert('seats', { event_id: 'evt-1', seat_no: 2, holder: 'Bob' });
      await db.delete('seats', { event_id: 'evt-1', seat_no: 1 });
      const rows = await db.query('seats', { where: { event_id: 'evt-1' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.holder).toBe('Bob');
    });
  });

  // -------------------------------------------------------------------------
  // SchemaManager.getPrimaryKey()
  // -------------------------------------------------------------------------

  describe('SchemaManager.getPrimaryKey()', () => {
    it('returns [id] when primaryKey is omitted', async () => {
      db = makeDb();
      db.define('things', {
        columns: { id: 'TEXT PRIMARY KEY', v: 'TEXT' },
        render: () => '',
        outputFile: 'things.md',
      });
      await db.init();
      // Verify default PK by inserting without id and getting by returned value
      const id = await db.insert('things', { v: 'hello' });
      expect(await db.get('things', id)).not.toBeNull();
    });

    it('rejects an empty primaryKey array', () => {
      db = makeDb();
      expect(() =>
        db.define('bad', {
          columns: { a: 'TEXT' },
          primaryKey: [],
          render: () => '',
          outputFile: 'bad.md',
        }),
      ).toThrow();
    });
  });
});
