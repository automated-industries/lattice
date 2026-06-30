import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { vectorIndexName } from '../../src/search/vector-index.js';

/**
 * Hostile-input matrix for the generic query surface.
 *
 * Every dynamic identifier the query builder interpolates (table, where/filter
 * columns, ORDER BY, GROUP BY, distinctOn, keyset cursor columns, aggregate
 * column/alias/function, the vector-index table) must be constrained to the bare
 * SQL identifier grammar BEFORE it reaches a SQL string — independent of the
 * column cache, which passes unregistered tables straight through. jsonPath is a
 * value, not an identifier, so it is parameterized (never interpolated) and must
 * be inert. These tests assert a malicious payload is rejected (or, for
 * jsonPath, made inert) on a REGISTERED table and — critically — on an
 * UNREGISTERED one, where only the grammar floor protects it.
 */
describe('query identifier safety (injection matrix)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  // Each contains a character outside [A-Za-z_][A-Za-z0-9_]* — a quote, space,
  // paren, or semicolon that would otherwise break out of a quoted identifier.
  const PAYLOADS = [
    'x" UNION SELECT secret_value FROM secrets --',
    'x"); DROP TABLE items; --',
    'x" = "x',
    'name FROM secrets; --',
  ];

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        status: 'TEXT',
        priority: 'INTEGER',
        total: 'REAL',
        meta: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'i.md',
    });
    db.define('secrets', {
      columns: { id: 'TEXT PRIMARY KEY', secret_value: 'TEXT' },
      render: () => '',
      outputFile: 's.md',
    });
    await db.init();
    await db.insert('items', { id: 'i1', name: 'a', status: 'open', priority: 5, total: 1 });
    await db.insert('secrets', { id: 's1', secret_value: 'TOPSECRET' });
    return db;
  }

  // Identifier sinks: each call must REJECT rather than execute the payload.
  // `table` selects 'items' (registered → cache rejects unknown cols) and an
  // arbitrary UNREGISTERED name (cache passes through → only the grammar floor
  // protects it). Both must reject.
  for (const table of ['items', 'unregistered_t']) {
    describe(`on ${table === 'items' ? 'a registered' : 'an UNREGISTERED'} table`, () => {
      for (const p of PAYLOADS) {
        it(`rejects a hostile where column`, async () => {
          const d = await setup();
          await expect(d.query(table, { where: { [p]: 'x' } })).rejects.toThrow();
        });

        it(`rejects a hostile filter column`, async () => {
          const d = await setup();
          await expect(
            d.query(table, { filters: [{ col: p, op: 'eq', val: 'x' }] }),
          ).rejects.toThrow();
        });

        it(`rejects a hostile orderBy`, async () => {
          const d = await setup();
          await expect(d.query(table, { orderBy: p })).rejects.toThrow();
        });

        it(`rejects a hostile distinctOn`, async () => {
          const d = await setup();
          await expect(d.query(table, { distinctOn: p })).rejects.toThrow();
        });

        it(`rejects a hostile count where column`, async () => {
          const d = await setup();
          await expect(d.count(table, { where: { [p]: 'x' } })).rejects.toThrow();
        });

        it(`rejects a hostile boundedCount where column`, async () => {
          const d = await setup();
          await expect(d.boundedCount(table, { where: { [p]: 'x' } })).rejects.toThrow();
        });

        it(`rejects a hostile queryPage orderBy`, async () => {
          const d = await setup();
          await expect(d.queryPage(table, { orderBy: p })).rejects.toThrow();
        });
      }
    });
  }

  // A hostile TABLE name itself.
  it('rejects a hostile table name', async () => {
    const d = await setup();
    for (const p of PAYLOADS) {
      await expect(d.query(p, {})).rejects.toThrow();
      await expect(d.count(p, {})).rejects.toThrow();
      await expect(d.boundedCount(p, {})).rejects.toThrow();
    }
  });

  // Aggregate-specific sinks the column cache never covers: alias, function name,
  // ORDER BY. Each must reject.
  describe('aggregate', () => {
    it('rejects a hostile aggregate alias (as)', async () => {
      const d = await setup();
      for (const p of PAYLOADS) {
        await expect(
          d.aggregate('items', { aggregates: [{ fn: 'count', as: p }] }),
        ).rejects.toThrow();
      }
    });

    it('rejects a non-whitelisted aggregate function', async () => {
      const d = await setup();
      for (const fn of ['COUNT(*)),(SELECT secret_value FROM secrets', 'EVIL', 'sum); DROP']) {
        await expect(
          d.aggregate('items', { aggregates: [{ fn: fn as never, col: 'total', as: 'n' }] }),
        ).rejects.toThrow();
      }
    });

    it('rejects a hostile aggregate orderBy', async () => {
      const d = await setup();
      for (const p of PAYLOADS) {
        await expect(
          d.aggregate('items', { aggregates: [{ fn: 'count', as: 'n' }], orderBy: p }),
        ).rejects.toThrow();
      }
    });

    it('rejects a hostile groupBy column', async () => {
      const d = await setup();
      for (const p of PAYLOADS) {
        await expect(
          d.aggregate('items', { aggregates: [{ fn: 'count', as: 'n' }], groupBy: [p] }),
        ).rejects.toThrow();
      }
    });
  });

  // jsonPath is a VALUE, bound as a parameter — never interpolated — so a hostile
  // path is inert: it must not execute and must not exfiltrate the secret.
  it('makes a hostile jsonPath inert (parameterized, no leak)', async () => {
    const d = await setup();
    await d.insert('items', { id: 'i2', name: 'b', meta: JSON.stringify({ tier: 'gold' }) });
    for (const p of [
      "tier') UNION SELECT secret_value FROM secrets --",
      'a"; DROP TABLE items; --',
    ]) {
      const rows = await d
        .query('items', { filters: [{ col: 'meta', jsonPath: p, op: 'eq', val: 'gold' }] })
        .catch(() => [] as unknown[]);
      expect(JSON.stringify(rows)).not.toContain('TOPSECRET');
    }
    // The secrets table is intact (no DDL injection executed anywhere above).
    expect(await d.count('secrets', {})).toBe(1);
    expect(await d.count('items', {})).toBeGreaterThan(0);
  });

  // The native vector-index name is interpolated into DDL; guard the table there.
  it('rejects a hostile table in vectorIndexName', () => {
    for (const p of PAYLOADS) {
      expect(() => vectorIndexName(p)).toThrow();
    }
  });
});
