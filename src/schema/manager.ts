import type { StorageAdapter, TxClient } from '../db/adapter.js';
import { LATTICE_MIGRATION_LOCK_ID } from '../db/lock-ids.js';
import type {
  TableDefinition,
  MultiTableDefinition,
  Migration,
  Relation,
  Row,
  BuiltinTemplateName,
} from '../types.js';
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
  /** Preserved built-in template name (if any) for reverse-seed parsing. */
  _renderTemplateName?: BuiltinTemplateName;
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

  /**
   * Run explicit versioned migrations in order, idempotently.
   *
   * Synchronous path. Used by SQLite consumers and any caller that hasn't
   * migrated to the async surface yet. Postgres consumers should call
   * `applyMigrationsAsync` so concurrent boots serialize on a transaction-
   * scoped advisory lock instead of racing.
   */
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
   * Async migration runner. Wraps the migration loop in a single
   * `withClient(fn)` block — pinning every statement to the same upstream
   * connection so the BEGIN/COMMIT lifecycle is atomic against pgbouncer
   * transaction-mode pooling.
   *
   * On Postgres, also acquires `pg_xact_advisory_lock` at the top of the
   * transaction so concurrent app boots (Railway rolling deploys, two
   * developer laptops booting against a shared dev DB) queue on the lock
   * and apply migrations serially. The lock is transaction-scoped so it
   * auto-releases at COMMIT — no explicit unlock needed and no risk of a
   * leaked lock surviving a crashed boot.
   *
   * On SQLite, the advisory-lock branch is skipped (better-sqlite3's
   * single-writer guarantee plus WAL + busy_timeout already handle
   * concurrent boots). The withClient block reduces to a plain
   * BEGIN/COMMIT pair — semantically the same as the sync path.
   *
   * Falls back to the sync `applyMigrations` if the adapter doesn't
   * implement `withClient`. That path covers the period when an adapter
   * has been upgraded but the consumer hasn't yet adopted the async
   * surface end-to-end.
   */
  async applyMigrationsAsync(adapter: StorageAdapter, migrations: Migration[]): Promise<void> {
    if (!adapter.withClient) {
      this.applyMigrations(adapter, migrations);
      return;
    }
    const sorted = [...migrations].sort((a, b) => {
      const va = String(a.version);
      const vb = String(b.version);
      return va.localeCompare(vb, undefined, { numeric: true });
    });
    await adapter.withClient(async (tx: TxClient) => {
      if (adapter.dialect === 'postgres') {
        // Transaction-scoped — auto-released at COMMIT. Serializes any
        // concurrent boot that reaches this same withClient block.
        await tx.run('SELECT pg_xact_advisory_lock($1)', [LATTICE_MIGRATION_LOCK_ID.toString()]);
      }
      for (const m of sorted) {
        const versionStr = String(m.version);
        const exists = await tx.get(
          'SELECT 1 FROM __lattice_migrations WHERE version = ?',
          [versionStr],
        );
        if (!exists) {
          await tx.run(m.sql);
          await tx.run(
            'INSERT INTO __lattice_migrations (version, applied_at) VALUES (?, ?)',
            [versionStr, new Date().toISOString()],
          );
        }
      }
    });
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
      const cols = adapter.introspectColumns(name);
      const hasDeletedAt = cols.includes('deleted_at');
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
    const existing = adapter.introspectColumns(table);
    for (const [col, type] of Object.entries(columns)) {
      if (existing.includes(col)) continue;
      // Adapter handles dialect-specific quirks (SQLite non-constant default
      // workarounds, Postgres native DEFAULT NOW(), PK skip, etc.).
      adapter.addColumn(table, col, type);
    }
  }
}
