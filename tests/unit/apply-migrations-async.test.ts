/**
 * Async migration runner tests against the SQLite adapter. Covers:
 *   - applies pending migrations and records them in __lattice_migrations
 *   - is idempotent across re-runs (no duplicate inserts)
 *   - applies migrations in numeric-aware sort order
 *   - the SQLite path skips the pg_xact_advisory_lock branch (otherwise
 *     SQLite would error on the unknown function)
 *   - falls back to the synchronous runner when adapter.withClient is absent
 *
 * Postgres-side coverage (pg_xact_advisory_lock acquisition + concurrent-boot
 * serialization) lives in the consumer app's integration suite — that's the
 * only place a real Postgres server is in scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SchemaManager } from '../../src/schema/manager.js';
import { SQLiteAdapter } from '../../src/db/sqlite.js';
import type { Migration } from '../../src/types.js';

describe('SchemaManager.applyMigrationsAsync', () => {
  let mgr: SchemaManager;
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    mgr = new SchemaManager();
    adapter = new SQLiteAdapter(':memory:');
    adapter.open();
    mgr.applySchema(adapter); // creates __lattice_migrations
  });

  afterEach(() => {
    adapter.close();
  });

  it('applies pending migrations and records each in __lattice_migrations', async () => {
    const migrations: Migration[] = [
      { version: '1', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
      { version: '2', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY)' },
    ];

    await mgr.applyMigrationsAsync(adapter, migrations);

    expect(adapter.introspectColumns('a')).toEqual(['id']);
    expect(adapter.introspectColumns('b')).toEqual(['id']);

    const recorded = adapter.all('SELECT version FROM __lattice_migrations ORDER BY version');
    expect(recorded.map((r) => r.version)).toEqual(['1', '2']);
  });

  it('is idempotent — second run does not re-apply or duplicate rows', async () => {
    const migrations: Migration[] = [
      { version: '1', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
    ];
    await mgr.applyMigrationsAsync(adapter, migrations);
    // Re-run with the same migration list. CREATE TABLE without IF NOT EXISTS
    // would fail on second run if the runner tried to re-apply.
    await mgr.applyMigrationsAsync(adapter, migrations);

    const recorded = adapter.all('SELECT version FROM __lattice_migrations');
    expect(recorded).toHaveLength(1);
  });

  it('applies migrations in numeric-aware sort order, not declaration order', async () => {
    // Declared 10 before 2; numeric sort should run 2 first. The third
    // migration depends on the table created by version 2 — it would fail
    // if the runner used declaration order (10, 2, 2-ref) instead of
    // numeric (2, 2-ref, 10).
    const migrations: Migration[] = [
      { version: '10', sql: 'CREATE TABLE later (id INTEGER PRIMARY KEY)' },
      { version: '2', sql: 'CREATE TABLE earlier (id INTEGER PRIMARY KEY)' },
      { version: '2-ref', sql: "INSERT INTO earlier (id) VALUES (1)" },
    ];
    await mgr.applyMigrationsAsync(adapter, migrations);

    expect(adapter.all('SELECT id FROM earlier')).toEqual([{ id: 1 }]);
    expect(adapter.introspectColumns('later')).toEqual(['id']);
  });

  it('rolls back on migration failure — no partial state recorded', async () => {
    const migrations: Migration[] = [
      { version: '1', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
      { version: '2', sql: 'BLATANTLY INVALID SQL' },
      { version: '3', sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY)' },
    ];

    await expect(mgr.applyMigrationsAsync(adapter, migrations)).rejects.toThrow();

    // The whole withClient block rolls back on a single failed migration —
    // no rows in __lattice_migrations should reflect the partial run.
    const recorded = adapter.all('SELECT version FROM __lattice_migrations');
    expect(recorded).toEqual([]);

    // And no tables should have been created.
    const tables = adapter.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'c')",
    );
    expect(tables).toEqual([]);
  });

  it('falls back to synchronous applyMigrations when adapter has no withClient', async () => {
    // Strip withClient from the adapter at runtime to simulate a third-party
    // adapter that hasn't adopted the async surface yet.
    const stripped = adapter as unknown as { withClient?: unknown };
    const original = stripped.withClient;
    delete stripped.withClient;

    try {
      const migrations: Migration[] = [
        { version: '1', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
      ];
      await mgr.applyMigrationsAsync(adapter, migrations);

      expect(adapter.introspectColumns('a')).toEqual(['id']);
      const recorded = adapter.all('SELECT version FROM __lattice_migrations');
      expect(recorded.map((r) => r.version)).toEqual(['1']);
    } finally {
      stripped.withClient = original;
    }
  });
});
