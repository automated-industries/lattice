import {
  FREETEXT,
  ISO_DATE,
  ISO_DATETIME,
  SAMPLE,
  isNumericValue,
  isSystemColumn,
  norm,
  pickNaturalKeyFrom,
} from '../../import/infer-core.js';
import type { InferredType } from '../../import/types.js';
import type {
  ColumnStat,
  ModelProfile,
  NormalizedRelation,
  TableProfile,
  TableTier,
} from './types.js';

/**
 * Introspection — the ONLY layer that reads the database, and it reads it in a
 * bounded, dialect-stable way:
 *
 *  - G1 (deterministic sampling): every read is ordered by the primary key, so
 *    WITHIN a workspace the sample is a stable prefix — the same rows every run —
 *    which is what makes "same model → same plan" hold. (A text/UUID key's prefix
 *    can differ across ENGINES because `ORDER BY` uses each engine's default
 *    collation; a workspace runs on ONE engine, so its per-workspace determinism
 *    is unaffected. A byte-stable cross-engine prefix would need `ORDER BY … COLLATE`,
 *    which the bounded-read API doesn't expose.)
 *  - G3 (cross-dialect canonicalization): node-pg and better-sqlite3 return
 *    different JS types for the same logical value (Date vs ISO string, number
 *    vs numeric string, boolean vs 0/1). We canonicalize at this boundary —
 *    keyed on the DECLARED column type, never `typeof` of a runtime value — so
 *    the pure `profileTable` below produces a byte-identical `TableProfile` on
 *    both engines.
 *  - G4 (egress): exactly ONE bounded sample read per table; every column stat
 *    is computed in JS from that single page. No per-column query, no unbounded
 *    COUNT/DISTINCT.
 *
 * `profileTable` (pure) is where the canonicalization + stats live and is
 * unit-tested directly with dialect-divergent fixture rows; the DB-reading shell
 * (`buildModelProfile`) is a thin wrapper over the Lattice facade.
 */

type Row = Record<string, unknown>;

/** Distinct values tracked per column (cap bounds memory + marks coverage as partial). */
export const DISTINCT_CAP = 200;

/** The declared structure of a table (from the schema/config), fed to `profileTable`. */
export interface TableStructural {
  name: string;
  tier: TableTier;
  /** Per column: `sqlType` is the raw PHYSICAL SQL type — it drives value
   *  canonicalization, kept identical across every column so normalization is
   *  symmetric (a text FK and a numeric key compare on the same footing).
   *  `canonicalType` is the declared Lattice field type when known, used ONLY for
   *  retype detection (so a column already typed datetime/integer/uuid isn't
   *  proposed for retype). `profileTable` lower-cases whichever it surfaces. */
  columns: { name: string; sqlType: string; canonicalType?: string | undefined }[];
  primaryKey: string[];
  relations: NormalizedRelation[];
  hasDefinition: boolean;
  /** Bounded total row count (may be a `cap+` lower bound). */
  rowCount: number;
  rowCountCapped: boolean;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/**
 * Canonicalize a stored value into a dialect-independent JS value, keyed on the
 * DECLARED column type. This is the heart of G3: it erases the node-pg vs
 * better-sqlite3 representation differences before any typing/matching happens.
 */
export function canonicalizeValue(v: unknown, sqlType: string): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  const t = sqlType.toLowerCase();
  if (/(^|\W)(int|integer|real|numeric|decimal|double|float|serial|bigint|money)/.test(t)) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }
  if (t.includes('bool')) {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 't' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'f' || v === 'false') return false;
    return v;
  }
  return v;
}

/**
 * The NATURAL type of a set of stored values — unlike `inferFieldType`, this
 * recognizes numbers/dates that are STORED AS TEXT (Lattice user columns default
 * to TEXT), which is exactly the retype signal (a TEXT column that is really
 * integer/date). Operates on already-canonicalized values.
 */
export function naturalType(values: unknown[]): InferredType {
  const present = values.filter((v) => !isEmpty(v));
  if (present.length === 0) return 'text';
  if (present.every((v) => typeof v === 'number')) {
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'real';
  }
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'string')) {
    if (present.every((v) => isNumericValue(v))) {
      const nums = present.map((v) => Number(v.replace(/[\s,$%()]/g, '')));
      return nums.every((n) => Number.isInteger(n)) ? 'integer' : 'real';
    }
    if (present.every((v) => ISO_DATE.test(v))) return 'date';
    if (present.every((v) => ISO_DATETIME.test(v))) return 'datetime';
  }
  return 'text';
}

/** A stable natural key from the sample: a unique, non-freetext scalar (preferring
 *  stable names), excluding system columns. Reuses the shared ingest policy over a
 *  bounded live sample — uniqueness is distinct-count === sampled-row-count (with a
 *  full, non-null sample), and FREETEXT (a superset of NEVER_KEY) is excluded, so
 *  the planner is stricter than ingest about what may be a key. */
function pickNaturalKey(stats: ColumnStat[], sampledRows: number): string | null {
  const uniqueInSample = (c: ColumnStat): boolean =>
    !c.distinctIsCapped && c.distinctSampled === sampledRows && c.nullRate === 0 && sampledRows > 0;
  return pickNaturalKeyFrom(
    stats.map((c) => ({
      name: c.name,
      type: c.inferredType,
      isUnique: uniqueInSample(c),
      skip: isSystemColumn(c.name),
    })),
    FREETEXT,
  );
}

/**
 * PURE: build a `TableProfile` from declared structure + a bounded, PK-ordered
 * row sample. All canonicalization + stats happen here so the result is
 * dialect-independent and directly testable.
 */
export function profileTable(struct: TableStructural, rows: Row[]): TableProfile {
  const sampledRowCount = rows.length;
  const pkSet = new Set(struct.primaryKey);
  const fkSet = new Set(
    struct.relations.filter((r) => r.kind === 'belongsTo').map((r) => r.foreignKey),
  );

  const columns: ColumnStat[] = struct.columns.map(({ name, sqlType, canonicalType }) => {
    const distinct = new Set<string>();
    const sampleValues: string[] = [];
    let nullCount = 0;
    const canon: unknown[] = [];
    for (const r of rows) {
      // Canonicalize on the PHYSICAL type (not the canonical field type): user
      // columns are physically TEXT, so this normalizes every column's values the
      // same way. Keying coercion on the declared type instead would make a
      // numeric natural key's values (e.g. '007' → 7) stop matching a text FK's
      // raw '007', dropping an FK the value-overlap check would otherwise find.
      const cv = canonicalizeValue(r[name], sqlType);
      canon.push(cv);
      if (isEmpty(cv)) {
        nullCount++;
        continue;
      }
      const key = norm(cv);
      if (!distinct.has(key) && distinct.size < DISTINCT_CAP) {
        distinct.add(key);
        sampleValues.push(key);
      }
    }
    return {
      name,
      // Retype detection (detect.ts) reads this: surface the canonical declared
      // type when known so an already-typed column isn't proposed for retype,
      // else the raw physical spec. Value canonicalization above deliberately used
      // the physical type, so this only affects the retype decision — not matching.
      sqlType: (canonicalType ?? sqlType).toLowerCase(),
      inferredType: naturalType(canon),
      distinctSampled: distinct.size,
      distinctIsCapped: distinct.size >= DISTINCT_CAP,
      nullRate: sampledRowCount > 0 ? nullCount / sampledRowCount : 0,
      sampleValues,
      isForeignKey: fkSet.has(name),
      isPrimaryKey: pkSet.has(name),
    };
  });

  return {
    name: struct.name,
    tier: struct.tier,
    rowCount: struct.rowCount,
    rowCountCapped: struct.rowCountCapped,
    sampledRowCount,
    primaryKey: struct.primaryKey,
    naturalKey: pickNaturalKey(columns, sampledRowCount),
    columns,
    relations: struct.relations,
    hasDefinition: struct.hasDefinition,
  };
}

/** The minimal Lattice-facade surface the introspect shell needs (kept narrow so
 *  it is easy to stub in tests and to reason about egress). */
export interface IntrospectDb {
  getRegisteredTableNames(): string[];
  getRegisteredColumns(table: string): Record<string, string> | null;
  /** Canonical Lattice field types (`text`/`integer`/`uuid`/`datetime`/…) for the
   *  table's config-declared columns, or null for a code-defined table with no
   *  declared types. Preferred over the raw SQL spec `getRegisteredColumns`
   *  returns, which is lossy+noisy (a config `datetime` is physically TEXT). */
  getRegisteredFieldTypes(table: string): Record<string, string> | null;
  getPrimaryKey(table: string): string[];
  isComputedTable(name: string): boolean;
  getConnectedSource(table: string): unknown;
  connectedTables(): string[];
  query(
    table: string,
    opts: {
      limit?: number;
      orderBy?: string;
      orderDir?: 'asc' | 'desc';
      filters?: { col: string; op: string }[];
    },
  ): Promise<Row[]>;
  boundedCount(table: string, opts: { cap?: number }): Promise<number>;
}

/** A structural view of one table (columns/relations/junction/tier), assembled by
 *  the caller from `getGuiEntities` + facade flags. Keeps `buildModelProfile`
 *  decoupled from the GUI's config-reading details. */
export interface StructuralInput {
  name: string;
  tier: TableTier;
  relations: NormalizedRelation[];
  hasDefinition: boolean;
  /** `{name, a, b}` when this table is a junction (m2m), else null. */
  junctionPair: { a: string; b: string } | null;
}

// The planner only needs to know whether a table is small enough to be FULLY
// sampled (≤ SAMPLE rows) or larger — an exact count beyond the sample is never
// used. Bounding the count just past SAMPLE stops Postgres from scanning up to
// 100k rows PER TABLE on every sweep for a number nothing reads (bounded egress).
const ROW_CAP = SAMPLE + 1;

/**
 * DB-reading shell: one bounded, PK-ordered sample per table, canonicalized
 * through `profileTable`. `structurals` carries the columns/relations/tier the
 * caller resolved from the GUI entity view (relations live in config, not the
 * DB). Tables the planner never touches (hidden/internal) should be omitted by
 * the caller.
 */
export async function buildModelProfile(
  db: IntrospectDb,
  structurals: StructuralInput[],
): Promise<ModelProfile> {
  const tables: TableProfile[] = [];
  const skipped: { table: string; reason: string }[] = [];
  const existingJunctions: { name: string; a: string; b: string }[] = [];
  const existingComputed: string[] = [];

  for (const s of structurals) {
    if (s.tier === 'computed') existingComputed.push(s.name);
    if (s.junctionPair)
      existingJunctions.push({ name: s.name, a: s.junctionPair.a, b: s.junctionPair.b });

    const colTypes = db.getRegisteredColumns(s.name);
    if (!colTypes) {
      skipped.push({ table: s.name, reason: 'no registered columns' });
      continue;
    }
    // Surface the CANONICAL field type ('uuid'/'integer'/'datetime'/…) alongside
    // the raw physical spec. Retype detection uses the canonical type (so a
    // config-declared datetime/integer stored physically as TEXT isn't proposed
    // for retype to the type it already is); value canonicalization uses the
    // physical type so normalization stays symmetric across columns. Code-defined
    // tables with no declared types have no canonicalType → retype falls back to
    // the raw spec.
    const fieldTypes = db.getRegisteredFieldTypes(s.name);
    const columns = Object.entries(colTypes).map(([name, sqlType]) => ({
      name,
      sqlType,
      canonicalType: fieldTypes?.[name],
    }));
    const primaryKey = db.getPrimaryKey(s.name);
    const pkCol = primaryKey[0] ?? (colTypes.id !== undefined ? 'id' : columns[0]?.name);

    let rows: Row[] = [];
    let rowCount = 0;
    let rowCountCapped = false;
    try {
      rowCount = await db.boundedCount(s.name, { cap: ROW_CAP });
      rowCountCapped = rowCount > ROW_CAP;
      // G1: deterministic PK-ordered prefix. G4: a single bounded read. Exclude
      // SOFT-DELETED rows — latticesql has no default `deleted_at` filter, so
      // without this the profile (row counts, distinctness, FK/dedup signals)
      // would be computed over tombstoned rows and mis-detect against dead data.
      const queryOpts: {
        limit: number;
        orderBy?: string;
        orderDir?: 'asc' | 'desc';
        filters?: { col: string; op: string }[];
      } = { limit: SAMPLE };
      if (pkCol) {
        queryOpts.orderBy = pkCol;
        queryOpts.orderDir = 'asc';
      }
      if (colTypes.deleted_at !== undefined) {
        queryOpts.filters = [{ col: 'deleted_at', op: 'isNull' }];
      }
      rows = await db.query(s.name, queryOpts);
    } catch (e) {
      skipped.push({ table: s.name, reason: `sample read failed: ${(e as Error).message}` });
      continue;
    }

    tables.push(
      profileTable(
        {
          name: s.name,
          tier: s.tier,
          columns,
          primaryKey,
          relations: s.relations,
          hasDefinition: s.hasDefinition,
          rowCount,
          rowCountCapped,
        },
        rows,
      ),
    );
  }

  return { tables, existingJunctions, existingComputed, skipped };
}
