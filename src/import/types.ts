/**
 * Types for the structured-source importer: turning a parsed JSON source into a
 * proposed Lattice schema (entities, dimensions, linkages) that the user reviews
 * before anything is written. The inference step ({@link inferSchema}) returns a
 * {@link ProposedSchema}; the user approves (optionally trims) it; the
 * materialize step creates the tables, rows, and junctions from it.
 *
 * Derived / computed values are intentionally NOT modeled here — they belong to a
 * later dashboard→Lattice write-back feature, not source ingestion.
 */

/** Canonical column types we infer from JSON values. Maps onto Lattice field types. */
export type InferredType = 'integer' | 'real' | 'boolean' | 'date' | 'datetime' | 'text';

export interface InferredColumn {
  /** Normalized snake_case column name. */
  name: string;
  /** Original JSON key (may differ from {@link name}). */
  sourceKey: string;
  type: InferredType;
}

/**
 * A relationship inferred between two entities (or an entity and a normalized
 * dimension). Reported with match counts + a confidence so the user can judge it
 * before approving — links are never applied silently.
 */
export interface InferredLinkage {
  kind: 'many-to-many' | 'many-to-one' | 'dimension';
  /** Entity table the reference lives on (normalized name). */
  fromEntity: string;
  /** Source JSON key on the entity holding the reference value(s). */
  fromField: string;
  /** Target entity/dimension table (normalized name). */
  toEntity: string;
  /** Natural-key column on the target used to resolve a reference value. */
  toKey: string;
  /** Junction table name (many-to-many + dimension links). */
  junction?: string;
  /** Distinct reference values that resolve to a target row. */
  matched: number;
  /** Distinct reference values that do NOT resolve (reported, never fatal). */
  unresolved: number;
  /** 0..1 — share of distinct reference values that resolved. */
  confidence: number;
}

export interface InferredEntity {
  /** Normalized snake_case table name. */
  name: string;
  /** Original top-level JSON key. */
  sourceKey: string;
  /** Scalar columns only — array/linkage fields and dimension-extracted columns are excluded. */
  columns: InferredColumn[];
  /** Natural-key column name (normalized), or null = keyless (surrogate id + content-hash dedup). */
  naturalKey: string | null;
  /** Original JSON key for the natural key (un-normalized), or null. Used to read source records. */
  naturalKeySource: string | null;
  rowCount: number;
  /** True when reconstructed from `<key>` (array of arrays) + `<key>Cols` (column dictionary). */
  columnar: boolean;
}

export interface InferredDimension {
  /** Dimension table name (e.g. `industry`). */
  name: string;
  /** Source column key the values come from. */
  sourceField: string;
  /** Entities that contribute values to this dimension. */
  fromEntities: string[];
  distinctValues: number;
}

export interface ProposedSchema {
  entities: InferredEntity[];
  dimensions: InferredDimension[];
  linkages: InferredLinkage[];
  /**
   * Link candidates in the marginal confidence band — at or above the "drop as
   * noise" floor but below the creation threshold (see `InferOptions.
   * minLinkConfidence`). NOT materialized: the referencing column survives as a
   * plain scalar column, and the importer asks the user whether to connect it
   * instead of guessing. Same shape as {@link linkages}, confidence included.
   */
  marginalLinks: InferredLinkage[];
  /** Top-level keys not imported (derived rollups, meta, scalars, column dictionaries). */
  skipped: { key: string; reason: string }[];
}

/**
 * An entity recognized as a reconstructable projection of another (a "master")
 * table — its rows are contained in the master, filtered by one column. It is
 * materialized as a read-only DB VIEW (`master WHERE filterColumn = filterValue`)
 * rather than a duplicate table.
 */
export interface DetectedView {
  /** The view's name (normalized) — the original tab/entity. */
  name: string;
  /** The master entity (normalized) this view projects from. */
  master: string;
  /** Master column the view filters on (normalized). */
  filterColumn: string;
  /** The value `filterColumn` equals for this view. */
  filterValue: string;
  /** Number of master rows that matched (the view's row count). */
  matchedRows: number;
}
