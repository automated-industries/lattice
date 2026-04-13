import { describe, it, expect } from 'vitest';
import { _rewriteForTest as rewrite } from '../../src/db/postgres.js';

describe('PostgresAdapter — ?→$N rewrite', () => {
  it('numbers single placeholder', () => {
    expect(rewrite('SELECT * FROM t WHERE id = ?')).toBe('SELECT * FROM t WHERE id = $1');
  });

  it('numbers multiple placeholders sequentially', () => {
    expect(rewrite('UPDATE t SET a = ?, b = ? WHERE id = ?')).toBe(
      'UPDATE t SET a = $1, b = $2 WHERE id = $3',
    );
  });

  it('leaves ? inside single-quoted string literals alone', () => {
    expect(rewrite("INSERT INTO t (msg) VALUES ('hello? world')")).toBe(
      "INSERT INTO t (msg) VALUES ('hello? world')",
    );
  });

  it('handles doubled single-quote escape inside string literal', () => {
    expect(rewrite("INSERT INTO t (msg) VALUES ('it''s ?', ?)")).toBe(
      "INSERT INTO t (msg) VALUES ('it''s ?', $1)",
    );
  });

  it('leaves ? inside double-quoted identifiers alone', () => {
    expect(rewrite('SELECT "weird?col" FROM t WHERE x = ?')).toBe(
      'SELECT "weird?col" FROM t WHERE x = $1',
    );
  });

  it('leaves ? inside single-line comments alone', () => {
    const sql = 'SELECT * FROM t -- pick? rows\nWHERE id = ?';
    expect(rewrite(sql)).toBe('SELECT * FROM t -- pick? rows\nWHERE id = $1');
  });

  it('leaves ? inside block comments alone', () => {
    expect(rewrite('SELECT /* a?b */ ? FROM t')).toBe('SELECT /* a?b */ $1 FROM t');
  });

  it('preserves SQL with no placeholders unchanged', () => {
    expect(rewrite('SELECT 1')).toBe('SELECT 1');
  });

  it('handles 10+ placeholders without overflow', () => {
    const params = Array.from({ length: 12 }, () => '?').join(', ');
    const expected = Array.from({ length: 12 }, (_, i) => '$' + String(i + 1)).join(', ');
    expect(rewrite(`INSERT INTO t VALUES (${params})`)).toBe(
      `INSERT INTO t VALUES (${expected})`,
    );
  });
});
