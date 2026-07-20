import { describe, expect, it } from 'vitest';
import {
  columnLetter,
  dominantPattern,
  normalizeRowFormula,
  translatePattern,
  type ColumnFormulaStats,
  type TranslateColumn,
} from '../../src/import/formula.js';
import { parseCalcExpr } from '../../src/schema/calc-expr.js';

/** A realistic order-line column layout for translation tests. */
const COLS: Record<string, TranslateColumn> = {
  A: { name: 'sku', type: 'text' },
  B: { name: 'unit_price', type: 'real' },
  C: { name: 'qty', type: 'integer' },
  D: { name: 'amount', type: 'real' },
  E: { name: 'discount', type: 'real' },
  F: { name: 'q1', type: 'real' },
  G: { name: 'q2', type: 'real' },
  H: { name: 'q3', type: 'real' },
  I: { name: 'region', type: 'text' },
};

/** Translate + assert the result parses under the calc-expr grammar. */
function translated(pattern: string, cols: Record<string, TranslateColumn> = COLS): string {
  const sql = translatePattern(pattern, cols);
  expect(sql, `pattern ${pattern} should translate`).not.toBeNull();
  const names = new Set(Object.values(cols).map((c) => c.name));
  // The load-bearing invariant: every non-null translation must parse under
  // the sandboxed calc-expression grammar the computed-table engine compiles.
  expect(() =>
    parseCalcExpr(sql!, (path) => path.length === 1 && names.has(path[0] ?? '')),
  ).not.toThrow();
  return sql!;
}

describe('columnLetter', () => {
  it('maps 1-based indices to Excel letters', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(28)).toBe('AB');
  });
});

describe('normalizeRowFormula', () => {
  it('turns own-row refs into column tokens, uppercases functions, strips whitespace', () => {
    expect(normalizeRowFormula('B2*C2', 2)).toBe('[B]*[C]');
    expect(normalizeRowFormula('b12 * c12', 12)).toBe('[B]*[C]');
    expect(normalizeRowFormula('if(D3 > 0, D3 / E3, 0)', 3)).toBe('IF([D]>0,[D]/[E],0)');
    expect(normalizeRowFormula('round(B5*0.21, 2)', 5)).toBe('ROUND([B]*0.21,2)');
    expect(normalizeRowFormula('sum(F2:H2)', 2)).toBe('SUM([F]:[H])');
    // Whitespace inside a string literal is preserved.
    expect(normalizeRowFormula('A2 & " — " & I2', 2)).toBe('[A]&" — "&[I]');
    expect(normalizeRowFormula('TRUE', 2)).toBe('TRUE');
  });

  it('produces the same pattern for the same formula on different rows', () => {
    expect(normalizeRowFormula('B2*C2', 2)).toBe(normalizeRowFormula('B9*C9', 9));
  });

  it('rejects anything not row-local', () => {
    expect(normalizeRowFormula('B1+C2', 2)).toBeNull(); // other-row ref
    expect(normalizeRowFormula('$B$2*C2', 2)).toBeNull(); // anchored
    expect(normalizeRowFormula('B$2*C2', 2)).toBeNull(); // half-anchored
    expect(normalizeRowFormula('Sheet1!A2', 2)).toBeNull(); // sheet-qualified
    expect(normalizeRowFormula("'My Sheet'!A2*2", 2)).toBeNull(); // quoted sheet
    expect(normalizeRowFormula('SUM(B2:B10)', 2)).toBeNull(); // cross-row range
    expect(normalizeRowFormula('B2*TaxRate', 2)).toBeNull(); // named range
    expect(normalizeRowFormula('[@Amount]*2', 2)).toBeNull(); // structured ref
    expect(normalizeRowFormula('SUM(Table1[Qty])', 2)).toBeNull(); // structured ref
  });

  it('allows a same-row range only directly inside SUM', () => {
    expect(normalizeRowFormula('F2:H2', 2)).toBeNull();
    expect(normalizeRowFormula('ROUND(F2:H2)', 2)).toBeNull();
    expect(normalizeRowFormula('SUM((F2:H2))', 2)).toBeNull(); // bare parens in between
    expect(normalizeRowFormula('SUM(F2:H2)', 2)).toBe('SUM([F]:[H])');
  });
});

describe('dominantPattern', () => {
  const stats = (
    total: number,
    formulaRows: number,
    patterns: Record<string, number>,
  ): ColumnFormulaStats => ({ total, formulaRows, patterns, example: 'B2*C2' });

  it('requires at least two formula rows', () => {
    expect(dominantPattern(stats(2, 1, { '[B]*[C]': 1 }))).toBeNull();
    expect(dominantPattern(stats(2, 2, { '[B]*[C]': 2 }))).toBe('[B]*[C]');
  });

  it('requires one pattern to cover ≥ 90% of the column data rows', () => {
    expect(dominantPattern(stats(10, 9, { '[B]*[C]': 9 }))).toBe('[B]*[C]');
    expect(dominantPattern(stats(10, 8, { '[B]*[C]': 8 }))).toBeNull(); // 80%
    // Rows whose formula normalized to null (unsupported) dilute dominance.
    expect(dominantPattern(stats(10, 10, { '[B]*[C]': 5, '[B]+[C]': 5 }))).toBeNull();
  });
});

describe('translatePattern', () => {
  it('translates arithmetic with a zero-guarded division', () => {
    expect(translated('[B]*[C]')).toBe('(unit_price * qty)');
    expect(translated('[D]-[E]')).toBe('(amount - discount)');
    expect(translated('[D]/[C]')).toBe('(amount / NULLIF(qty, 0))');
    expect(translated('-[E]')).toBe('(-discount)');
    expect(translated('([B]+[E])*[C]')).toBe('((unit_price + discount) * qty)');
    expect(translated('1.5*[C]')).toBe('(1.5 * qty)');
  });

  it('translates & and CONCATENATE over text operands only', () => {
    expect(translated('[A]&" x "&[I]')).toBe("((sku || ' x ') || region)");
    expect(translated('CONCATENATE([A],"-",[I])')).toBe("(sku || '-' || region)");
    // A numeric operand fails the text guard — Excel's display coercion is not SQL's.
    expect(translatePattern('[A]&[B]', COLS)).toBeNull();
    expect(translatePattern('CONCATENATE([A],[C])', COLS)).toBeNull();
  });

  it('translates IF to CASE WHEN, including nesting', () => {
    expect(translated('IF([D]>100,"big","small")')).toBe(
      "CASE WHEN (amount > 100) THEN 'big' ELSE 'small' END",
    );
    expect(translated('IF([D]>100,IF([D]>1000,"huge","big"),"small")')).toBe(
      "CASE WHEN (amount > 100) THEN CASE WHEN (amount > 1000) THEN 'huge' ELSE 'big' END ELSE 'small' END",
    );
    expect(translatePattern('IF([D]>100,"big")', COLS)).toBeNull(); // 2-arg IF
  });

  it('translates AND/OR/NOT and comparisons', () => {
    expect(translated('IF(AND([B]>0,[C]>0),1,0)')).toBe(
      'CASE WHEN ((unit_price > 0) AND (qty > 0)) THEN 1 ELSE 0 END',
    );
    expect(translated('IF(OR([C]=0,[E]<>0),1,0)')).toBe(
      'CASE WHEN ((qty = 0) OR (discount <> 0)) THEN 1 ELSE 0 END',
    );
    expect(translated('IF(NOT([C]>=1),1,0)')).toBe('CASE WHEN (NOT (qty >= 1)) THEN 1 ELSE 0 END');
  });

  it('translates ROUND and ABS', () => {
    expect(translated('ROUND([B]*[C],2)')).toBe('ROUND((unit_price * qty), 2)');
    expect(translated('ABS([D]-[E])')).toBe('ABS((amount - discount))');
  });

  it('expands SUM over a same-row range to a NULL-safe addition', () => {
    expect(translated('SUM([F]:[H])')).toBe(
      '(COALESCE(q1, 0) + COALESCE(q2, 0) + COALESCE(q3, 0))',
    );
    expect(translated('SUM([F],[H])')).toBe('(COALESCE(q1, 0) + COALESCE(q3, 0))');
    expect(translatePattern('SUM([B]*[C])', COLS)).toBeNull(); // expressions out of scope
  });

  it('returns null for anything outside the allowlist', () => {
    expect(translatePattern('VLOOKUP([A],[B],2)', COLS)).toBeNull(); // unknown function
    expect(translatePattern('[B]^2', COLS)).toBeNull(); // ^ operator
    expect(translatePattern('[B]*10%', COLS)).toBeNull(); // percent literal
    expect(translatePattern('[Z]*2', COLS)).toBeNull(); // unmapped column
  });

  it('returns null when a mapped column name cannot be expressed in the grammar', () => {
    // 'end' is a calc-expr keyword — the emitted identifier would not parse,
    // so the round-trip check refuses the translation instead of shipping it.
    const cols: Record<string, TranslateColumn> = { B: { name: 'end', type: 'real' } };
    expect(translatePattern('[B]*2', cols)).toBeNull();
  });
});
