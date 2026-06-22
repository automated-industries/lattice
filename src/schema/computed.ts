/**
 * Declarative computed columns + materialized rollups.
 *
 * **Computed columns** are stored columns derived from other columns on the same
 * row by a pure function. They are recomputed on every write (and on a full
 * `refreshComputedColumns`), so a consumer can index / filter / sort on a derived
 * value without recomputing it per query, and an external edit to the rendered
 * file can't desync it — the next write recomputes it.
 *
 * **Materialized rollups** are stored aggregates over a child table (e.g.
 * `post.comment_count`). They are recomputed incrementally when the child table
 * changes and in full via `refreshMaterializedRollups`.
 *
 * Both are opt-in per table and inert otherwise.
 */

import type { Row } from '../types.js';

export interface ComputedColumnSpec {
  /** Columns this value is derived from. Drives recompute-on-change + cycle check. */
  deps: string[];
  /** Pure derivation from the row. Receives the full (merged) row. */
  compute: (row: Row) => unknown;
  /** SQL column type. Default `TEXT`. */
  type?: string;
}

export type RollupFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface MaterializedRollupSpec {
  /** Child table to aggregate. */
  sourceTable: string;
  /** Column on the child table that references this table's primary key. */
  foreignKey: string;
  /** Aggregate function. */
  fn: RollupFunction;
  /** Child column to aggregate (omit for `count`). */
  column?: string;
  /** SQL column type for the stored rollup. Default `REAL`. */
  type?: string;
}

/**
 * Thrown when computed columns form a dependency cycle (A→B→A), which would make
 * the recompute order undefined. Detected once at init.
 */
export class ComputedColumnCycleError extends Error {
  constructor(
    readonly table: string,
    readonly cycle: string[],
  ) {
    super(`Computed columns on "${table}" form a dependency cycle: ${cycle.join(' → ')}`);
    this.name = 'ComputedColumnCycleError';
  }
}

/**
 * Validate that computed columns have no dependency cycle and return a safe
 * recompute order (dependencies before dependents). Only deps that are
 * themselves computed columns participate in ordering; deps on plain columns are
 * leaves. Throws {@link ComputedColumnCycleError} on a cycle.
 */
export function computedColumnOrder(
  table: string,
  computed: Record<string, ComputedColumnSpec>,
): string[] {
  const names = new Set(Object.keys(computed));
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, path: string[]): void => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      const start = path.indexOf(name);
      throw new ComputedColumnCycleError(table, [...path.slice(start), name]);
    }
    state.set(name, 'visiting');
    const spec = computed[name];
    if (spec) {
      for (const dep of spec.deps) {
        if (names.has(dep)) visit(dep, [...path, name]);
      }
    }
    state.set(name, 'done');
    order.push(name);
  };

  for (const name of names) visit(name, []);
  return order;
}

/**
 * Compute the values for `computed` columns from a (full) row, in dependency
 * order, mutating the working row so later computed columns can read earlier
 * ones. Returns a map of computed column → value.
 */
export function computeColumns(
  computed: Record<string, ComputedColumnSpec>,
  order: string[],
  row: Row,
): Record<string, unknown> {
  const working: Row = { ...row };
  const out: Record<string, unknown> = {};
  for (const name of order) {
    const spec = computed[name];
    if (!spec) continue;
    const v = spec.compute(working);
    working[name] = v;
    out[name] = v;
  }
  return out;
}

/** The DDL column spec map computed columns contribute. */
export function computedColumnDdl(
  computed: Record<string, ComputedColumnSpec>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(computed)) out[name] = spec.type ?? 'TEXT';
  return out;
}

/** The DDL column spec map materialized rollups contribute. */
export function rollupColumnDdl(
  rollups: Record<string, MaterializedRollupSpec>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(rollups)) {
    out[name] = spec.type ?? (spec.fn === 'count' ? 'INTEGER DEFAULT 0' : 'REAL');
  }
  return out;
}

/** The set of all dep columns across computed specs (for change detection). */
export function allComputedDeps(computed: Record<string, ComputedColumnSpec>): Set<string> {
  const deps = new Set<string>();
  for (const spec of Object.values(computed)) for (const d of spec.deps) deps.add(d);
  return deps;
}
