/**
 * A searchable table with a number in it, on Postgres.
 *
 * `fts: true` picks the indexed columns by NAME — it skips identifiers and
 * bookkeeping and takes everything else — so a table with an amount, a count or a
 * flag has a non-text column in its index as a matter of course. That is the
 * ordinary table, not an exotic one: it is what importing a spreadsheet produces.
 *
 * The index body is text, and SQLite converts on concatenation, so this shape has
 * always built cleanly on a local workspace. Postgres will not coalesce a number
 * with an empty string, so the same declaration used to open locally and then
 * fail to open on a shared database — the worst version of a dialect gap, because
 * the failure lands at the moment somebody moves their work somewhere shared.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import { fullTextSearch } from '../../src/search/fts.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('full-text index over non-text columns (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_expenses`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        description: 'TEXT',
        amount: 'INTEGER',
        approved: 'BOOLEAN',
        deleted_at: 'TEXT',
      },
      // Exactly what `fts: true` resolves to for this table: every column that is
      // not an identifier or bookkeeping, whatever its type.
      fts: true,
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "__lattice_fts_${table}" CASCADE`);
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('builds the index, keeps it current, and finds the row', async () => {
    // The insert exercises the trigger that maintains the index — the same
    // expression, so a cast that only fixed the backfill would fail here.
    await db.insert(table, {
      id: 'e1',
      description: 'Coffee beans for the office',
      amount: 42,
      approved: true,
    });

    const hit = await fullTextSearch(db.adapter, [table], { query: 'coffee' });
    expect(hit.groups[0]?.hits.map((h) => h.id)).toEqual(['e1']);

    // And the number itself is indexed as its text, which is what casting means
    // here — not that the column was quietly dropped from the index.
    const byAmount = await fullTextSearch(db.adapter, [table], { query: '42' });
    expect(byAmount.groups[0]?.hits.map((h) => h.id)).toEqual(['e1']);
  });
});
