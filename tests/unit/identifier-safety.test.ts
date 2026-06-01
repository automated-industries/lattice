import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  assertSafeIdentifier,
  assertExternalIdentifier,
  isSafeIdentifier,
} from '../../src/schema/identifier.js';
import {
  validateExternalSchemaSpec,
  applySchemaSpec,
  type SchemaSpec,
} from '../../src/teams/schema-spec.js';

/**
 * Security regression: a Team object-share request supplies `table` + a
 * `schema_spec` (column names, types, defaults, constraints) that are rendered
 * VERBATIM into DDL by `applySchemaSpec` → `_ensureTable`/`addColumn`. Because
 * some DDL runs with an empty params array (Postgres simple-query protocol), a
 * `;` in any of those fields stacks a second statement — e.g.
 * `CREATE TABLE …); DROP TABLE __lattice_users; --`. Any authenticated team
 * member could trigger it across the multi-tenant cloud boundary.
 *
 * Fix: `assertSafeIdentifier` / `assertExternalIdentifier` (src/schema/identifier.ts)
 * as a universal DDL backstop, plus `validateExternalSchemaSpec` at the
 * `applySchemaSpec` trust boundary validating identifiers + types + defaults +
 * constraints before any DDL is built.
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

  describe('validateExternalSchemaSpec', () => {
    const okSpec: SchemaSpec = {
      columns: {
        id: { type: 'TEXT', pk: true },
        title: { type: 'TEXT', notNull: true },
        status: { type: 'TEXT', default: "'open'" },
        score: { type: 'INTEGER', default: '0' },
      },
      primaryKey: 'id',
      schemaVersion: 1,
    };

    const check = (table: string, spec: SchemaSpec) => () => {
      validateExternalSchemaSpec(table, spec);
    };

    it('accepts a legitimate spec', () => {
      expect(check('tasks', okSpec)).not.toThrow();
    });

    it('rejects a malicious table name', () => {
      expect(check('tasks"); DROP TABLE __lattice_users; --', okSpec)).toThrow();
    });

    it('rejects a malicious column name', () => {
      const spec: SchemaSpec = {
        ...okSpec,
        columns: { ...okSpec.columns, ['x"); DROP TABLE y; --']: { type: 'TEXT' } },
      };
      expect(check('tasks', spec)).toThrow();
    });

    it('rejects an unknown column type injected via JSON', () => {
      const spec = {
        columns: { id: { type: 'TEXT); DROP TABLE z; --' } },
        primaryKey: 'id',
        schemaVersion: 1,
      } as unknown as SchemaSpec;
      expect(check('tasks', spec)).toThrow(/Invalid column type/);
    });

    it('rejects an unsafe column default (statement stacking)', () => {
      const spec: SchemaSpec = {
        ...okSpec,
        columns: { ...okSpec.columns, status: { type: 'TEXT', default: "'a'); DROP TABLE q; --" } },
      };
      expect(check('tasks', spec)).toThrow(/Unsafe column default/);
    });

    it('accepts conventional defaults (NULL, numbers, quoted strings, datetime())', () => {
      for (const d of ['NULL', '0', '-3.14', "'draft'", 'CURRENT_TIMESTAMP', "(datetime('now'))"]) {
        const spec: SchemaSpec = {
          ...okSpec,
          columns: { ...okSpec.columns, status: { type: 'TEXT', default: d } },
        };
        expect(check('tasks', spec)).not.toThrow();
      }
    });

    it('rejects an unsafe table constraint', () => {
      const spec: SchemaSpec = {
        ...okSpec,
        tableConstraints: ['UNIQUE ("id")); DROP TABLE r; --'],
      };
      expect(check('tasks', spec)).toThrow(/Unsafe table constraint/);
    });

    it('accepts a conventional UNIQUE constraint', () => {
      const spec: SchemaSpec = { ...okSpec, tableConstraints: ['UNIQUE ("title")'] };
      expect(check('tasks', spec)).not.toThrow();
    });
  });

  describe('applySchemaSpec end-to-end (the choke point)', () => {
    let db: Lattice | undefined;
    afterEach(() => {
      db?.close();
      db = undefined;
    });

    it('throws on a malicious spec BEFORE creating any table', async () => {
      db = new Lattice(':memory:');
      await db.init();
      const evil = {
        columns: { id: { type: 'TEXT', pk: true } },
        primaryKey: 'id',
        schemaVersion: 1,
      } as SchemaSpec;
      await expect(
        applySchemaSpec(db, 'evil"); DROP TABLE __lattice_users; --', evil),
      ).rejects.toThrow();
    });

    it('still applies a legitimate spec', async () => {
      db = new Lattice(':memory:');
      await db.init();
      const spec: SchemaSpec = {
        columns: { id: { type: 'TEXT', pk: true }, name: { type: 'TEXT' } },
        primaryKey: 'id',
        schemaVersion: 1,
      };
      await expect(applySchemaSpec(db, 'widgets', spec)).resolves.toBe(true);
      const cols = await db.introspectColumns('widgets');
      expect(cols).toContain('id');
      expect(cols).toContain('name');
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
