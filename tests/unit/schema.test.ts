import { describe, it, expect } from 'vitest';
import { SchemaManager } from '../../src/schema/manager.js';
import { SQLiteAdapter } from '../../src/db/sqlite.js';

function makeAdapter(): SQLiteAdapter {
  const a = new SQLiteAdapter(':memory:');
  a.open();
  return a;
}

describe('SchemaManager', () => {
  it('throws if same table is defined twice', () => {
    const mgr = new SchemaManager();
    const def = { columns: { id: 'TEXT PRIMARY KEY' }, render: () => '', outputFile: 'f.md' };
    mgr.define('bots', def);
    expect(() => { mgr.define('bots', def); }).toThrow(/"bots"/);
  });

  it('throws if same multi name is defined twice', () => {
    const mgr = new SchemaManager();
    const def = { keys: () => Promise.resolve([]), outputFile: () => 'x.md', render: () => '' };
    mgr.defineMulti('ctx', def);
    expect(() => { mgr.defineMulti('ctx', def); }).toThrow(/"ctx"/);
  });

  it('applySchema creates the table', () => {
    const mgr = new SchemaManager();
    mgr.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    const adapter = makeAdapter();
    mgr.applySchema(adapter);

    const result = adapter.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`,
    );
    expect(result?.name).toBe('tasks');
    adapter.close();
  });

  it('applySchema is idempotent', () => {
    const mgr = new SchemaManager();
    mgr.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: 'tasks.md',
    });
    const adapter = makeAdapter();
    expect(() => {
      mgr.applySchema(adapter);
      mgr.applySchema(adapter); // second call should not throw
    }).not.toThrow();
    adapter.close();
  });

  it('applySchema adds missing columns to existing tables', () => {
    const adapter = makeAdapter();
    adapter.run('CREATE TABLE items (id TEXT PRIMARY KEY)');

    const mgr = new SchemaManager();
    mgr.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', active: 'INTEGER DEFAULT 1' },
      render: () => '',
      outputFile: 'items.md',
    });
    mgr.applySchema(adapter);

    const cols = adapter
      .all('PRAGMA table_info(items)')
      .map((r) => r.name as string);
    expect(cols).toContain('name');
    expect(cols).toContain('active');
    adapter.close();
  });

  it('applyMigrations runs missing migrations in order', () => {
    const mgr = new SchemaManager();
    const adapter = makeAdapter();
    adapter.run(
      'CREATE TABLE __lattice_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    adapter.run('CREATE TABLE items (id TEXT PRIMARY KEY)');

    mgr.applyMigrations(adapter, [
      { version: 2, sql: 'ALTER TABLE items ADD COLUMN score INTEGER DEFAULT 0' },
      { version: 1, sql: 'ALTER TABLE items ADD COLUMN name TEXT' },
    ]);

    const cols = adapter
      .all('PRAGMA table_info(items)')
      .map((r) => r.name as string);
    expect(cols).toContain('name');
    expect(cols).toContain('score');
    adapter.close();
  });

  it('applyMigrations is idempotent', () => {
    const mgr = new SchemaManager();
    const adapter = makeAdapter();
    adapter.run(
      'CREATE TABLE __lattice_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    adapter.run('CREATE TABLE items (id TEXT PRIMARY KEY)');

    const migrations = [
      { version: 1, sql: 'ALTER TABLE items ADD COLUMN name TEXT' },
    ];
    mgr.applyMigrations(adapter, migrations);
    expect(() => { mgr.applyMigrations(adapter, migrations); }).not.toThrow();
    adapter.close();
  });

  it('queryTable returns rows', () => {
    const mgr = new SchemaManager();
    mgr.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'items.md',
    });
    const adapter = makeAdapter();
    mgr.applySchema(adapter);
    adapter.run('INSERT INTO items (id, name) VALUES (?, ?)', ['i1', 'Thing']);

    const rows = mgr.queryTable(adapter, 'items');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Thing');
    adapter.close();
  });

  it('queryTable throws for unknown table', () => {
    const mgr = new SchemaManager();
    const adapter = makeAdapter();
    expect(() => mgr.queryTable(adapter, 'missing')).toThrow('Unknown table');
    adapter.close();
  });
});
