import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  assertSafeIdentifier,
  assertExternalIdentifier,
  isSafeIdentifier,
} from '../../src/schema/identifier.js';

/**
 * Security regression: externally-supplied identifiers (table + column names)
 * are rendered VERBATIM into DDL by `_ensureTable`/`addColumn`. Because some
 * DDL runs with an empty params array (Postgres simple-query protocol), a `;`
 * in any of those fields stacks a second statement — e.g.
 * `CREATE TABLE …); DROP TABLE __lattice_users; --`.
 *
 * Fix: `assertSafeIdentifier` / `assertExternalIdentifier` (src/schema/identifier.ts)
 * as a universal DDL backstop, enforced inside `Lattice.addColumn` and the CRUD
 * table/column creation paths before any DDL is built.
 */
describe('SQL identifier safety', () => {
  describe('assertSafeIdentifier', () => {
    it('accepts ordinary table/column names (incl. internal __lattice_ names)', () => {
      for (const ok of ['tasks', '_x', 'a1', 'col_name', '__lattice_migrations']) {
        expect(() => assertSafeIdentifier(ok)).not.toThrow();
        expect(isSafeIdentifier(ok)).toBe(true);
      }
    });

    it('rejects names that could break out of double-quote quoting', () => {
      for (const bad of [
        'a"; DROP TABLE x; --',
        'a b',
        'a;b',
        'a)',
        '1col',
        '',
        'na-me',
        'tab"le',
      ]) {
        expect(() => assertSafeIdentifier(bad)).toThrow(/Invalid/);
        expect(isSafeIdentifier(bad)).toBe(false);
      }
    });

    it('rejects non-string input', () => {
      expect(() => assertSafeIdentifier(undefined)).toThrow(/Invalid/);
      expect(() => assertSafeIdentifier(42 as unknown)).toThrow(/Invalid/);
    });
  });

  describe('assertExternalIdentifier', () => {
    it('additionally rejects the reserved _lattice_/__lattice_ prefixes', () => {
      expect(() => assertExternalIdentifier('__lattice_users', 'table')).toThrow(/Reserved/);
      expect(() => assertExternalIdentifier('_lattice_secret', 'table')).toThrow(/Reserved/);
      expect(() => assertExternalIdentifier('__LATTICE_users', 'table')).toThrow(/Reserved/);
      // A normal externally-supplied name still passes.
      expect(() => assertExternalIdentifier('tasks', 'table')).not.toThrow();
    });
  });

  describe('Lattice.addColumn backstop', () => {
    let db: Lattice | undefined;
    afterEach(() => {
      db?.close();
      db = undefined;
    });

    it('rejects a malicious column name', async () => {
      db = new Lattice(':memory:');
      db.define('widgets', {
        columns: { id: 'TEXT PRIMARY KEY' },
        render: () => '',
        outputFile: 'w.md',
      });
      await db.init();
      await expect(db.addColumn('widgets', 'c"); DROP TABLE x; --', 'TEXT')).rejects.toThrow(
        /Invalid/,
      );
    });
  });

  describe('CRUD table/column backstop', () => {
    let db: Lattice | undefined;
    afterEach(() => {
      db?.close();
      db = undefined;
    });

    it('rejects a malicious table name on insert / query / upsertBy', async () => {
      db = new Lattice(':memory:');
      db.define('widgets', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: () => '',
        outputFile: 'w.md',
      });
      await db.init();
      const evil = 'widgets"); DROP TABLE __lattice_users; --';
      await expect(db.insert(evil, { id: 'a' })).rejects.toThrow(/Invalid/);
      await expect(db.query(evil)).rejects.toThrow(/Invalid/);
      await expect(db.upsertBy('widgets', 'na"me', 'x', { id: 'a' })).rejects.toThrow(/Invalid/);
      // Legitimate operations still work.
      await expect(db.insert('widgets', { id: 'a', name: 'ok' })).resolves.toBe('a');
      expect((await db.query('widgets')).length).toBe(1);
    });
  });
});
