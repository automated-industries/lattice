import type Database from 'better-sqlite3';

/**
 * Fix legacy schema conflicts before Lattice init().
 *
 * When upgrading from an older schema version, existing tables may have
 * incompatible column definitions (e.g., a column with PRIMARY KEY that
 * new code tries to add via ALTER TABLE, which SQLite doesn't support).
 *
 * This utility renames conflicting tables to `_legacy_{name}` so init()
 * can create fresh tables with the new schema.
 *
 * @param db - An open better-sqlite3 database instance
 * @param checks - Array of { table, requiredColumns } to verify
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { fixSchemaConflicts } from 'latticesql';
 *
 * const db = new Database('./app.db');
 * fixSchemaConflicts(db, [
 *   { table: 'sessions', requiredColumns: ['id'] },
 *   { table: 'messages', requiredColumns: ['id'] },
 * ]);
 * db.close();
 * // Now safe to call lattice.init()
 * ```
 */
export function fixSchemaConflicts(
  db: Database.Database,
  checks: { table: string; requiredColumns: string[] }[],
): void {
  for (const { table, requiredColumns } of checks) {
    if (!tableExists(db, table)) continue;
    const cols = getColumns(db, table);
    const missing = requiredColumns.filter((c) => !cols.includes(c));
    if (missing.length > 0) {
      renameTable(db, table);
    }
  }

  // Fix __lattice_migrations table if version column type changed
  if (tableExists(db, '__lattice_migrations')) {
    const versionCol = (
      db.prepare('PRAGMA table_info("__lattice_migrations")').all() as {
        name: string;
        type: string;
      }[]
    ).find((c) => c.name === 'version');
    if (versionCol?.type.toUpperCase().includes('INTEGER')) {
      db.exec('ALTER TABLE "__lattice_migrations" RENAME TO "__lattice_migrations_v1"');
    }
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function getColumns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
}

function renameTable(db: Database.Database, table: string): void {
  const target = `_legacy_${table}`;
  if (tableExists(db, target)) {
    db.exec(`DROP TABLE "${target}"`);
  }
  db.exec(`ALTER TABLE "${table}" RENAME TO "${target}"`);
}
