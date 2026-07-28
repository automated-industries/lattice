import type { InferredType } from '../../import/types.js';

/**
 * Data-model planner — shared types.
 *
 * The planner is a three-layer pipeline:
 *   introspect  →  ModelProfile  (the ONLY layer that reads the DB; bounded)
 *   detect      →  PlanOp[]      (a PURE function; no DB, no LLM, deterministic)
 *   apply       →  DataModelPlan (AUTO reversible fixes applied; PROPOSE queued)
 *
 * Because `detect` is pure over a `ModelProfile`, the whole rules engine is
 * unit-testable on fixtures with no database and no model provider — which is
 * what makes "deterministic" real: the same model always yields the same plan.
 */

/** Where a table came from — the planner only ever RESTRUCTURES `lattice` tables. */
export type TableTier = 'lattice' | 'source' | 'computed' | 'junction';

/** A relationship as the planner reasons about it (normalized from the schema's
 *  belongsTo/hasMany `Relation` so `detect` stays decoupled from schema internals). */
export interface NormalizedRelation {
  name: string;
  kind: 'belongsTo' | 'hasMany';
  targetTable: string;
  /** The FK column (on the child, for belongsTo). */
  foreignKey: string;
}

export interface ColumnStat {
  name: string;
  /** The declared SQL type (canonicalized lower-case, dialect-independent). */
  sqlType: string;
  /** The type inferred from the sampled VALUES (may differ from sqlType → retype signal). */
  inferredType: InferredType;
  /** Distinct non-null values seen in the bounded sample, capped at the distinct cap. */
  distinctSampled: number;
  /** True when `distinctSampled` hit the cap — a lower bound, so coverage is not exact. */
  distinctIsCapped: boolean;
  /** Fraction of sampled rows where this column was null/empty (0..1). */
  nullRate: number;
  /** Normalized (see infer-core `norm`) distinct sample values — for FK matching + evidence. */
  sampleValues: string[];
  /** Already backed by a belongsTo FK relation. */
  isForeignKey: boolean;
  /** Part of the table's primary key. */
  isPrimaryKey: boolean;
}

export interface TableProfile {
  name: string;
  tier: TableTier;
  /** Bounded row count (see `boundedCount`); `rowCountCapped` when it hit the cap. */
  rowCount: number;
  rowCountCapped: boolean;
  /** How many rows were actually pulled into the sample (≤ SAMPLE, ≤ rowCount). */
  sampledRowCount: number;
  primaryKey: string[];
  /** A stable natural key column (id/code/slug/…) if one is discernible. */
  naturalKey: string | null;
  columns: ColumnStat[];
  /** EXISTING relations — required so `detect` never re-proposes a satisfied link (idempotence). */
  relations: NormalizedRelation[];
  /** True when the table has an authored/auto definition in the GUI meta table. */
  hasDefinition: boolean;
}

export interface ModelProfile {
  tables: TableProfile[];
  /** Existing junction tables (m2m) — suppress duplicate-relationship proposals. */
  existingJunctions: { name: string; a: string; b: string }[];
  /** Existing computed views — suppress duplicate-view proposals. */
  existingComputed: string[];
  /** Tables the introspect layer intentionally skipped, with why (for transparency). */
  skipped: { table: string; reason: string }[];
}

export type PlanClass = 'additive' | 'restructure';
export type PlanTier = 'auto' | 'propose';

/** Ops that change how the model is BUILT (structure, types, rows). */
export type PlanOpKind =
  | 'add_relationship'
  | 'document'
  | 'extract_dimension'
  | 'dedup_rows'
  | 'merge_tables'
  | 'retype_column'
  | 'canonical_rename';

/**
 * Ops that change what a table IS SAID to be rather than how it is built —
 * recording its role in the model, or giving a placeholder-named table a name.
 * Separate from {@link PlanOpKind} because they are applied through the
 * metadata/rename primitives rather than the structural appliers; identical in
 * every other respect (same shape, same AUTO/PROPOSE tiering, same dismiss key).
 */
export type ShapeOpKind = 'assign_role' | 'rename_generic_table';

/** Every kind of op the planner can emit. */
export type AnyPlanOpKind = PlanOpKind | ShapeOpKind;

/** The shape shared by every planner op, parameterized by its kind. */
export interface PlanOpOf<K extends AnyPlanOpKind> {
  /** Stable fingerprint (kind + normalized operands) — dedup across passes, dismiss key. */
  id: string;
  kind: K;
  class: PlanClass;
  tier: PlanTier;
  target: { table: string; column?: string; toTable?: string };
  /** Human-readable, structural-facts-only rationale (no LLM prose). */
  rationale: string;
  /** 0..1. For sample-bounded signals this is an estimate; see `evidence`. */
  confidence: number;
  evidence: Record<string, unknown>;
}

export type PlanOp = PlanOpOf<PlanOpKind>;
export type ShapeOp = PlanOpOf<ShapeOpKind>;
export type AnyPlanOp = PlanOpOf<AnyPlanOpKind>;

/** A planner op the AUTO tier actually applied, with the audit id for undo. */
export interface AppliedOp {
  id: string;
  kind: AnyPlanOpKind;
  summary: string;
  ok: boolean;
  auditId?: string;
  error?: string;
}

export interface DataModelPlan {
  autoApplied: AppliedOp[];
  proposals: PlanOp[];
  /**
   * Pending {@link ShapeOp} proposals (what a table IS / what it should be
   * called). Kept in their own list because they are applied through the
   * metadata + rename primitives rather than the structural appliers; a caller
   * that does not carry table-role state simply omits the field.
   */
  shapeProposals?: ShapeOp[];
  /** Ties a plan to the profile it was computed from. */
  profileHash: string;
}
