/**
 * Compiler for serializable COMPUTED COLUMNS (#10) — the per-entity replacement for the
 * read-only computed-TABLE views. A computed field (`LatticeFieldDef.computed`) is a real,
 * materialized column whose value is derived by one of five kinds
 * (alias / calc / ai_classify / ai_transform / aggregate). This module compiles a
 * DETERMINISTIC field (alias / calc) into a bounded SQL scalar expression the runtime
 * recomputes on write via a single targeted `UPDATE … WHERE pk = ?` (one row).
 *
 * The SQL is emitted through the SAME `emitCalcExpr` the retired view compiler used, so
 * there is one source of truth for calc semantics (no JS/SQL divergence). Non-deterministic
 * or non-same-row kinds are returned as DEFERRED — the field is valid and registered, but
 * its value is produced by a later mechanism (the AI fill engine for ai_* kinds; the
 * aggregate/belongsTo-path recompute) rather than the synchronous write-path UPDATE.
 */

import type { ComputedFieldDef } from '../config/types.js';
import { parseCalcExpr, emitCalcExpr, type CalcDialect } from './calc-expr.js';

/** Double-quote a SQL identifier (both SQLite + Postgres). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Why a computed field is not recomputed by the synchronous same-row UPDATE path. */
export type DeferredReason =
  | 'ai' // ai_classify / ai_transform — filled asynchronously by the fill engine
  | 'aggregate' // aggregate over a junction — a correlated subquery recompute
  | 'path'; // an alias/calc that references a belongsTo path (not same-row)

/** AI-fill recompute metadata, carried so the runtime never re-parses the def. */
export interface AiFieldPlan {
  kind: 'classify' | 'transform';
  /** Same-row columns fed to the model — a write to any of these invalidates the cell. */
  inputs: string[];
  prompt: string;
  /** Allowed labels (classify only). */
  labels?: string[];
  model: 'default' | 'cheapest';
}

/** Aggregate recompute metadata, carried so the runtime never re-parses the def. */
export interface AggregateFieldPlan {
  /** Junction/child table folded into one scalar per base row. */
  junction: string;
  /** Remote relation/column segment of `via` (`'<junction>.<remote>'`). */
  remote: string;
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'concat';
  /** Remote column to aggregate (required for every fn except count). */
  column?: string;
}

export interface CompiledComputedField {
  /** The physical column the value materializes into. */
  column: string;
  /** SQL scalar expression over the base row's OWN columns, for the recompute UPDATE.
   *  Empty when {@link deferred} is set. */
  sql: string;
  /** Same-row columns this value depends on (drives dep-gated recompute). Empty for
   *  aggregate/path; for a deferred `ai` field these ARE populated (the AI cell is
   *  invalidated when an input column changes). */
  deps: string[];
  /** Set when the value is produced by a later mechanism, not the same-row UPDATE. */
  deferred?: DeferredReason;
  /** Present iff `deferred === 'ai'` — drives the async fill + staleness. */
  ai?: AiFieldPlan;
  /** Present iff `deferred === 'aggregate'` — drives the correlated-subquery recompute. */
  aggregate?: AggregateFieldPlan;
}

/**
 * Compile one computed field. `entityColumns` is the set of the entity's OWN (non-computed)
 * column names, used to validate same-row references. Throws on an alias/calc that
 * references an unknown same-row column (a genuine config error, surfaced loudly).
 */
export function compileComputedField(
  entity: string,
  fieldName: string,
  def: ComputedFieldDef,
  entityColumns: ReadonlySet<string>,
  dialect: CalcDialect,
): CompiledComputedField {
  const deferred = (reason: DeferredReason): CompiledComputedField => ({
    column: fieldName,
    sql: '',
    deps: [],
    deferred: reason,
  });

  /** A same-row input column must be a real column of the entity — loud otherwise. */
  const requireOwnColumn = (col: string, role: string): void => {
    if (col.includes('.')) {
      throw new Error(
        `Lattice: computed field "${entity}.${fieldName}" ${role} references "${col}", but a ` +
          `belongsTo path is not allowed as an AI input — use a same-row column of "${entity}".`,
      );
    }
    if (!entityColumns.has(col)) {
      throw new Error(
        `Lattice: computed field "${entity}.${fieldName}" ${role} references "${col}", which is ` +
          `not a column of "${entity}".`,
      );
    }
  };

  switch (def.kind) {
    case 'ai_classify': {
      requireOwnColumn(def.input, 'input');
      return {
        column: fieldName,
        sql: '',
        deps: [def.input],
        deferred: 'ai',
        ai: {
          kind: 'classify',
          inputs: [def.input],
          prompt: def.prompt,
          labels: def.labels,
          model: def.model ?? 'default',
        },
      };
    }
    case 'ai_transform': {
      if (def.inputs.length === 0) {
        throw new Error(
          `Lattice: computed field "${entity}.${fieldName}" (ai_transform) declares no inputs.`,
        );
      }
      for (const col of def.inputs) requireOwnColumn(col, 'input');
      const inputs = [...new Set(def.inputs)];
      return {
        column: fieldName,
        sql: '',
        deps: inputs,
        deferred: 'ai',
        ai: { kind: 'transform', inputs, prompt: def.prompt, model: def.model ?? 'default' },
      };
    }
    case 'aggregate': {
      const dot = def.via.indexOf('.');
      if (dot <= 0 || dot === def.via.length - 1) {
        throw new Error(
          `Lattice: computed field "${entity}.${fieldName}" (aggregate) has an invalid \`via\` ` +
            `"${def.via}" — expected "<junctionTable>.<remoteRelationOrColumn>".`,
        );
      }
      if (def.fn !== 'count' && (def.column === undefined || def.column === '')) {
        throw new Error(
          `Lattice: computed field "${entity}.${fieldName}" (aggregate) uses fn "${def.fn}", which ` +
            `requires a \`column\` to aggregate (only \`count\` may omit it).`,
        );
      }
      return {
        column: fieldName,
        sql: '',
        deps: [],
        deferred: 'aggregate',
        aggregate: {
          junction: def.via.slice(0, dot),
          remote: def.via.slice(dot + 1),
          fn: def.fn,
          ...(def.column !== undefined ? { column: def.column } : {}),
        },
      };
    }
    case 'alias': {
      // A belongsTo path (dotted) is not a same-row value — defer to the path recompute.
      if (def.source.includes('.')) return deferred('path');
      if (!entityColumns.has(def.source)) {
        throw new Error(
          `Lattice: computed field "${entity}.${fieldName}" aliases "${def.source}", which is ` +
            `not a column of "${entity}".`,
        );
      }
      return { column: fieldName, sql: quoteIdent(def.source), deps: [def.source] };
    }
    case 'calc': {
      // Accept a belongsTo-path ref so the calc parses (we DEFER it below); a
      // single-segment ref must be a real same-row column, else it's a config error.
      const expr = parseCalcExpr(def.expr, (path) =>
        path.length === 1 ? entityColumns.has(path[0] ?? '') : true,
      );
      // A belongsTo-path (multi-segment) ref makes this not a same-row value — defer it.
      if (expr.columnPaths.some((p) => p.length !== 1)) return deferred('path');
      const sql = emitCalcExpr(expr, {
        dialect,
        columnSql: (path) => quoteIdent(path[0] ?? ''),
      });
      const deps = expr.columnPaths.map((p) => p[0] ?? '').filter((c) => c.length > 0);
      return { column: fieldName, sql, deps: [...new Set(deps)] };
    }
  }
}

/** Compile every computed field on an entity. */
export function compileComputedFields(
  entity: string,
  computedFields: Record<string, ComputedFieldDef>,
  entityColumns: ReadonlySet<string>,
  dialect: CalcDialect,
): CompiledComputedField[] {
  return Object.entries(computedFields).map(([name, def]) =>
    compileComputedField(entity, name, def, entityColumns, dialect),
  );
}
