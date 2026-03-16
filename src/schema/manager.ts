import type { StorageAdapter } from '../db/adapter.js';
import type { TableDefinition, MultiTableDefinition, Migration, Row } from '../types.js';

export interface RegisteredTable {
  name: string;
  definition: TableDefinition;
}

export interface RegisteredMulti {
  name: string;
  definition: MultiTableDefinition;
}

export class SchemaManager {
  private readonly _tables = new Map<string, TableDefinition>();
  private readonly _multis = new Map<string, MultiTableDefinition>();

  define(table: string, def: TableDefinition): void {
    if (this._tables.has(table)) {
      throw new Error(`Table "${table}" is already defined`);
    }
    this._tables.set(table, def);
  }

  defineMulti(name: string, def: MultiTableDefinition): void {
    if (this._multis.has(name)) {
      throw new Error(`Multi-render "${name}" is already defined`);
    }
    this._multis.set(name, def);
  }

  getTables(): Map<string, TableDefinition> {
    return this._tables;
  }

  getMultis(): Map<string, MultiTableDefinition> {
    return this._multis;
  }

  /**
   * Apply schema: create missing tables, add missing columns.
   * Never drops tables or columns.
   */
  applySchema(adapter: StorageAdapter): void {
    for (const [name, def] of this._tables) {
      this._ensureTable(adapter, name, def.columns);
    }
    // Internal schema_migrations table
    this._ensureTable(adapter, '__lattice_migrations', {
      version: 'INTEGER PRIMARY KEY',
      applied_at: 'TEXT NOT NULL',
    });
  }

  /** Run explicit versioned migrations in order, idempotently */
  applyMigrations(adapter: StorageAdapter, migrations: Migration[]): void {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    for (const m of sorted) {
      const exists = adapter.get(
        'SELECT 1 FROM __lattice_migrations WHERE version = ?',
        [m.version],
      );
      if (!exists) {
        adapter.run(m.sql);
        adapter.run(
          'INSERT INTO __lattice_migrations (version, applied_at) VALUES (?, ?)',
          [m.version, new Date().toISOString()],
        );
      }
    }
  }

  /** Query all rows from a registered table */
  queryTable(adapter: StorageAdapter, name: string): Row[] {
    if (!this._tables.has(name)) {
      throw new Error(`Unknown table: "${name}"`);
    }
    return adapter.all(`SELECT * FROM "${name}"`);
  }

  private _ensureTable(
    adapter: StorageAdapter,
    name: string,
    columns: Record<string, string>,
  ): void {
    const colDefs = Object.entries(columns)
      .map(([col, type]) => `"${col}" ${type}`)
      .join(', ');
    adapter.run(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs})`);
    this._addMissingColumns(adapter, name, columns);
  }

  private _addMissingColumns(
    adapter: StorageAdapter,
    table: string,
    columns: Record<string, string>,
  ): void {
    const existing = adapter
      .all(`PRAGMA table_info("${table}")`)
      .map((r) => r['name'] as string);

    for (const [col, type] of Object.entries(columns)) {
      if (!existing.includes(col)) {
        adapter.run(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${type}`);
      }
    }
  }
}
