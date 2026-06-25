import { afterEach, describe, expect, it } from 'vitest';
import { toTransactionPoolerUrl } from '../../src/db/postgres.js';

/**
 * The query pool routes through Supabase's TRANSACTION-mode pooler (:6543) instead
 * of the session-mode pooler (:5432), so a small `pool_size` isn't exhausted by
 * the pool + the realtime LISTEN client + a burst (which surfaced as
 * `EMAXCONNSESSION`). The rewrite must be surgical: only a Supabase pooler host on
 * :5432, host:port only, everything else untouched.
 */
describe('toTransactionPoolerUrl', () => {
  const SAVED = process.env.LATTICE_PG_SESSION_POOLER;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.LATTICE_PG_SESSION_POOLER;
    else process.env.LATTICE_PG_SESSION_POOLER = SAVED;
  });

  it('bumps a Supabase session pooler (:5432) to the transaction pooler (:6543)', () => {
    expect(
      toTransactionPoolerUrl(
        'postgres://postgres.abcdef:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres',
      ),
    ).toBe('postgres://postgres.abcdef:pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres');
  });

  it('preserves userinfo, db, and query params (only host:port changes)', () => {
    expect(
      toTransactionPoolerUrl(
        'postgres://u:p%40ss5432@aws-0-eu-west-2.pooler.supabase.com:5432/db?sslmode=require',
      ),
    ).toBe('postgres://u:p%40ss5432@aws-0-eu-west-2.pooler.supabase.com:6543/db?sslmode=require');
  });

  it('leaves an already-transaction-pooler URL (:6543) untouched', () => {
    const url = 'postgres://x:y@aws-1-us-east-1.pooler.supabase.com:6543/postgres';
    expect(toTransactionPoolerUrl(url)).toBe(url);
  });

  it('leaves a DIRECT Supabase connection (not a pooler host) untouched', () => {
    const url = 'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres';
    expect(toTransactionPoolerUrl(url)).toBe(url);
  });

  it('leaves non-Supabase hosts untouched (local, CI, RDS, etc.)', () => {
    for (const url of [
      'postgres://lattice:lattice@localhost:5432/lattice_test',
      'postgres://u:p@127.0.0.1:5432/db',
      'postgres://u:p@mydb.123.us-east-1.rds.amazonaws.com:5432/db',
    ]) {
      expect(toTransactionPoolerUrl(url)).toBe(url);
    }
  });

  it('does not match a different port that merely starts with 5432 (e.g. :54321)', () => {
    const url = 'postgres://u:p@aws-1-us-east-1.pooler.supabase.com:54321/postgres';
    expect(toTransactionPoolerUrl(url)).toBe(url);
  });

  it('is disabled by the LATTICE_PG_SESSION_POOLER escape hatch', () => {
    process.env.LATTICE_PG_SESSION_POOLER = '1';
    const url = 'postgres://x:y@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
    expect(toTransactionPoolerUrl(url)).toBe(url);
  });
});
