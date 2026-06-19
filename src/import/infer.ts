import type {
  InferredColumn,
  InferredDimension,
  InferredEntity,
  InferredLinkage,
  InferredType,
  ProposedSchema,
} from './types.js';

/**
 * Infer a proposed Lattice schema from a parsed JSON source — entities, column
 * types, natural keys, normalized dimensions (the categorical taxonomy), and
 * linkages between them. Pure + side-effect-free: it reads data and proposes a
 * schema; it never writes. The caller shows the proposal for approval, then a
 * separate step materializes it.
 *
 * Heuristics are deliberately conservative and reported with match counts /
 * confidence so a human approves before anything is created.
 */

const SAMPLE = 300;
/** Field names that make a good stable key, tried in order. */
const PREFERRED_KEYS = ['code', 'id', 'slug', 'key', 'ticker', 'symbol'];
/** Never use these as a natural key (free text). */
const NEVER_KEY = new Set(['description', 'notes', 'summary', 'desc', 'comment', 'comments', 'bio', 'text', 'body']);
/** Never normalize these into a dimension (high-cardinality / free text). */
const FREETEXT = new Set([
  ...NEVER_KEY,
  'name',
  'title',
  'company',
  'label',
]);
/** A string column with at most this many distinct values is a dimension candidate. */
const DIM_MAX_DISTINCT = 64;
/** ...as long as it is not near-unique (distinct/rows under this ratio). */
const DIM_MAX_RATIO = 0.5;
/** Minimum share of a reference field's distinct values that must resolve to call it a linkage. */
const LINK_MIN_CONFIDENCE = 0.3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Re-extract the raw source records for an entity from the parsed JSON — handling
 * the columnar case (`<key>` array-of-arrays + `<key>Cols` dictionary). Shared by
 * the inference step and the materialize step so both read records identically.
 */
export function sourceRecords(
  data: Record<string, unknown>,
  entity: { sourceKey: string; columnar: boolean },
): Record<string, unknown>[] {
  const v = data[entity.sourceKey];
  if (!Array.isArray(v)) return [];
  if (entity.columnar) {
    const cols = data[entity.sourceKey + 'Cols'];
    if (!Array.isArray(cols)) return [];
    return (v as unknown[][]).map((row) => {
      const o: Record<string, unknown> = {};
      (cols as string[]).forEach((c, i) => (o[c] = row[i]));
      return o;
    });
  }
  return v.filter(isPlainObject);
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

interface ColumnProfile {
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

interface EntitySource {
  name: string;
  sourceKey: string;
  records: Record<string, unknown>[];
  columnar: boolean;
  profiles: Map<string, ColumnProfile>;
  naturalKey: string | null;
}

function norm(v: unknown): string {
  return String(v).trim().toLowerCase();
}

/** True for a number, or a string that is numeric once currency/percent/grouping
 *  punctuation is stripped (e.g. "1,234", "$5", "12%", "(10)"). */
function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.replace(/[\s,$%()]/g, '');
  return s !== '' && Number.isFinite(Number(s));
}

function profileColumns(records: Record<string, unknown>[]): Map<string, ColumnProfile> {
  const keys = new Set<string>();
  for (const r of records.slice(0, SAMPLE)) for (const k of Object.keys(r)) keys.add(k);
  const out = new Map<string, ColumnProfile>();
  for (const key of keys) {
    let isArray = false;
    const sample: unknown[] = [];
    const valueSet = new Set<string>(); // string values only — for linkage matching
    const distinctSet = new Set<string>(); // ALL non-null values — for cardinality
    let nonNull = 0;
    let numeric = 0;
    for (const r of records) {
      const v = r[key];
      if (v === null || v === undefined || v === '') continue;
      nonNull++;
      if (Array.isArray(v)) {
        isArray = true;
        for (const e of v) {
          if (e !== null && e !== undefined && e !== '') {
            valueSet.add(norm(e));
            distinctSet.add(norm(e));
          }
        }
      } else {
        if (sample.length < SAMPLE) sample.push(v);
        if (typeof v === 'string') valueSet.add(norm(v));
        distinctSet.add(norm(v));
        if (isNumericValue(v)) numeric++;
      }
    }
    out.set(key, {
      sourceKey: key,
      isArray,
      type: isArray ? 'text' : inferFieldType(sample),
      // Cardinality counts ALL distinct values (numbers + strings). Counting only
      // string values let a mostly-numeric column with a few text sentinels (e.g.
      // a "TEV/EBITDA" of numbers + "NM") look low-cardinality and slip in as a
      // junk dimension.
      distinct: distinctSet.size,
      valueSet,
      numericFraction: nonNull > 0 ? numeric / nonNull : 0,
    });
  }
  return out;
}

/** Pick a natural key: a unique, non-freetext scalar column, preferring stable names. */
function pickNaturalKey(records: Record<string, unknown>[], profiles: Map<string, ColumnProfile>): string | null {
  const n = records.length;
  const isUnique = (key: string): boolean => {
    const seen = new Set<string>();
    for (const r of records) {
      const v = r[key];
      if (v === null || v === undefined || v === '') return false;
      const k = norm(v);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return seen.size === n;
  };
  for (const pref of PREFERRED_KEYS) {
    for (const [key, p] of profiles) {
      if (p.isArray) continue;
      if (normalizeName(key) === pref && isUnique(key)) return key;
    }
  }
  for (const [key, p] of profiles) {
    if (p.isArray) continue;
    if (NEVER_KEY.has(normalizeName(key))) continue;
    if ((p.type === 'text' || p.type === 'integer') && isUnique(key)) return key;
  }
  return null;
}

export interface InferOptions {
  /** Override the inferred entity → table name (sourceKey → name). */
  rename?: Record<string, string>;
}

export function inferSchema(data: Record<string, unknown>, opts: InferOptions = {}): ProposedSchema {
  const skipped: { key: string; reason: string }[] = [];

  // Pass 1 — find columnar pairs (`x` array-of-arrays + `xCols` string[]).
  const consumedColsKeys = new Set<string>();
  for (const key of Object.keys(data)) {
    const v = data[key];
    const cols = data[key + 'Cols'];
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      Array.isArray(v[0]) &&
      Array.isArray(cols) &&
      cols.every((c) => typeof c === 'string')
    ) {
      consumedColsKeys.add(key + 'Cols');
    }
  }

  // Pass 2 — build entity sources; record everything else as skipped.
  const sources: EntitySource[] = [];
  for (const key of Object.keys(data)) {
    if (consumedColsKeys.has(key)) continue; // a column dictionary, consumed below
    const v = data[key];
    if (!Array.isArray(v) || v.length === 0) {
      skipped.push({ key, reason: isPlainObject(v) ? 'object (derived/rollup)' : 'scalar/empty (meta or derived)' });
      continue;
    }
    let records: Record<string, unknown>[];
    let columnar = false;
    if (isPlainObject(v[0])) {
      records = v.filter(isPlainObject);
    } else if (Array.isArray(v[0]) && Array.isArray(data[key + 'Cols'])) {
      const cols = data[key + 'Cols'] as string[];
      records = (v as unknown[][]).map((row) => {
        const o: Record<string, unknown> = {};
        cols.forEach((c, i) => (o[c] = row[i]));
        return o;
      });
      columnar = true;
    } else {
      skipped.push({ key, reason: 'array of scalars (not a record set)' });
      continue;
    }
    const name = opts.rename?.[key] ?? normalizeName(key);
    const profiles = profileColumns(records);
    sources.push({ name, sourceKey: key, records, columnar, profiles, naturalKey: pickNaturalKey(records, profiles) });
  }

  // Pass 3 — linkages. Match a field's distinct string values against other
  // entities' scalar string columns; the best target above threshold wins.
  const linkages: InferredLinkage[] = [];
  const consumedFields = new Map<string, Set<string>>(); // entity name → fields used as a linkage
  const linkedTargets = new Map<string, Set<string>>(); // entity name → target entity names already linked
  const consume = (e: string, f: string): void => {
    let set = consumedFields.get(e);
    if (!set) {
      set = new Set();
      consumedFields.set(e, set);
    }
    set.add(f);
  };
  const markTarget = (e: string, t: string): void => {
    let set = linkedTargets.get(e);
    if (!set) {
      set = new Set();
      linkedTargets.set(e, set);
    }
    set.add(t);
  };

  // A reference resolves to a target entity's NATURAL KEY — not any overlapping
  // column. This is what separates a foreign key from a shared dimension: two
  // entities both carrying `region` are not referencing each other; they share a
  // dimension. A keyless entity therefore cannot be a link target.
  function bestTarget(
    self: EntitySource,
    values: Set<string>,
  ): { target: EntitySource; column: string; matched: number } | null {
    if (values.size === 0) return null;
    let best: { target: EntitySource; column: string; matched: number } | null = null;
    for (const t of sources) {
      if (t.name === self.name || !t.naturalKey) continue;
      const p = t.profiles.get(t.naturalKey);
      if (!p || p.valueSet.size === 0) continue;
      let matched = 0;
      for (const v of values) if (p.valueSet.has(v)) matched++;
      if (matched > 0 && (best === null || matched > best.matched)) {
        best = { target: t, column: t.naturalKey, matched };
      }
    }
    return best;
  }

  // Array fields → many-to-many; then scalar refs → many-to-one.
  for (const pass of ['array', 'scalar'] as const) {
    for (const e of sources) {
      for (const [field, p] of e.profiles) {
        if (pass === 'array' ? !p.isArray : p.isArray) continue;
        if (pass === 'scalar') {
          if (field === e.naturalKey) continue;
          if (FREETEXT.has(normalizeName(field)) || NEVER_KEY.has(normalizeName(field))) continue;
          if (p.type !== 'text') continue;
        }
        if (consumedFields.get(e.name)?.has(field)) continue;
        const best = bestTarget(e, p.valueSet);
        if (!best) continue;
        const confidence = best.matched / p.valueSet.size;
        if (confidence < LINK_MIN_CONFIDENCE) continue;
        if (linkedTargets.get(e.name)?.has(best.target.name)) {
          // already linked to this target (prefer the m2m array link); just consume the field
          consume(e.name, field);
          continue;
        }
        const link: InferredLinkage = {
          kind: pass === 'array' ? 'many-to-many' : 'many-to-one',
          fromEntity: e.name,
          fromField: field,
          toEntity: best.target.name,
          toKey: normalizeName(best.column),
          matched: best.matched,
          unresolved: p.valueSet.size - best.matched,
          confidence,
        };
        if (pass === 'array') link.junction = `${e.name}_${best.target.name}`;
        linkages.push(link);
        consume(e.name, field);
        markTarget(e.name, best.target.name);
      }
    }
  }

  // Pass 4 — dimensions from remaining categorical string columns.
  const dimColumnNames = new Map<string, EntitySource[]>(); // normalized col name → entities having it as a string col
  for (const e of sources) {
    for (const [field, p] of e.profiles) {
      if (p.isArray || p.type !== 'text' || p.numericFraction > 0.5) continue;
      const nn = normalizeName(field);
      let arr = dimColumnNames.get(nn);
      if (!arr) {
        arr = [];
        dimColumnNames.set(nn, arr);
      }
      arr.push(e);
    }
  }
  const dimensions: InferredDimension[] = [];
  const dimByName = new Map<string, InferredDimension>();
  for (const e of sources) {
    for (const [field, p] of e.profiles) {
      if (p.isArray || p.type !== 'text' || p.numericFraction > 0.5) continue;
      if (field === e.naturalKey) continue;
      if (consumedFields.get(e.name)?.has(field)) continue; // already a linkage field
      const nn = normalizeName(field);
      if (FREETEXT.has(nn)) continue;
      const ratio = p.distinct / Math.max(1, e.records.length);
      const sharedAcross = dimColumnNames.get(nn)?.length ?? 1;
      // A dimension is a LOW-cardinality categorical: the distinct cap always
      // applies (so a high-cardinality numeric/text column like an IRR or a
      // description never becomes a dimension). Being shared across entities only
      // waives the per-entity ratio test (a small columnar tab can still carry
      // the shared taxonomy) — it does NOT waive the cardinality cap.
      const isDim =
        p.distinct >= 1 && p.distinct <= DIM_MAX_DISTINCT && (ratio <= DIM_MAX_RATIO || sharedAcross >= 2);
      if (!isDim) continue;
      let dim = dimByName.get(nn);
      if (!dim) {
        dim = { name: nn, sourceField: field, fromEntities: [], distinctValues: 0 };
        dimByName.set(nn, dim);
        dimensions.push(dim);
      }
      if (!dim.fromEntities.includes(e.name)) dim.fromEntities.push(e.name);
      linkages.push({
        kind: 'dimension',
        fromEntity: e.name,
        fromField: field,
        toEntity: nn,
        toKey: 'value',
        junction: `${e.name}_${nn}`,
        matched: p.distinct,
        unresolved: 0,
        confidence: 1,
      });
      consume(e.name, field);
    }
  }
  // Fill dimension distinct counts (union of values across contributing entities).
  for (const dim of dimensions) {
    const all = new Set<string>();
    for (const name of dim.fromEntities) {
      const e = sources.find((s) => s.name === name);
      if (!e) continue;
      for (const [f, p] of e.profiles) {
        if (normalizeName(f) === dim.name) for (const v of p.valueSet) all.add(v);
      }
    }
    dim.distinctValues = all.size;
  }

  // Assemble entities with their remaining scalar columns.
  const entities: InferredEntity[] = sources.map((e): InferredEntity => {
    const columns: InferredColumn[] = [];
    for (const [field, p] of e.profiles) {
      if (p.isArray) continue; // linkage, not a scalar column
      if (consumedFields.get(e.name)?.has(field)) continue; // dimension/linkage field
      columns.push({ name: normalizeName(field), sourceKey: field, type: p.type });
    }
    return {
      name: e.name,
      sourceKey: e.sourceKey,
      columns,
      naturalKey: e.naturalKey ? normalizeName(e.naturalKey) : null,
      naturalKeySource: e.naturalKey,
      rowCount: e.records.length,
      columnar: e.columnar,
    };
  });

  return { entities, dimensions, linkages, skipped };
}
