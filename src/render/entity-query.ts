import type { Row } from '../types.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { EntityFileSource } from '../schema/entity-context.js';

/**
 * Resolve an {@link EntityFileSource} to rows for a given entity row.
 *
 * All queries use the synchronous better-sqlite3 adapter — no async required.
 *
 * @param source     - The source descriptor from an {@link EntityFileSpec}
 * @param entityRow  - The anchor entity row being rendered
 * @param entityPk   - The primary key column name for the entity's table
 * @param adapter    - The raw storage adapter for direct SQL access
 */
export function resolveEntitySource(
  source: EntityFileSource,
  entityRow: Row,
  entityPk: string,
  adapter: StorageAdapter,
): Row[] {
  switch (source.type) {
    case 'self':
      return [entityRow];

    case 'hasMany': {
      const ref = source.references ?? entityPk;
      const pkVal = entityRow[ref];
      return adapter.all(
        `SELECT * FROM "${source.table}" WHERE "${source.foreignKey}" = ?`,
        [pkVal],
      );
    }

    case 'manyToMany': {
      const pkVal = entityRow[entityPk];
      const remotePk = source.references ?? 'id';
      return adapter.all(
        `SELECT r.* FROM "${source.remoteTable}" r
         JOIN "${source.junctionTable}" j ON j."${source.remoteKey}" = r."${remotePk}"
         WHERE j."${source.localKey}" = ?`,
        [pkVal],
      );
    }

    case 'belongsTo': {
      const fkVal = entityRow[source.foreignKey];
      if (fkVal == null) return [];
      const related = adapter.get(
        `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`,
        [fkVal],
      );
      return related ? [related] : [];
    }

    case 'custom':
      return source.query(entityRow, adapter);
  }
}

/**
 * Truncate rendered content to a character budget.
 * Appends a notice when truncation occurs so readers know the output is incomplete.
 * Returns `content` unchanged when `budget` is undefined or not exceeded.
 */
export function truncateContent(content: string, budget: number | undefined): string {
  if (budget === undefined || content.length <= budget) return content;
  return content.slice(0, budget) + '\n\n*[truncated — context budget exceeded]*';
}
