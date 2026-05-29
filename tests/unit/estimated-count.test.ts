import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * On SQLite there is no cheap row estimate, so estimatedCount must delegate to
 * the exact count() — it should always equal the real row total. (The Postgres
 * pg_class.reltuples path is exercised in tests/integration/estimated-count-postgres.test.ts.)
 */
describe('Lattice.estimatedCount (SQLite delegates to exact count)', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('returns 0 for an empty table', async () => {
    expect(await db.estimatedCount('widgets')).toBe(0);
  });

  it('matches exact count after inserts', async () => {
    await db.insert('widgets', { id: 'a', name: 'A' });
    await db.insert('widgets', { id: 'b', name: 'B' });
    await db.insert('widgets', { id: 'c', name: 'C' });
    expect(await db.estimatedCount('widgets')).toBe(3);
    expect(await db.estimatedCount('widgets')).toBe(await db.count('widgets'));
  });
});
