import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

describe('v0.17 features', () => {
  let db: Lattice;

  beforeEach(() => {
    db = new Lattice(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // insertReturning / updateReturning
  // -------------------------------------------------------------------------

  describe('insertReturning', () => {
    it('returns the full inserted row with auto-generated id', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', value: 'INTEGER DEFAULT 0' },
      });
      await db.init();

      const row = await db.insertReturning('items', { name: 'widget' });
      expect(row.id).toBeDefined();
      expect(row.name).toBe('widget');
      expect(row.value).toBe(0); // default value
    });

    it('returns row with caller-provided id', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      });
      await db.init();

      const row = await db.insertReturning('items', { id: 'custom-id', name: 'thing' });
      expect(row.id).toBe('custom-id');
      expect(row.name).toBe('thing');
    });
  });

  describe('updateReturning', () => {
    it('returns the full updated row', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', status: "TEXT DEFAULT 'draft'" },
      });
      await db.init();

      const id = await db.insert('items', { name: 'doc' });
      const updated = await db.updateReturning('items', id, { status: 'published' });
      expect(updated.id).toBe(id);
      expect(updated.name).toBe('doc');
      expect(updated.status).toBe('published');
    });
  });

  // -------------------------------------------------------------------------
  // post-init migrate()
  // -------------------------------------------------------------------------

  describe('migrate()', () => {
    it('runs migrations after init', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      });
      await db.init();

      await db.migrate([{ version: '001', sql: 'ALTER TABLE items ADD COLUMN color TEXT' }]);

      // New column should be usable
      const id = await db.insert('items', { name: 'pen', color: 'blue' });
      const row = await db.get('items', id);
      expect(row?.color).toBe('blue');
    });

    it('skips already-applied migrations (idempotent)', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      });
      await db.init();

      const migrations = [{ version: 'add-color', sql: 'ALTER TABLE items ADD COLUMN color TEXT' }];

      await db.migrate(migrations);
      // Running again should not throw
      await db.migrate(migrations);
    });

    it('supports string-based version identifiers', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      });
      await db.init();

      await db.migrate([
        { version: '@mypackage:1.0.0', sql: 'SELECT 1' },
        { version: '@mypackage:1.1.0', sql: 'SELECT 1' },
      ]);

      // Both should be recorded
      const rows = db.db.prepare('SELECT version FROM __lattice_migrations').all();
      const versions = rows.map((r: Record<string, unknown>) => r.version);
      expect(versions).toContain('@mypackage:1.0.0');
      expect(versions).toContain('@mypackage:1.1.0');
    });

    it('rejects when called before init', async () => {
      await expect(db.migrate([{ version: 1, sql: 'SELECT 1' }])).rejects.toThrow(
        /not initialized/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Composite primary keys
  // -------------------------------------------------------------------------

  describe('composite primary keys', () => {
    it('auto-generates PRIMARY KEY constraint for array primaryKey', async () => {
      db.define('user_tags', {
        columns: {
          user_id: 'TEXT NOT NULL',
          tag_id: 'TEXT NOT NULL',
          assigned_at: 'TEXT DEFAULT CURRENT_TIMESTAMP',
        },
        primaryKey: ['user_id', 'tag_id'],
      });
      await db.init();

      // First insert should work
      await db.link('user_tags', { user_id: 'u1', tag_id: 't1' });
      await db.link('user_tags', { user_id: 'u1', tag_id: 't2' });

      // Duplicate should be silently ignored (INSERT OR IGNORE)
      await db.link('user_tags', { user_id: 'u1', tag_id: 't1' });

      const rows = await db.query('user_tags');
      expect(rows).toHaveLength(2);
    });

    it('does not duplicate PRIMARY KEY if already in tableConstraints', async () => {
      db.define('scores', {
        columns: {
          player_id: 'TEXT NOT NULL',
          game_id: 'TEXT NOT NULL',
          score: 'INTEGER NOT NULL',
        },
        primaryKey: ['player_id', 'game_id'],
        tableConstraints: ['PRIMARY KEY ("player_id", "game_id")'],
      });
      await db.init();

      await db.link('scores', { player_id: 'p1', game_id: 'g1', score: 100 });
      await db.link('scores', { player_id: 'p1', game_id: 'g1', score: 200 });
      const rows = await db.query('scores');
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Schema-only tables (optional render/outputFile)
  // -------------------------------------------------------------------------

  describe('schema-only tables', () => {
    it('define() works without render or outputFile', async () => {
      db.define('logs', {
        columns: { id: 'TEXT PRIMARY KEY', message: 'TEXT NOT NULL' },
      });
      await db.init();

      const id = await db.insert('logs', { message: 'hello' });
      const row = await db.get('logs', id);
      expect(row?.message).toBe('hello');
    });
  });

  // -------------------------------------------------------------------------
  // String-based init migrations (backward compat with number)
  // -------------------------------------------------------------------------

  describe('init migrations with mixed version types', () => {
    it('accepts numeric versions (backward compat)', async () => {
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY' },
      });
      await db.init({
        migrations: [
          { version: 1, sql: 'CREATE TABLE IF NOT EXISTS extras (id TEXT PRIMARY KEY)' },
          { version: 2, sql: 'SELECT 1' },
        ],
      });

      // Should have created the extras table
      const row = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extras'")
        .get();
      expect(row).toBeDefined();
    });
  });
});
