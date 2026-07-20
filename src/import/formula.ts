import { parseCalcExpr } from '../schema/calc-expr.js';

/**
 * Excel formula analysis for the structured importer: normalize row-local
 * formulas into per-column patterns, detect the dominant pattern of a column,
 * and translate that pattern into the sandboxed calc-expression grammar
 * (`schema/calc-expr.ts`) so a spreadsheet column that is computed the same way
 * on every row can be proposed as a computed-table `calc` field.
 *
 * Deliberately narrow: anything that is not a same-row scalar computation over
 * the table's own columns (other-row references, anchored/`$` references,
 * sheet-qualified references, named ranges, structured references, unknown
 * functions) normalizes or translates to `null` — no proposal is made, values
 * still import from the cached results. Pure module: no I/O.
 */

/** Formula usage of one sheet column, aggregated while the sheet is read. */
export interface ColumnFormulaStats {
  /** Data rows where this column carries anything (a value or a formula). */
  total: number;
  /** Data rows where this column's cell is a formula. */
  formulaRows: number;
  /** Normalized row-local pattern → occurrence count (≤ 8 distinct kept). */
  patterns: Record<string, number>;
  /** A raw example formula from the column (first one seen). */
  example: string;
}

/** 1-based sheet column index → Excel column letters (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel column letters → 1-based index (A → 1, AA → 27). */
function letterIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const CELL_REF = /^([A-Za-z]{1,3})(\d+)$/;

/**
 * Normalize a formula into a row-independent pattern: references to the
 * formula's OWN row become column tokens (`B12` at row 12 → `[B]`), function
 * names are uppercased, and whitespace outside string literals is stripped —
 * so the same per-row formula produces the same pattern on every row.
 *
 * Returns `null` for anything that is not row-local: other-row references,
 * `$`-anchored references, sheet-qualified references (`Sheet1!A1`),
 * cross-row ranges, named ranges, and structured references. A same-row range
 * (`F2:H2` at row 2 → `[F]:[H]`) is allowed only directly inside `SUM(...)`.
 */
export function normalizeRowFormula(formula: string, row: number): string | null {
  const src = formula;
  const n = src.length;
  let out = '';
  let i = 0;
  // Enclosing call stack — function name for a call's parens, '' for bare
  // parens — so the SUM-only range rule can check its direct context.
  const calls: string[] = [];
  while (i < n) {
    const ch = src.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"') {
      // Excel string literal ("" is the only escape) — preserved verbatim.
      let j = i + 1;
      for (;;) {
        if (j >= n) return null; // unterminated literal
        if (src.charAt(j) === '"') {
          if (src.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    // Not row-local / not translatable syntax: sheet-qualified refs (`!` and
    // the `'Sheet name'` quote), structured refs / array constants, anchors.
    if (ch === "'" || ch === '!' || ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      return null;
    }
    if (ch === '$') return null; // anchored reference — not row-relative
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(src.charAt(j))) j++;
      const word = src.slice(i, j);
      // Function call? (allow spaces between the name and its paren)
      let k = j;
      while (k < n && (src.charAt(k) === ' ' || src.charAt(k) === '\t')) k++;
      if (src.charAt(k) === '(') {
        out += word.toUpperCase() + '(';
        calls.push(word.toUpperCase());
        i = k + 1;
        continue;
      }
      const ref = CELL_REF.exec(word);
      if (ref) {
        const letters = (ref[1] ?? '').toUpperCase();
        if (Number(ref[2]) !== row) return null; // other-row reference
        if (src.charAt(j) === ':') {
          // Range — both endpoints must sit on the formula's own row, and a
          // row-local range only makes sense as a SUM argument.
          const second = CELL_REF.exec(/^[A-Za-z]{1,3}\d+/.exec(src.slice(j + 1))?.[0] ?? '');
          if (!second) return null; // anchored/malformed second endpoint
          if (Number(second[2]) !== row) return null; // cross-row range
          if (calls[calls.length - 1] !== 'SUM') return null;
          out += `[${letters}]:[${(second[1] ?? '').toUpperCase()}]`;
          i = j + 1 + second[0].length;
          continue;
        }
        out += `[${letters}]`;
        i = j;
        continue;
      }
      const upper = word.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        out += upper;
        i = j;
        continue;
      }
      return null; // bare identifier — a named range
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(src.charAt(j))) j++;
      if (src.charAt(j) === '.') {
        j++;
        while (j < n && /[0-9]/.test(src.charAt(j))) j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      out += two;
      i += 2;
      continue;
    }
    if ('+-*/&=<>,%^'.includes(ch)) {
      // Operators pass through; ones outside the translator's allowlist
      // (`%`, `^`) simply fail translation later.
      out += ch;
      i++;
      continue;
    }
    if (ch === '(') {
      out += ch;
      calls.push('');
      i++;
      continue;
    }
    if (ch === ')') {
      out += ch;
      calls.pop();
      i++;
      continue;
    }
    return null; // anything else (`;`, `#`, …) — unsupported syntax
  }
  return out;
}

/**
 * The single pattern that dominates a column's formulas: requires at least two
 * formula rows AND one pattern covering ≥ 90% of the column's data rows —
 * otherwise the column isn't consistently computed and no calc field should be
 * proposed for it.
 */
export function dominantPattern(stats: ColumnFormulaStats): string | null {
  if (stats.formulaRows < 2 || stats.total < 1) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [pattern, count] of Object.entries(stats.patterns)) {
    if (count > bestCount) {
      best = pattern;
      bestCount = count;
    }
  }
  if (best === null || bestCount / stats.total < 0.9) return null;
  return best;
}

/** A sheet column a pattern reference may resolve to: its materialized column. */
export interface TranslateColumn {
  /** Normalized column name on the materialized entity. */
  name: string;
  /** Inferred column type (`text`, `integer`, `real`, …). */
  type: string;
}

/** Internal sentinel for "this pattern is outside the translatable subset". */
class Untranslatable extends Error {}

interface TranslateValue {
  sql: string;
  /** True when the value is text-typed (string literal, text column, `&` result). */
  text: boolean;
}

type PatternToken =
  | { kind: 'num'; text: string }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; letters: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'fn'; name: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'op'; text: string }
  | { kind: 'end' };

/** Tokenize a normalized pattern (the constrained alphabet emitted above). */
function lexPattern(pattern: string): PatternToken[] {
  const out: PatternToken[] = [];
  const n = pattern.length;
  let i = 0;
  while (i < n) {
    const ch = pattern.charAt(i);
    if (ch === '[') {
      const m = /^\[([A-Z]{1,3})\](:\[([A-Z]{1,3})\])?/.exec(pattern.slice(i));
      if (!m) throw new Untranslatable();
      if (m[3] !== undefined) out.push({ kind: 'range', from: m[1] ?? '', to: m[3] });
      else out.push({ kind: 'ref', letters: m[1] ?? '' });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) throw new Untranslatable();
        if (pattern.charAt(j) === '"') {
          if (pattern.charAt(j + 1) === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += pattern.charAt(j);
        j++;
      }
      out.push({ kind: 'str', value });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(pattern.slice(i));
      out.push({ kind: 'num', text: m?.[0] ?? ch });
      i += m?.[0].length ?? 1;
      continue;
    }
    if (/[A-Z]/.test(ch)) {
      const m = /^[A-Z][A-Z0-9_.]*/.exec(pattern.slice(i));
      const word = m?.[0] ?? ch;
      i += word.length;
      if (pattern.charAt(i) === '(') {
        out.push({ kind: 'fn', name: word });
        i++; // the call's opening paren travels with the fn token
        continue;
      }
      if (word === 'TRUE' || word === 'FALSE') {
        out.push({ kind: 'bool', value: word === 'TRUE' });
        continue;
      }
      throw new Untranslatable();
    }
    const two = pattern.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      out.push({ kind: 'op', text: two });
      i += 2;
      continue;
    }
    if ('+-*/&=<>,()'.includes(ch)) {
      out.push({ kind: 'op', text: ch });
      i++;
      continue;
    }
    throw new Untranslatable(); // %, ^, stray :, …
  }
  out.push({ kind: 'end' });
  return out;
}

/**
 * Recursive-descent translator from a normalized pattern to the calc-expr
 * grammar, following Excel's operator precedence (comparison, then `&`, then
 * `+ -`, then `* /`, then unary minus).
 */
class PatternTranslator {
  private idx = 0;

  constructor(
    private readonly tokens: PatternToken[],
    private readonly columnMap: Record<string, TranslateColumn>,
  ) {}

  private peek(): PatternToken {
    return this.tokens[this.idx] ?? { kind: 'end' };
  }

  private next(): PatternToken {
    const tok = this.peek();
    if (tok.kind !== 'end') this.idx++;
    return tok;
  }

  private atOp(text: string): boolean {
    const tok = this.peek();
    return tok.kind === 'op' && tok.text === text;
  }

  private expectOp(text: string): void {
    if (!this.atOp(text)) throw new Untranslatable();
    this.next();
  }

  expectEnd(): void {
    if (this.peek().kind !== 'end') throw new Untranslatable();
  }

  private column(letters: string): TranslateColumn {
    const col = this.columnMap[letters];
    if (!col) throw new Untranslatable(); // ref outside the surviving columns
    return col;
  }

  parseExpr(): TranslateValue {
    const left = this.parseConcat();
    const tok = this.peek();
    if (tok.kind === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(tok.text)) {
      this.next();
      const right = this.parseConcat();
      return { sql: `(${left.sql} ${tok.text} ${right.sql})`, text: false };
    }
    return left;
  }

  private parseConcat(): TranslateValue {
    let left = this.parseAdditive();
    while (this.atOp('&')) {
      this.next();
      const right = this.parseAdditive();
      // `&` translates to `||` only over text operands — concatenating a
      // number differs between Excel's display text and SQL's coercion.
      if (!left.text || !right.text) throw new Untranslatable();
      left = { sql: `(${left.sql} || ${right.sql})`, text: true };
    }
    return left;
  }

  private parseAdditive(): TranslateValue {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.atOp('+') || this.atOp('-')) {
        const op = (this.next() as { text: string }).text;
        const right = this.parseMultiplicative();
        left = { sql: `(${left.sql} ${op} ${right.sql})`, text: false };
      } else {
        return left;
      }
    }
  }

  private parseMultiplicative(): TranslateValue {
    let left = this.parseUnary();
    for (;;) {
      if (this.atOp('*')) {
        this.next();
        const right = this.parseUnary();
        left = { sql: `(${left.sql} * ${right.sql})`, text: false };
      } else if (this.atOp('/')) {
        this.next();
        const right = this.parseUnary();
        // Division is zero-guarded: Excel's #DIV/0! becomes NULL, never an error.
        left = { sql: `(${left.sql} / NULLIF(${right.sql}, 0))`, text: false };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): TranslateValue {
    if (this.atOp('-')) {
      this.next();
      const value = this.parseUnary();
      return { sql: `(-${value.sql})`, text: false };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): TranslateValue {
    const tok = this.next();
    switch (tok.kind) {
      case 'num':
        return { sql: tok.text, text: false };
      case 'str':
        return { sql: `'${tok.value.replace(/'/g, "''")}'`, text: true };
      case 'bool':
        return { sql: tok.value ? 'TRUE' : 'FALSE', text: false };
      case 'ref': {
        const col = this.column(tok.letters);
        return { sql: col.name, text: col.type === 'text' };
      }
      case 'op':
        if (tok.text === '(') {
          const inner = this.parseExpr();
          this.expectOp(')');
          // No extra wrapping: every composite emission is already
          // parenthesized, so re-adding the source parens just stacks them.
          return inner;
        }
        throw new Untranslatable();
      case 'fn':
        return this.parseFunction(tok.name);
      default:
        throw new Untranslatable(); // range outside SUM, end of input, …
    }
  }

  /** Comma-separated argument expressions up to the call's closing paren. */
  private parseArgs(): TranslateValue[] {
    const args: TranslateValue[] = [this.parseExpr()];
    while (this.atOp(',')) {
      this.next();
      args.push(this.parseExpr());
    }
    this.expectOp(')');
    return args;
  }

  private parseFunction(name: string): TranslateValue {
    switch (name) {
      case 'IF': {
        const args = this.parseArgs();
        if (args.length !== 3) throw new Untranslatable();
        const [cond, then, otherwise] = args as [TranslateValue, TranslateValue, TranslateValue];
        return {
          sql: `CASE WHEN ${cond.sql} THEN ${then.sql} ELSE ${otherwise.sql} END`,
          text: then.text && otherwise.text,
        };
      }
      case 'AND':
      case 'OR': {
        const args = this.parseArgs();
        return { sql: `(${args.map((a) => a.sql).join(` ${name} `)})`, text: false };
      }
      case 'NOT': {
        const args = this.parseArgs();
        const arg = args.length === 1 ? args[0] : undefined;
        if (!arg) throw new Untranslatable();
        return { sql: `(NOT ${arg.sql})`, text: false };
      }
      case 'ROUND': {
        const args = this.parseArgs();
        if (args.length < 1 || args.length > 2) throw new Untranslatable();
        return { sql: `ROUND(${args.map((a) => a.sql).join(', ')})`, text: false };
      }
      case 'ABS': {
        const args = this.parseArgs();
        const arg = args.length === 1 ? args[0] : undefined;
        if (!arg) throw new Untranslatable();
        return { sql: `ABS(${arg.sql})`, text: false };
      }
      case 'CONCATENATE': {
        const args = this.parseArgs();
        if (args.some((a) => !a.text)) throw new Untranslatable();
        return { sql: `(${args.map((a) => a.sql).join(' || ')})`, text: true };
      }
      case 'SUM':
        return this.parseSum();
      default:
        throw new Untranslatable(); // outside the v1 allowlist
    }
  }

  /**
   * `SUM` over same-row references/ranges only, expanded to a NULL-safe
   * addition — Excel's SUM treats blanks as 0, so each operand is
   * `COALESCE(col, 0)`.
   */
  private parseSum(): TranslateValue {
    const columns: TranslateColumn[] = [];
    for (;;) {
      const tok = this.next();
      if (tok.kind === 'ref') {
        columns.push(this.column(tok.letters));
      } else if (tok.kind === 'range') {
        const from = letterIndex(tok.from);
        const to = letterIndex(tok.to);
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        for (let c = lo; c <= hi; c++) columns.push(this.column(columnLetter(c)));
      } else {
        throw new Untranslatable(); // SUM over expressions is out of scope
      }
      if (this.atOp(',')) {
        this.next();
        continue;
      }
      this.expectOp(')');
      break;
    }
    if (columns.length === 0) throw new Untranslatable();
    return { sql: `(${columns.map((c) => `COALESCE(${c.name}, 0)`).join(' + ')})`, text: false };
  }
}

/**
 * Translate a normalized formula pattern into a calc-expression over the
 * given columns. `columnMap` maps a sheet column letter to the materialized
 * column it survives as; a reference to an unmapped letter fails the
 * translation. Returns `null` for anything outside the v1 allowlist —
 * literals, same-row references, `+ - *` and unary minus, zero-guarded `/`,
 * text-only `&`/`CONCATENATE`, `IF` → `CASE WHEN`, `AND`/`OR`/`NOT`,
 * comparisons, `ROUND`, `ABS`, and `SUM` over a same-row range.
 *
 * A non-null result is guaranteed to parse under the calc-expr grammar with
 * the mapped column names — verified by round-tripping through its parser
 * before returning, so a name the grammar can't express (e.g. a column that
 * collides with one of its keywords) yields `null` rather than a broken
 * proposal.
 */
export function translatePattern(
  pattern: string,
  columnMap: Record<string, TranslateColumn>,
): string | null {
  try {
    const translator = new PatternTranslator(lexPattern(pattern), columnMap);
    const value = translator.parseExpr();
    translator.expectEnd();
    const names = new Set(Object.values(columnMap).map((c) => c.name));
    parseCalcExpr(value.sql, (path) => path.length === 1 && names.has(path[0] ?? ''));
    return value.sql;
  } catch {
    return null; // outside the translatable subset — no proposal
  }
}
