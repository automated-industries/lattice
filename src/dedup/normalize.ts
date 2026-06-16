/**
 * Text normalization for de-duplication. Pure, dependency-free, dialect-agnostic
 * (all comparison happens in JS, never in SQL) so the same rules apply on SQLite
 * and Postgres. Used to collapse trivial variants ("  ACME  Inc " vs "acme inc")
 * before exact-match grouping and as the input to fuzzy scoring.
 */

export interface NormalizeOptions {
  /** Lowercase (default true). */
  lowercase?: boolean;
  /** Trim leading/trailing whitespace (default true). */
  trim?: boolean;
  /** Collapse internal runs of whitespace to a single space (default true). */
  collapseWhitespace?: boolean;
  /** Strip punctuation/symbols, keeping letters, numbers, and spaces (default false). */
  stripPunctuation?: boolean;
}

const DEFAULTS: Required<NormalizeOptions> = {
  lowercase: true,
  trim: true,
  collapseWhitespace: true,
  stripPunctuation: false,
};

/** Coerce any cell value to a string for normalization (null/undefined → ''). */
function toStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Normalize a single value to its comparison form. */
export function normalizeText(value: unknown, opts: NormalizeOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  let s = toStr(value);
  if (o.lowercase) s = s.toLowerCase();
  // Unicode-aware punctuation strip (keeps letters/numbers across scripts).
  if (o.stripPunctuation) s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  if (o.collapseWhitespace) s = s.replace(/\s+/g, ' ');
  if (o.trim) s = s.trim();
  return s;
}

/**
 * Build a single grouping key from one or more columns of a row. Empty parts are
 * dropped, and the remaining parts are joined with a separator that cannot occur
 * in the normalized text (so ["a", "b"] and ["a b"] don't collide). Returns ''
 * when every part is empty — callers skip empty keys (a blank row is not a dup of
 * another blank row).
 */
export function keyFromColumns(
  row: Record<string, unknown>,
  cols: string[],
  opts: NormalizeOptions = {},
): string {
  const parts = cols.map((c) => normalizeText(row[c], opts)).filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  return parts.join('␟'); // U+241F SYMBOL FOR UNIT SEPARATOR — never in user text
}
