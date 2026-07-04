import { describe, it, expect } from 'vitest';
import { parseCalcExpr, emitCalcExpr, CalcExprError } from '../../src/schema/calc-expr.js';

// Resolver over a fixed set of allowed column paths (dotted form).
const COLS = new Set([
  'a',
  'b',
  'c',
  'title',
  'status',
  'priority',
  'estimate',
  'assignee.team.name',
]);

const parse = (src: string) => parseCalcExpr(src, (p) => COLS.has(p.join('.')));

// Emit with a synthetic path → SQL mapping so ref plumbing is visible in output.
const emit = (src: string, dialect: 'sqlite' | 'postgres' = 'sqlite') =>
  emitCalcExpr(parse(src), { dialect, columnSql: (p) => `"t"."${p.join('$')}"` });

describe('calc-expr — accepted grammar', () => {
  it('emits arithmetic with explicit precedence', () => {
    expect(emit('1 + 2 * 3')).toBe('(1 + (2 * 3))');
    expect(emit('(1 + 2) * 3')).toBe('((1 + 2) * 3)');
    expect(emit('10 % 3 - 1')).toBe('((10 % 3) - 1)');
    expect(emit('a / b')).toBe('("t"."a" / "t"."b")');
  });

  it('emits unary minus', () => {
    expect(emit('-a')).toBe('(-"t"."a")');
    expect(emit('1 - -2')).toBe('(1 - (-2))');
  });

  it('binds AND tighter than OR, NOT looser than comparison', () => {
    expect(emit('a OR b AND c')).toBe('("t"."a" OR ("t"."b" AND "t"."c"))');
    expect(emit('NOT a = b')).toBe('(NOT ("t"."a" = "t"."b"))');
  });

  it('normalizes != to <> and keeps all comparison operators', () => {
    expect(emit('a != b')).toBe('("t"."a" <> "t"."b")');
    expect(emit('a <> b')).toBe('("t"."a" <> "t"."b")');
    expect(emit('a <= b')).toBe('("t"."a" <= "t"."b")');
    expect(emit('priority >= 3')).toBe('("t"."priority" >= 3)');
  });

  it('binds || looser than + and tighter than comparison', () => {
    expect(emit('a + b || c')).toBe('(("t"."a" + "t"."b") || "t"."c")');
    expect(emit("a || 'x' = b")).toBe(`(("t"."a" || 'x') = "t"."b")`);
  });

  it('supports IS [NOT] NULL', () => {
    expect(emit('a IS NULL')).toBe('("t"."a" IS NULL)');
    expect(emit('a IS NOT NULL')).toBe('("t"."a" IS NOT NULL)');
  });

  it('supports [NOT] LIKE', () => {
    expect(emit("title LIKE 'x%'")).toBe(`("t"."title" LIKE 'x%')`);
    expect(emit("title NOT LIKE '%y'")).toBe(`("t"."title" NOT LIKE '%y')`);
  });

  it('supports IN with a literal list only', () => {
    expect(emit("status IN ('open', 'closed', 3, NULL, TRUE, -2)")).toBe(
      `("t"."status" IN ('open', 'closed', 3, NULL, TRUE, (-2)))`,
    );
    expect(emit("status NOT IN ('x')")).toBe(`("t"."status" NOT IN ('x'))`);
  });

  it('supports [NOT] BETWEEN', () => {
    expect(emit('priority BETWEEN 1 AND 3')).toBe('("t"."priority" BETWEEN 1 AND 3)');
    expect(emit('priority NOT BETWEEN a AND b')).toBe(
      '("t"."priority" NOT BETWEEN "t"."a" AND "t"."b")',
    );
  });

  it('supports searched CASE', () => {
    expect(emit("CASE WHEN priority >= 3 THEN 'high' ELSE 'low' END")).toBe(
      `(CASE WHEN ("t"."priority" >= 3) THEN 'high' ELSE 'low' END)`,
    );
    expect(emit('CASE WHEN a THEN 1 WHEN b THEN 2 END')).toBe(
      '(CASE WHEN "t"."a" THEN 1 WHEN "t"."b" THEN 2 END)',
    );
  });

  it('supports the function allowlist and normalizes IFNULL to COALESCE', () => {
    expect(emit('COALESCE(a, b, 0)')).toBe('COALESCE("t"."a", "t"."b", 0)');
    expect(emit("IFNULL(a, 'x')")).toBe(`COALESCE("t"."a", 'x')`);
    expect(emit('LOWER(UPPER(title))')).toBe('LOWER(UPPER("t"."title"))');
    expect(emit('SUBSTR(title, 1, 3)')).toBe('SUBSTR("t"."title", 1, 3)');
    expect(emit("REPLACE(title, 'a', 'b')")).toBe(`REPLACE("t"."title", 'a', 'b')`);
    expect(emit('ABS(estimate)')).toBe('ABS("t"."estimate")');
    expect(emit('NULLIF(a, b)')).toBe('NULLIF("t"."a", "t"."b")');
    expect(emit('TRIM(title)')).toBe('TRIM("t"."title")');
    expect(emit('LENGTH(title)')).toBe('LENGTH("t"."title")');
  });

  it('emits CAST with the three allowed target types', () => {
    expect(emit('CAST(a AS TEXT)')).toBe('CAST("t"."a" AS TEXT)');
    expect(emit('CAST(a AS integer)')).toBe('CAST("t"."a" AS INTEGER)');
    expect(emit('CAST(a AS Real)')).toBe('CAST("t"."a" AS REAL)');
  });

  it('emits two-argument ROUND per dialect', () => {
    expect(emit('ROUND(estimate, 2)', 'sqlite')).toBe('ROUND("t"."estimate", 2)');
    expect(emit('ROUND(estimate, 2)', 'postgres')).toBe(
      'ROUND(CAST("t"."estimate" AS NUMERIC), 2)',
    );
    // Single-argument ROUND is identical on both.
    expect(emit('ROUND(estimate)', 'postgres')).toBe('ROUND("t"."estimate")');
  });

  it('round-trips string escapes', () => {
    expect(emit("'it''s'")).toBe("'it''s'");
    expect(emit("a || 'x''y'''")).toBe(`("t"."a" || 'x''y''')`);
  });

  it('emits literals', () => {
    expect(emit('NULL')).toBe('NULL');
    expect(emit('TRUE')).toBe('TRUE');
    expect(emit('a = false')).toBe('("t"."a" = FALSE)');
    expect(emit('3.25')).toBe('3.25');
  });

  it('resolves dotted belongsTo paths through the resolver', () => {
    expect(emit('assignee.team.name')).toBe('"t"."assignee$team$name"');
    expect(parse('assignee.team.name').columnPaths).toEqual([['assignee', 'team', 'name']]);
  });

  it('collects unique column paths in first-appearance order', () => {
    const expr = parse('a + b + a + assignee.team.name');
    expect(expr.columnPaths).toEqual([['a'], ['b'], ['assignee', 'team', 'name']]);
  });

  it('keywords are case-insensitive', () => {
    expect(emit('a is not null and b like c')).toBe(
      '(("t"."a" IS NOT NULL) AND ("t"."b" LIKE "t"."c"))',
    );
  });
});

describe('calc-expr — rejected input (the injection boundary)', () => {
  const reject = (src: string, pattern: RegExp) => {
    expect(() => parse(src)).toThrowError(CalcExprError);
    expect(() => parse(src)).toThrow(pattern);
  };

  it('rejects classic injection payloads', () => {
    reject(`'; DROP TABLE x; --`, /unterminated string literal/);
    reject(`a; DROP TABLE x`, /';' is not allowed/);
    reject(`" FROM other`, /'"' is not allowed/);
  });

  it('rejects comment sequences', () => {
    reject('1 -- comment', /SQL comments/);
    reject('1 /* c */', /SQL comments/);
    reject('a--1', /SQL comments/);
  });

  it('rejects subqueries — SELECT has no production', () => {
    reject('(SELECT 1)', /unknown column reference "SELECT"|unexpected/);
    reject('a IN (SELECT b FROM t)', /expected a literal/);
  });

  it('rejects functions outside the allowlist', () => {
    reject("LOAD_EXTENSION('x')", /not allowed/);
    reject('RANDOMBLOB(16)', /not allowed/);
    reject('MAX(a)', /not allowed/); // aggregates are not expressions here
  });

  it('rejects bind parameters', () => {
    reject('a = ?', /bind parameters are not allowed/);
    reject('a = $1', /bind parameters are not allowed/);
  });

  it('rejects unresolved column references', () => {
    reject('nope', /unknown column reference "nope"/);
    reject('assignee.nope.name', /unknown column reference/);
  });

  it('rejects wrong arity, bad casts, chained comparisons, trailing input', () => {
    reject('LOWER(a, b)', /expects 1 argument/);
    reject('NULLIF(a)', /expects 2 argument/);
    reject('CAST(a AS BLOB)', /CAST target must be TEXT, INTEGER, or REAL/);
    reject('a = b = c', /unexpected trailing input/);
    reject('a NOT b', /unexpected trailing input/);
  });

  it('rejects the value-matching CASE form and empty input', () => {
    reject("CASE a WHEN 1 THEN 'x' END", /searched CASE form/);
    reject('   ', /non-empty/);
  });
});
