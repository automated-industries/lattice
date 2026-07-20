/**
 * Sandboxed calculation-expression language for computed-table `calc` fields.
 *
 * A tokenizer + recursive-descent parser produce a typed AST; SQL is emitted
 * by re-serializing that AST. Raw user text NEVER reaches the SQL string —
 * this module is the injection boundary for computed tables. Anything outside
 * the grammar (semicolons, comment sequences, subqueries, table names, bind
 * parameters, double quotes, unknown functions) has no token or production,
 * so it fails with a parse error instead of ever appearing in SQL.
 *
 * Supported grammar (precedence, loosest → tightest):
 *
 *   OR
 *   AND
 *   NOT <expr>
 *   comparison: `= != <> < <= > >=`, `IS [NOT] NULL`, `[NOT] LIKE`,
 *               `[NOT] IN (<literal list>)`, `[NOT] BETWEEN a AND b`
 *   `||` (string concatenation)
 *   `+ -`
 *   `* / %`
 *   unary `-`
 *   primary: literals, column refs, allowlisted functions, CAST, CASE, `( )`
 *
 * Literals: numeric (`12`, `3.5`), `'string'` (with `''` as the only escape,
 * re-escaped on emit), `NULL`, `TRUE`/`FALSE`. Column refs are a bare
 * identifier or a dotted belongsTo path, validated at parse time by a
 * caller-supplied resolver; at emit time the compiler maps each path to a
 * `"alias"."column"` pair, so identifiers in the output are always
 * compiler-produced. Emitted expressions are fully parenthesized, so the
 * grammar's precedence is explicit in the SQL and identical on both dialects.
 *
 * Pure module: no I/O, no imports beyond types.
 */

export type CalcDialect = 'sqlite' | 'postgres';

/** Target types accepted by `CAST(expr AS <type>)`. */
export type CalcCastType = 'TEXT' | 'INTEGER' | 'REAL';

/** Binary operators preserved in the AST (comparison `!=` normalizes to `<>`). */
type BinaryOp = '+' | '-' | '*' | '/' | '%' | '||' | '=' | '<>' | '<' | '<=' | '>' | '>=';

/** Typed AST. Only these shapes exist — SQL is produced exclusively from them. */
export type CalcNode =
  | { t: 'num'; lexeme: string }
  | { t: 'str'; value: string }
  | { t: 'null' }
  | { t: 'bool'; value: boolean }
  | { t: 'col'; path: readonly string[] }
  | { t: 'bin'; op: BinaryOp; left: CalcNode; right: CalcNode }
  | { t: 'logic'; op: 'AND' | 'OR'; left: CalcNode; right: CalcNode }
  | { t: 'not'; expr: CalcNode }
  | { t: 'neg'; expr: CalcNode }
  | { t: 'isnull'; expr: CalcNode; negated: boolean }
  | { t: 'like'; expr: CalcNode; pattern: CalcNode; negated: boolean }
  | { t: 'in'; expr: CalcNode; items: readonly CalcNode[]; negated: boolean }
  | { t: 'between'; expr: CalcNode; low: CalcNode; high: CalcNode; negated: boolean }
  | {
      t: 'case';
      whens: readonly { when: CalcNode; then: CalcNode }[];
      elseExpr: CalcNode | null;
    }
  | { t: 'fn'; name: string; args: readonly CalcNode[] }
  | { t: 'cast'; expr: CalcNode; to: CalcCastType };

/** A parsed expression plus the unique column paths it references. */
export interface CalcExpr {
  readonly ast: CalcNode;
  /** Unique referenced column paths, in first-appearance order. */
  readonly columnPaths: readonly (readonly string[])[];
}

/**
 * Column-reference resolver supplied by the caller. Receives the dotted path
 * split into segments; returns true when the path resolves (a base column, or
 * a belongsTo chain ending in a column). An unresolved path is a parse error.
 */
export type CalcRefResolver = (path: readonly string[]) => boolean;

/** Thrown for any lexical or syntactic violation of the expression grammar. */
export class CalcExprError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`calc expression: ${message} (at offset ${String(position)})`);
    this.name = 'CalcExprError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'dot' | 'end';

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    // Comment sequences are rejected outright — they have no token, and `--`
    // must not lex as two unary minuses (which would let a trailing comment
    // parse as a double negation of whatever follows).
    if (ch === '-' && src[i + 1] === '-') {
      throw new CalcExprError(`SQL comments ("--") are not allowed`, i);
    }
    if (ch === '/' && src[i + 1] === '*') {
      throw new CalcExprError(`SQL comments ("/*") are not allowed`, i);
    }
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < src.length && DIGIT.test(src.charAt(j))) j++;
      if (src.charAt(j) === '.' && j + 1 < src.length && DIGIT.test(src.charAt(j + 1))) {
        j += 2;
        while (j < src.length && DIGIT.test(src.charAt(j))) j++;
      }
      tokens.push({ kind: 'num', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === "'") {
      // String literal; '' is the only escape.
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new CalcExprError('unterminated string literal', i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += src.charAt(j);
        j++;
      }
      tokens.push({ kind: 'str', text: value, pos: i });
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src.charAt(j))) j++;
      tokens.push({ kind: 'ident', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // Multi-char operators first.
    const two = src.slice(i, i + 2);
    if (two === '||' || two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      tokens.push({ kind: 'op', text: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%=<>'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', text: ch, pos: i });
      i++;
      continue;
    }
    // Everything else — `;`, `"`, `?`, `$`, backticks, brackets — is
    // unrepresentable. Named characters get a pointed message.
    if (ch === ';') throw new CalcExprError(`';' is not allowed`, i);
    if (ch === '"') throw new CalcExprError(`'"' is not allowed — identifiers are bare`, i);
    if (ch === '?' || ch === '$') {
      throw new CalcExprError(`bind parameters are not allowed`, i);
    }
    throw new CalcExprError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ kind: 'end', text: '', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Keywords + function allowlist
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'AND',
  'OR',
  'NOT',
  'IS',
  'LIKE',
  'IN',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'AS',
]);

/** name → [minArity, maxArity]. IFNULL normalizes to COALESCE at parse. */
const FUNCTIONS: Record<string, readonly [number, number]> = {
  COALESCE: [2, Number.POSITIVE_INFINITY],
  NULLIF: [2, 2],
  LOWER: [1, 1],
  UPPER: [1, 1],
  TRIM: [1, 1],
  LENGTH: [1, 1],
  SUBSTR: [2, 3],
  REPLACE: [3, 3],
  ABS: [1, 1],
  ROUND: [1, 2],
  IFNULL: [2, 2],
};

const CAST_TYPES = new Set<CalcCastType>(['TEXT', 'INTEGER', 'REAL']);

/** Sentinel used by the parser's total token accessors (never actually reached). */
const END_TOKEN: Token = { kind: 'end', text: '', pos: 0 };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private idx = 0;
  private readonly paths: string[][] = [];
  private readonly seenPaths = new Set<string>();

  constructor(
    private readonly tokens: Token[],
    private readonly resolveRef: CalcRefResolver,
  ) {}

  parse(): CalcExpr {
    const ast = this.parseOr();
    const tok = this.peek();
    if (tok.kind !== 'end') {
      throw new CalcExprError(`unexpected trailing input ${JSON.stringify(tok.text)}`, tok.pos);
    }
    return { ast, columnPaths: this.paths };
  }

  private peek(): Token {
    // The token list always ends with an 'end' token and the index never
    // advances past it, so the fallback is unreachable — it exists only to
    // keep indexed access total.
    return this.tokens[this.idx] ?? END_TOKEN;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== 'end') this.idx++;
    return tok;
  }

  /** True when the current token is the given case-insensitive keyword. */
  private atKeyword(word: string): boolean {
    const tok = this.peek();
    return tok.kind === 'ident' && tok.text.toUpperCase() === word;
  }

  private expectKeyword(word: string): void {
    const tok = this.peek();
    if (!this.atKeyword(word)) {
      throw new CalcExprError(`expected ${word}, got ${JSON.stringify(tok.text)}`, tok.pos);
    }
    this.next();
  }

  private expect(kind: TokenKind, what: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new CalcExprError(
        `expected ${what}, got ${tok.kind === 'end' ? 'end of expression' : JSON.stringify(tok.text)}`,
        tok.pos,
      );
    }
    return this.next();
  }

  private parseOr(): CalcNode {
    let left = this.parseAnd();
    while (this.atKeyword('OR')) {
      this.next();
      const right = this.parseAnd();
      left = { t: 'logic', op: 'OR', left, right };
    }
    return left;
  }

  private parseAnd(): CalcNode {
    let left = this.parseNot();
    while (this.atKeyword('AND')) {
      this.next();
      const right = this.parseNot();
      left = { t: 'logic', op: 'AND', left, right };
    }
    return left;
  }

  private parseNot(): CalcNode {
    if (this.atKeyword('NOT')) {
      this.next();
      return { t: 'not', expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): CalcNode {
    const left = this.parseConcat();
    const tok = this.peek();

    if (tok.kind === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(tok.text)) {
      this.next();
      const right = this.parseConcat();
      const op = (tok.text === '!=' ? '<>' : tok.text) as BinaryOp;
      return { t: 'bin', op, left, right };
    }

    if (this.atKeyword('IS')) {
      this.next();
      let negated = false;
      if (this.atKeyword('NOT')) {
        this.next();
        negated = true;
      }
      this.expectKeyword('NULL');
      return { t: 'isnull', expr: left, negated };
    }

    let negated = false;
    if (this.atKeyword('NOT')) {
      // Only [NOT] LIKE / [NOT] IN / [NOT] BETWEEN may follow here.
      const after = this.tokens[this.idx + 1];
      const kw = after?.kind === 'ident' ? after.text.toUpperCase() : '';
      if (kw === 'LIKE' || kw === 'IN' || kw === 'BETWEEN') {
        this.next();
        negated = true;
      } else {
        return left;
      }
    }

    if (this.atKeyword('LIKE')) {
      this.next();
      const pattern = this.parseConcat();
      return { t: 'like', expr: left, pattern, negated };
    }
    if (this.atKeyword('IN')) {
      this.next();
      this.expect('lparen', `'('`);
      const items: CalcNode[] = [this.parseLiteral()];
      while (this.peek().kind === 'comma') {
        this.next();
        items.push(this.parseLiteral());
      }
      this.expect('rparen', `')'`);
      return { t: 'in', expr: left, items, negated };
    }
    if (this.atKeyword('BETWEEN')) {
      this.next();
      const low = this.parseConcat();
      this.expectKeyword('AND');
      const high = this.parseConcat();
      return { t: 'between', expr: left, low, high, negated };
    }

    if (negated) {
      const bad = this.peek();
      throw new CalcExprError(`expected LIKE, IN, or BETWEEN after NOT`, bad.pos);
    }
    return left;
  }

  /** IN lists accept literals only (numbers, strings, NULL, TRUE/FALSE, -num). */
  private parseLiteral(): CalcNode {
    const tok = this.peek();
    if (tok.kind === 'num') {
      this.next();
      return { t: 'num', lexeme: tok.text };
    }
    if (tok.kind === 'str') {
      this.next();
      return { t: 'str', value: tok.text };
    }
    if (tok.kind === 'op' && tok.text === '-') {
      this.next();
      const num = this.expect('num', 'a number');
      return { t: 'neg', expr: { t: 'num', lexeme: num.text } };
    }
    if (this.atKeyword('NULL')) {
      this.next();
      return { t: 'null' };
    }
    if (this.atKeyword('TRUE') || this.atKeyword('FALSE')) {
      const value = this.peek().text.toUpperCase() === 'TRUE';
      this.next();
      return { t: 'bool', value };
    }
    throw new CalcExprError(
      `expected a literal in IN list, got ${JSON.stringify(tok.text)}`,
      tok.pos,
    );
  }

  private parseConcat(): CalcNode {
    let left = this.parseAdditive();
    while (this.peek().kind === 'op' && this.peek().text === '||') {
      this.next();
      const right = this.parseAdditive();
      left = { t: 'bin', op: '||', left, right };
    }
    return left;
  }

  private parseAdditive(): CalcNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'op' && (tok.text === '+' || tok.text === '-')) {
        this.next();
        const right = this.parseMultiplicative();
        left = { t: 'bin', op: tok.text as BinaryOp, left, right };
      } else {
        return left;
      }
    }
  }

  private parseMultiplicative(): CalcNode {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'op' && (tok.text === '*' || tok.text === '/' || tok.text === '%')) {
        this.next();
        const right = this.parseUnary();
        left = { t: 'bin', op: tok.text as BinaryOp, left, right };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): CalcNode {
    const tok = this.peek();
    if (tok.kind === 'op' && tok.text === '-') {
      this.next();
      return { t: 'neg', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): CalcNode {
    const tok = this.peek();

    if (tok.kind === 'num') {
      this.next();
      return { t: 'num', lexeme: tok.text };
    }
    if (tok.kind === 'str') {
      this.next();
      return { t: 'str', value: tok.text };
    }
    if (tok.kind === 'lparen') {
      this.next();
      const inner = this.parseOr();
      this.expect('rparen', `')'`);
      return inner;
    }
    if (tok.kind !== 'ident') {
      throw new CalcExprError(
        `expected an expression, got ${tok.kind === 'end' ? 'end of expression' : JSON.stringify(tok.text)}`,
        tok.pos,
      );
    }

    const upper = tok.text.toUpperCase();
    if (upper === 'NULL') {
      this.next();
      return { t: 'null' };
    }
    if (upper === 'TRUE' || upper === 'FALSE') {
      this.next();
      return { t: 'bool', value: upper === 'TRUE' };
    }
    if (upper === 'CASE') return this.parseCase();
    if (upper === 'CAST') return this.parseCast();

    // Function call?
    const after = this.tokens[this.idx + 1];
    if (after?.kind === 'lparen') {
      if (KEYWORDS.has(upper)) {
        throw new CalcExprError(`unexpected ${JSON.stringify(tok.text)}`, tok.pos);
      }
      const arity = FUNCTIONS[upper];
      if (!arity) {
        throw new CalcExprError(`function ${JSON.stringify(tok.text)} is not allowed`, tok.pos);
      }
      this.next(); // ident
      this.next(); // lparen
      const args: CalcNode[] = [this.parseOr()];
      while (this.peek().kind === 'comma') {
        this.next();
        args.push(this.parseOr());
      }
      this.expect('rparen', `')'`);
      const [min, max] = arity;
      if (args.length < min || args.length > max) {
        throw new CalcExprError(
          `${upper} expects ${String(min)}${max === Number.POSITIVE_INFINITY ? '+' : max !== min ? `-${String(max)}` : ''} argument(s), got ${String(args.length)}`,
          tok.pos,
        );
      }
      // IFNULL is COALESCE with exactly two args — normalize so emit has one form.
      return { t: 'fn', name: upper === 'IFNULL' ? 'COALESCE' : upper, args };
    }

    if (KEYWORDS.has(upper)) {
      throw new CalcExprError(`unexpected ${JSON.stringify(tok.text)}`, tok.pos);
    }

    // Column reference: IDENT ('.' IDENT)*
    const path: string[] = [tok.text];
    this.next();
    while (this.peek().kind === 'dot') {
      this.next();
      const seg = this.expect('ident', 'an identifier after "."');
      path.push(seg.text);
    }
    if (!this.resolveRef(path)) {
      throw new CalcExprError(
        `unknown column reference ${JSON.stringify(path.join('.'))}`,
        tok.pos,
      );
    }
    const key = path.join('.');
    if (!this.seenPaths.has(key)) {
      this.seenPaths.add(key);
      this.paths.push(path);
    }
    return { t: 'col', path };
  }

  private parseCase(): CalcNode {
    const start = this.peek();
    this.expectKeyword('CASE');
    if (!this.atKeyword('WHEN')) {
      throw new CalcExprError(
        `only the searched CASE form (CASE WHEN … THEN … END) is supported`,
        start.pos,
      );
    }
    const whens: { when: CalcNode; then: CalcNode }[] = [];
    while (this.atKeyword('WHEN')) {
      this.next();
      const when = this.parseOr();
      this.expectKeyword('THEN');
      const then = this.parseOr();
      whens.push({ when, then });
    }
    let elseExpr: CalcNode | null = null;
    if (this.atKeyword('ELSE')) {
      this.next();
      elseExpr = this.parseOr();
    }
    this.expectKeyword('END');
    return { t: 'case', whens, elseExpr };
  }

  private parseCast(): CalcNode {
    this.expectKeyword('CAST');
    this.expect('lparen', `'('`);
    const expr = this.parseOr();
    this.expectKeyword('AS');
    const typeTok = this.expect('ident', 'a cast type');
    const to = typeTok.text.toUpperCase() as CalcCastType;
    if (!CAST_TYPES.has(to)) {
      throw new CalcExprError(
        `CAST target must be TEXT, INTEGER, or REAL — got ${JSON.stringify(typeTok.text)}`,
        typeTok.pos,
      );
    }
    this.expect('rparen', `')'`);
    return { t: 'cast', expr, to };
  }
}

/**
 * Parse a calculation expression, validating every column reference against
 * `resolveRef`. Throws {@link CalcExprError} on any grammar violation or
 * unresolved reference.
 */
export function parseCalcExpr(source: string, resolveRef: CalcRefResolver): CalcExpr {
  if (source.trim().length === 0) {
    throw new CalcExprError('expression must be a non-empty string', 0);
  }
  return new Parser(tokenize(source), resolveRef).parse();
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Emit-time context: the dialect and the compiler's path → SQL mapping. */
export interface CalcEmitContext {
  dialect: CalcDialect;
  /** Map a resolved column path to its compiled `"alias"."column"` SQL. */
  columnSql: (path: readonly string[]) => string;
}

/** Re-escape a string literal for SQL (single quotes doubled). */
function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Serialize a parsed expression to SQL. Every composite node is
 * parenthesized, so the emitted precedence is explicit and dialect-neutral.
 */
export function emitCalcExpr(expr: CalcExpr, ctx: CalcEmitContext): string {
  return emitNode(expr.ast, ctx);
}

function emitNode(node: CalcNode, ctx: CalcEmitContext): string {
  switch (node.t) {
    case 'num':
      return node.lexeme;
    case 'str':
      return quoteString(node.value);
    case 'null':
      return 'NULL';
    case 'bool':
      return node.value ? 'TRUE' : 'FALSE';
    case 'col':
      return ctx.columnSql(node.path);
    case 'bin':
      return `(${emitNode(node.left, ctx)} ${node.op} ${emitNode(node.right, ctx)})`;
    case 'logic':
      return `(${emitNode(node.left, ctx)} ${node.op} ${emitNode(node.right, ctx)})`;
    case 'not':
      return `(NOT ${emitNode(node.expr, ctx)})`;
    case 'neg':
      return `(-${emitNode(node.expr, ctx)})`;
    case 'isnull':
      return `(${emitNode(node.expr, ctx)} IS ${node.negated ? 'NOT ' : ''}NULL)`;
    case 'like':
      return `(${emitNode(node.expr, ctx)} ${node.negated ? 'NOT ' : ''}LIKE ${emitNode(node.pattern, ctx)})`;
    case 'in':
      return `(${emitNode(node.expr, ctx)} ${node.negated ? 'NOT ' : ''}IN (${node.items
        .map((i) => emitNode(i, ctx))
        .join(', ')}))`;
    case 'between':
      return `(${emitNode(node.expr, ctx)} ${node.negated ? 'NOT ' : ''}BETWEEN ${emitNode(node.low, ctx)} AND ${emitNode(node.high, ctx)})`;
    case 'case': {
      const whens = node.whens
        .map((w) => `WHEN ${emitNode(w.when, ctx)} THEN ${emitNode(w.then, ctx)}`)
        .join(' ');
      const elsePart = node.elseExpr ? ` ELSE ${emitNode(node.elseExpr, ctx)}` : '';
      return `(CASE ${whens}${elsePart} END)`;
    }
    case 'fn': {
      // Two-argument ROUND needs a NUMERIC operand on Postgres (there is no
      // round(double precision, int)); SQLite takes it directly.
      if (node.name === 'ROUND' && node.args.length === 2 && ctx.dialect === 'postgres') {
        const [value, digits] = node.args as [CalcNode, CalcNode];
        return `ROUND(CAST(${emitNode(value, ctx)} AS NUMERIC), ${emitNode(digits, ctx)})`;
      }
      return `${node.name}(${node.args.map((a) => emitNode(a, ctx)).join(', ')})`;
    }
    case 'cast':
      return `CAST(${emitNode(node.expr, ctx)} AS ${node.to})`;
  }
}
