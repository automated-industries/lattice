import { describe, it, expect } from 'vitest';

import {
  assertReadOnlySql,
  openExternalPool,
} from '../../src/connectors/db-source/external-pool.js';
import { assembleConnectionString } from '../../src/connectors/db-source/connector.js';

/**
 * External-database connections are READ-ONLY by contract — a data-source import
 * must never be able to write to the source. Guarded in depth: (1) every pooled
 * connection starts with default_transaction_read_only=on (covered by the gated
 * Postgres suite via SHOW), and (2) the pool wrapper refuses non-read statements
 * before they touch the network — asserted here with no database at all.
 */
describe('db-source read-only enforcement', () => {
  it('assertReadOnlySql allows read-shaped statements', () => {
    for (const sql of [
      'SELECT 1',
      '  select * from t',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW default_transaction_read_only',
      'EXPLAIN SELECT 1',
      '-- leading comment\nSELECT 1',
      '/* block */ SELECT 1',
    ]) {
      expect(() => {
        assertReadOnlySql(sql);
      }).not.toThrow();
    }
  });

  it('assertReadOnlySql refuses every write/DDL shape', () => {
    for (const sql of [
      "INSERT INTO t VALUES ('x')",
      "UPDATE t SET a = 'b'",
      'DELETE FROM t',
      'DROP TABLE t',
      'TRUNCATE t',
      'ALTER TABLE t ADD COLUMN c text',
      'CREATE TABLE t (id text)',
      'GRANT ALL ON t TO PUBLIC',
      'COPY t FROM STDIN',
      'SET default_transaction_read_only = off', // no un-read-onlying either
      '-- sneaky comment\nDROP TABLE t',
    ]) {
      expect(() => {
        assertReadOnlySql(sql);
      }).toThrow(/read-only/);
    }
  });

  it('the pool wrapper blocks a write before any network I/O', async () => {
    // pg.Pool connects lazily — the guard throws synchronously, so no server is
    // needed and nothing is ever dialed for a refused statement.
    const { pool, close } = openExternalPool('postgres://reader@localhost:1/db');
    try {
      expect(() => pool.query("INSERT INTO widgets VALUES ('w9')")).toThrow(/read-only/);
      expect(() => pool.query('DROP TABLE widgets')).toThrow(/read-only/);
    } finally {
      await close();
    }
  });

  it('assembleConnectionString takes fields only — URLs in Host are refused', () => {
    expect(
      assembleConnectionString({ host: 'db.example.com', user: 'reader', database: 'app' }),
    ).toBe('postgres://reader@db.example.com:5432/app');
    expect(() =>
      assembleConnectionString({ host: 'postgres://u:p@h:5432/db', user: 'u', database: 'db' }),
    ).toThrow(/host name only/i);
    // The removed connectionString key is no longer honored as a credential.
    expect(() =>
      assembleConnectionString({ connectionString: 'postgres://u:p@h:5432/db' }),
    ).toThrow(/host \+ user \+ database/i);
  });
});
