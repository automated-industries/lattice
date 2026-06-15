import { describe, it, expect } from 'vitest';
import { rowAccessSummaries } from '../../src/cloud/members.js';

/**
 * `rowAccessSummaries` builds the per-row `_access` the GUI attaches so the
 * sharing affordance renders (absent → the share UI is hidden, which is what
 * made cloud sharing "disappear" after the 3.0 RLS rewrite). It must:
 *  - return EMPTY off a secured cloud (SQLite, or PG without the RLS layer) so
 *    local workspaces show no share UI;
 *  - on a secured cloud, key visibility + ownedByMe per pk, with grantees for
 *    custom-shared rows.
 */
function pgDb(owners: unknown[], grants: unknown[], rlsInstalled = true) {
  return {
    getDialect: () => 'postgres',
    adapter: {
      getAsync: () => Promise.resolve(rlsInstalled ? { reg: '__lattice_owners' } : { reg: null }),
      // #2.1 — reads now go through SECURITY DEFINER functions (members have no
      // direct grant on the bookkeeping tables): lattice_rows_access /
      // lattice_row_grantees.
      allAsync: (sql: string) =>
        Promise.resolve(sql.includes('lattice_row_grantees') ? grants : owners),
    },
  } as never;
}

describe('3.1 — rowAccessSummaries (cloud sharing _access enrichment)', () => {
  it('returns an empty map for a SQLite workspace', async () => {
    const db = { getDialect: () => 'sqlite' } as never;
    expect((await rowAccessSummaries(db, 'contact', ['1', '2'])).size).toBe(0);
  });

  it('returns an empty map when no pks are requested', async () => {
    expect((await rowAccessSummaries(pgDb([], []), 'contact', [])).size).toBe(0);
  });

  it('returns an empty map on Postgres without the RLS layer installed', async () => {
    const m = await rowAccessSummaries(pgDb([], [], false), 'contact', ['1']);
    expect(m.size).toBe(0);
  });

  it('builds visibility + ownedByMe per row, with grantees for custom shares', async () => {
    const owners = [
      { pk: '1', visibility: 'everyone', owned: true },
      { pk: '2', visibility: 'private', owned: 't' }, // PG boolean as text tolerated
      { pk: '3', visibility: 'custom', owned: false },
    ];
    const grants = [
      { pk: '3', grantee_role: 'lm_alice' },
      { pk: '3', grantee_role: 'lm_bob' },
    ];
    const m = await rowAccessSummaries(pgDb(owners, grants), 'contact', ['1', '2', '3']);
    expect(m.get('1')).toEqual({ visibility: 'everyone', ownedByMe: true });
    expect(m.get('2')).toEqual({ visibility: 'private', ownedByMe: true });
    expect(m.get('3')).toEqual({
      visibility: 'custom',
      ownedByMe: false,
      grantees: ['lm_alice', 'lm_bob'],
    });
  });
});
