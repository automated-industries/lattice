import { describe, it, expect } from 'vitest';
import {
  _rewriteForTest as rewrite,
  _translateDialectForTest as translateDialect,
} from '../../src/db/postgres.js';

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
    expect(rewrite(`INSERT INTO t VALUES (${params})`)).toBe(`INSERT INTO t VALUES (${expected})`);
  });
});

describe('PostgresAdapter — INSERT OR IGNORE translation', () => {
  it('rewrites OR IGNORE to ON CONFLICT DO NOTHING', () => {
    expect(translateDialect('INSERT OR IGNORE INTO t (a) VALUES (1)')).toBe(
      'INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING',
    );
  });

  it('preserves trailing semicolon', () => {
    expect(translateDialect('INSERT OR IGNORE INTO t (a) VALUES (1);')).toBe(
      'INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING;',
    );
  });

  it('does not double-append ON CONFLICT when already present', () => {
    const sql = 'INSERT OR IGNORE INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2';
    expect(translateDialect(sql)).toBe(
      'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2',
    );
  });

  it('handles multi-line INSERT OR IGNORE', () => {
    const sql = `INSERT OR IGNORE INTO t (a, b)
VALUES (1, 2)`;
    expect(translateDialect(sql)).toBe(`INSERT INTO t (a, b)
VALUES (1, 2) ON CONFLICT DO NOTHING`);
  });

  it('case-insensitive OR IGNORE keyword matching (output normalizes to uppercase)', () => {
    // The translator normalizes the matched fragment to canonical SQL case
    // (`INSERT INTO`) so it's easy to grep for. The rest of the statement
    // keeps its original case.
    expect(translateDialect('insert or ignore into t (a) values (1)')).toBe(
      'INSERT INTO t (a) values (1) ON CONFLICT DO NOTHING',
    );
  });
});

describe('PostgresAdapter — randomblob and hex translations', () => {
  it('translates randomblob(N) to gen_random_bytes(N)', () => {
    expect(translateDialect('SELECT randomblob(16)')).toBe('SELECT gen_random_bytes(16)');
  });

  it('translates hex(<expr>) to encode(<expr>, hex)', () => {
    expect(translateDialect("SELECT hex('abc')")).toBe("SELECT encode('abc', 'hex')");
  });

  it('translates the lower(hex(randomblob(N))) UUID-id pattern composite', () => {
    expect(translateDialect('SELECT lower(hex(randomblob(16)))')).toBe(
      "SELECT lower(encode(gen_random_bytes(16), 'hex'))",
    );
  });

  it('translates the dashed-UUID composite from migrations.ts', () => {
    const sql =
      "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))";
    const expected =
      "lower(encode(gen_random_bytes(4), 'hex') || '-' || encode(gen_random_bytes(2), 'hex') || '-' || encode(gen_random_bytes(2), 'hex') || '-' || encode(gen_random_bytes(2), 'hex') || '-' || encode(gen_random_bytes(6), 'hex'))";
    expect(translateDialect(sql)).toBe(expected);
  });

  it('case-insensitive matching of randomblob and hex', () => {
    expect(translateDialect('SELECT HEX(RANDOMBLOB(16))')).toBe(
      "SELECT encode(gen_random_bytes(16), 'hex')",
    );
  });

  // Note: hex() and randomblob() translations span string boundaries (so a
  // call like hex('abc') translates correctly). The tradeoff is that the
  // literal text "hex(...)" inside a single-quoted user string IS rewritten.
  // Documented limitation; the alternative (string-aware function-name
  // matching) breaks the common hex(stringLiteralArgument) case. Real
  // migrations virtually never store SQL function names inside data strings.
});

describe('PostgresAdapter — datetime() translation', () => {
  it("translates datetime('now') to NOW()", () => {
    expect(translateDialect("SELECT datetime('now')")).toBe('SELECT NOW()');
  });

  it('translates datetime inside UPDATE SET', () => {
    expect(translateDialect("UPDATE t SET deleted_at = datetime('now') WHERE id = ?")).toBe(
      'UPDATE t SET deleted_at = NOW() WHERE id = ?',
    );
  });

  it('throws on any datetime() form other than now', () => {
    expect(() => translateDialect("SELECT datetime('2024-01-01', '+1 day')")).toThrowError(
      /not auto-translated/,
    );
  });
});

describe('PostgresAdapter — CREATE VIEW IF NOT EXISTS translation', () => {
  it('rewrites CREATE VIEW IF NOT EXISTS to CREATE OR REPLACE VIEW', () => {
    expect(
      translateDialect(
        'CREATE VIEW IF NOT EXISTS memory_entries AS SELECT * FROM knowledge_entries',
      ),
    ).toBe('CREATE OR REPLACE VIEW memory_entries AS SELECT * FROM knowledge_entries');
  });

  it('normalizes to uppercase CREATE OR REPLACE VIEW regardless of input case', () => {
    // Same case-normalization policy as INSERT OR IGNORE — the translated
    // fragment uses canonical SQL keyword case.
    expect(translateDialect('create view if not exists v AS SELECT 1')).toBe(
      'CREATE OR REPLACE VIEW v AS SELECT 1',
    );
  });

  it('does not touch CREATE TABLE IF NOT EXISTS', () => {
    // Only VIEWs are affected; TABLEs work fine in both dialects.
    expect(translateDialect('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)')).toBe(
      'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)',
    );
  });
});

describe('PostgresAdapter — INSERT OR REPLACE rejection', () => {
  it('throws a clear error rather than silently mistranslating', () => {
    expect(() => translateDialect('INSERT OR REPLACE INTO t (a) VALUES (1)')).toThrowError(
      /not auto-translated/,
    );
  });
});

describe('PostgresAdapter — composite end-to-end (translateDialect + rewriteParams)', () => {
  it('handles INSERT OR IGNORE + ? placeholders + randomblob default in one SQL', () => {
    const sql =
      'INSERT OR IGNORE INTO agent_project (id, agent_id, project_id) VALUES (lower(hex(randomblob(16))), ?, ?)';
    expect(rewrite(sql)).toBe(
      "INSERT INTO agent_project (id, agent_id, project_id) VALUES (lower(encode(gen_random_bytes(16), 'hex')), $1, $2) ON CONFLICT DO NOTHING",
    );
  });

  // Regression test for the mid-statement ON CONFLICT bug: the SELECT body
  // of an INSERT OR IGNORE ... SELECT contains string literals, which split
  // the SQL into multiple code regions in mapCodeRegions. The per-region
  // append would put ON CONFLICT DO NOTHING BEFORE the SELECT body, which
  // Postgres rejects with "syntax error near '<string literal>'". Fix: the
  // append runs at the whole-statement level, after all regions are walked.
  it('appends ON CONFLICT at the END of the full statement, not per code region', () => {
    const sql = `INSERT OR IGNORE INTO file (id, org_id, name, file_path, created_at)
      SELECT 'cee71dd7-6656-42b6-855d-9986210f5b43', id, 'Industry City Consulting Agreement (Final)', 'files/cee71dd7-.../name.docx', CURRENT_TIMESTAMP FROM org LIMIT 1`;
    const out = translateDialect(sql);
    // The last non-whitespace tokens should be FROM org LIMIT 1 ON CONFLICT DO NOTHING
    expect(out.trim().endsWith('FROM org LIMIT 1 ON CONFLICT DO NOTHING')).toBe(true);
    // And OR IGNORE should be gone
    expect(out).not.toMatch(/OR\s+IGNORE/i);
    // And the string literals should be preserved verbatim
    expect(out).toContain("'cee71dd7-6656-42b6-855d-9986210f5b43'");
    expect(out).toContain("'Industry City Consulting Agreement (Final)'");
  });
});
