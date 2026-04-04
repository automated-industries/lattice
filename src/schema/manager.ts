import type { StorageAdapter } from '../db/adapter.js';
import type { TableDefinition, MultiTableDefinition, Migration, Relation, Row } from '../types.js';
import type { EntityContextDefinition } from './entity-context.js';

export interface RegisteredTable {
  name: string;
  definition: TableDefinition;
}

export interface RegisteredMulti {
  name: string;
  definition: MultiTableDefinition;
}

/**
 * Internal representation of a table definition where `render` has always
 * been compiled down to a plain function by `Lattice.define()`.
 * This is what SchemaManager and RenderEngine always work with.
 */
export type CompiledTableDef = Omit<TableDefinition, 'render' | 'outputFile'> & {
  render: (rows: Row[]) => string;
  outputFile: string;
};

export class SchemaManager {
  private readonly _tables = new Map<string, CompiledTableDef>();
  /** Normalised primary key columns per table (always an array). */
  private readonly _tablePK = new Map<string, string[]>();
  private readonly _multis = new Map<string, MultiTableDefinition>();
  private readonly _entityContexts = new Map<string, EntityContextDefinition>();

  define(table: string, def: CompiledTableDef): void {
    if (this._tables.has(table)) {
      throw new Error(`Table "${table}" is already defined`);
    }
    this._tables.set(table, def);

    // Normalise primaryKey to string[] and store separately.
    if (def.primaryKey === undefined || def.primaryKey === 'id') {
      this._tablePK.set(table, ['id']);
    } else if (Array.isArray(def.primaryKey)) {
      if (def.primaryKey.length === 0) {
        throw new Error(`Table "${table}": primaryKey array must not be empty`);
      }
      this._tablePK.set(table, def.primaryKey);
    } else {
      this._tablePK.set(table, [def.primaryKey]);
    }
  }

  defineMulti(name: string, def: MultiTableDefinition): void {
    if (this._multis.has(name)) {
      throw new Error(`Multi-render "${name}" is already defined`);
    }
    this._multis.set(name, def);
  }

  /**
   * Register an entity context definition.
   * Throws if a context for the same table has already been registered.
   */
  defineEntityContext(table: string, def: EntityContextDefinition): void {
    if (this._entityContexts.has(table)) {
      throw new Error(`Entity context for table "${table}" is already defined`);
    }
    this._entityContexts.set(table, def);
  }

  getTables(): Map<string, CompiledTableDef> {
    return this._tables;
  }

  getMultis(): Map<string, MultiTableDefinition> {
    return this._multis;
  }

  getEntityContexts(): Map<string, EntityContextDefinition> {
    return this._entityContexts;
  }

  /**
   * Return the normalised primary key column list for a table.
   * Falls back to `['id']` for tables that were not registered via `define()`
   * (e.g. tables accessed through the raw `.db` escape hatch).
   */
  getPrimaryKey(table: string): string[] {
    return this._tablePK.get(table) ?? ['id'];
  }

  /**
   * Return the declared relationships for a table, keyed by relation name.
   * Returns an empty object for tables with no `relations` definition.
   */
  getRelations(table: string): Record<string, Relation> {
    return this._tables.get(table)?.relations ?? {};
  }

  /**
   * Apply schema: create missing tables, add missing columns.
   * Never drops tables or columns.
   */
  applySchema(adapter: StorageAdapter): void {
    for (const [name, def] of this._tables) {
      // For composite primary keys, inject a PRIMARY KEY(...) table constraint
      // if the caller hasn't already provided one.
      const pkCols = this._tablePK.get(name) ?? ['id'];
      const constraints = def.tableConstraints ? [...def.tableConstraints] : [];
      if (pkCols.length > 1) {
        const alreadyHasPK = constraints.some((c) => c.toUpperCase().startsWith('PRIMARY KEY'));
        if (!alreadyHasPK) {
          constraints.unshift(`PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(', ')})`);
        }
      }
      this._ensureTable(adapter, name, def.columns, constraints.length ? constraints : undefined);
    }
    // Internal migrations tracking table — uses TEXT version for both numeric
    // and string-based version identifiers (e.g. "1", "pkg:1.0.0").
    this._ensureTable(adapter, '__lattice_migrations', {
      version: 'TEXT PRIMARY KEY',
      applied_at: 'TEXT NOT NULL',
    });
  }

  /** Run explicit versioned migrations in order, idempotently */
  applyMigrations(adapter: StorageAdapter, migrations: Migration[]): void {
    const sorted = [...migrations].sort((a, b) => {
      const va = String(a.version);
      const vb = String(b.version);
      return va.localeCompare(vb, undefined, { numeric: true });
    });
    for (const m of sorted) {
      const versionStr = String(m.version);
      const exists = adapter.get('SELECT 1 FROM __lattice_migrations WHERE version = ?', [
        versionStr,
      ]);
      if (!exists) {
        adapter.run(m.sql);
        adapter.run('INSERT INTO __lattice_migrations (version, applied_at) VALUES (?, ?)', [
          versionStr,
          new Date().toISOString(),
        ]);
      }
    }
  }

  /**
   * Query all rows from a table.
   * Registered tables (via `define()`) are queried directly.
   * Tables used only in entity contexts (schema managed externally) fall back
   * to a raw SELECT with optional `deleted_at IS NULL` soft-delete filtering.
   */
  queryTable(adapter: StorageAdapter, name: string): Row[] {
    if (this._tables.has(name)) {
      // Auto-filter soft-deleted rows when the table has a deleted_at column
      const def = this._tables.get(name);
      if (def?.columns && 'deleted_at' in def.columns) {
        return adapter.all(`SELECT * FROM "${name}" WHERE deleted_at IS NULL`);
      }
      return adapter.all(`SELECT * FROM "${name}"`);
    }
    if (this._entityContexts.has(name)) {
      const cols = adapter.all(`PRAGMA table_info("${name}")`);
      const hasDeletedAt = cols.some((c) => (c as Record<string, unknown>).name === 'deleted_at');
      return adapter.all(
        `SELECT * FROM "${name}"${hasDeletedAt ? ' WHERE deleted_at IS NULL' : ''}`,
      );
    }
    throw new Error(`Unknown table: "${name}"`);
  }

  private _ensureTable(
    adapter: StorageAdapter,
    name: string,
    columns: Record<string, string>,
    tableConstraints?: string[],
  ): void {
    const colDefs = Object.entries(columns)
      .map(([col, type]) => `"${col}" ${type}`)
      .join(', ');
    const constraintDefs =
      tableConstraints && tableConstraints.length > 0 ? ', ' + tableConstraints.join(', ') : '';
    adapter.run(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs}${constraintDefs})`);
    this._addMissingColumns(adapter, name, columns);
  }

  private _addMissingColumns(
    adapter: StorageAdapter,
    table: string,
    columns: Record<string, string>,
  ): void {
    const existing = adapter.all(`PRAGMA table_info("${table}")`).map((r) => r.name as string);

    for (const [col, type] of Object.entries(columns)) {
      if (!existing.includes(col)) {
        // SQLite does not allow adding PRIMARY KEY columns via ALTER TABLE.
        // Skip PK columns — if the table already exists, it has its own PK.
        if (type.toUpperCase().includes('PRIMARY KEY')) continue;

        // SQLite ALTER TABLE ADD COLUMN requires constant defaults.
        // CURRENT_TIMESTAMP, datetime('now'), etc. are non-constant and will error.
        // Strip NOT NULL and replace non-constant defaults for the ALTER statement,
        // then backfill existing rows with the intended default.
        const upperType = type.toUpperCase();
        const hasNonConstantDefault =
          upperType.includes('CURRENT_TIMESTAMP') ||
          upperType.includes("DATETIME('NOW')") ||
          upperType.includes('RANDOM()');

        if (hasNonConstantDefault) {
          // Remove NOT NULL and replace DEFAULT <non-constant> with no default
          const safeType = type
            .replace(/\bNOT\s+NULL\b/gi, '')
            .replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/gi, '')
            .replace(/\bDEFAULT\s+datetime\([^)]*\)/gi, '')
            .replace(/\bDEFAULT\s+RANDOM\(\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          adapter.run(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${safeType || 'TEXT'}`);
          // Backfill existing rows with the intended default
          adapter.run(`UPDATE "${table}" SET "${col}" = CURRENT_TIMESTAMP WHERE "${col}" IS NULL`);
        } else {
          adapter.run(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${type}`);
        }
      }
    }
  }
}
