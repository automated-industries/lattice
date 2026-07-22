import type { InferredType } from './types.js';

/**
 * Source-agnostic primitives shared by the ingest schema inferrer (`infer.ts`)
 * and the deterministic data-model planner (`gui/planner/`). Keeping the
 * normalization, type inference, cardinality caps, and key-name conventions in
 * ONE place means the two engines always agree on what a column "is" — the
 * planner reuses these leaves but layers its own stricter, unattended-safe
 * matching policy on top (it must not fire on any overlap the way the
 * user-confirmed ingest inferrer does).
 *
 * Everything here is pure and side-effect-free.
 */

/** Rows sampled when profiling a column set. */
export const SAMPLE = 300;

/** Field names that make a good stable key, tried in order. */
export const PREFERRED_KEYS = ['code', 'id', 'slug', 'key', 'ticker', 'symbol'];

/** Never use these as a natural key (free text). */
export const NEVER_KEY = new Set([
  'description',
  'notes',
  'summary',
  'desc',
  'comment',
  'comments',
  'bio',
  'text',
  'body',
]);

/** Never normalize these into a dimension (high-cardinality / free text). */
export const FREETEXT = new Set([...NEVER_KEY, 'name', 'title', 'company', 'label']);

/** A string column with at most this many distinct values is a dimension candidate. */
export const DIM_MAX_DISTINCT = 64;

/** ...as long as it is not near-unique (distinct/rows under this ratio). */
export const DIM_MAX_RATIO = 0.5;

/**
 * Default minimum share of a reference field's distinct values that must
 * resolve before a linkage is created. Mirrors the GUI's clarify-threshold
 * default: candidates below it but at or above half of it are reported as
 * marginal for user confirmation instead of being applied silently.
 */
export const DEFAULT_LINK_CONFIDENCE = 0.6;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lower-snake-case a JSON key into a safe SQL identifier. */
export function normalizeName(key: string): string {
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase → camel_Case
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'field';
  return /^[a-z]/.test(s) ? s : 'f_' + s;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Infer a column type from a set of values (nulls ignored). Defaults to text. */
export function inferFieldType(values: unknown[]): InferredType {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (present.length === 0) return 'text';
  if (present.every((v) => typeof v === 'number')) {
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'real';
  }
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'string')) {
    if (present.every((v) => ISO_DATE.test(v))) return 'date';
    if (present.every((v) => ISO_DATETIME.test(v))) return 'datetime';
  }
  return 'text';
}

/** Normalize a value for cross-column comparison: string, trimmed, lower-cased.
 *  Unicode default case-fold (NOT locale-dependent) so it is stable across
 *  machines and DB engines — do not switch to toLocaleLowerCase. */
export function norm(v: unknown): string {
  return String(v).trim().toLowerCase();
}

/** True for a number, or a string that is numeric once currency/percent/grouping
 *  punctuation is stripped (e.g. "1,234", "$5", "12%", "(10)"). */
export function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.replace(/[\s,$%()]/g, '');
  return s !== '' && Number.isFinite(Number(s));
}

export interface ColumnProfile {
  sourceKey: string;
  isArray: boolean;
  type: InferredType;
  /** Distinct non-null values across ALL records (string-normalized). */
  distinct: number;
  /** Normalized distinct string values (for linkage matching). Empty for non-string columns. */
  valueSet: Set<string>;
  /** Fraction of non-null values that are numeric (incl. numbers stored as text). */
  numericFraction: number;
}
