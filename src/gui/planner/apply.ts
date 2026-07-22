import type { AppliedOp, PlanOp } from './types.js';

/**
 * Apply a single `PlanOp`. The actual mutation is done through injected `deps`
 * that wrap the existing AUDITED schema primitives (so every change lands on the
 * version-history undo stack); `applyDepsFor` builds the real ones from an
 * `ActiveDb`. The seam keeps this module unit-testable without a live workspace
 * and mirrors the designer's `ExecFn` pattern.
 *
 * G8 (fail boundary): `applyPlanOp` does NOT swallow — a thrown primitive error
 * propagates to the caller. The unattended `runAutoTier` catches per-op (the
 * pass runs after the ingest already succeeded, so it must never rethrow); an
 * interactive apply route lets the error surface (Rule 16). The swallow lives in
 * the caller, never here.
 */
export interface ApplyDeps {
  /** Declare a belongsTo relationship: `child.column` references `parent` (the
   *  detected FK). A config-only `relations:` entry over the EXISTING column — not
   *  a junction table — so it represents the 1:many FK it detected. Null = not
   *  creatable (native/computed/source target, missing column, already related,
   *  invalid). Reversible (removes just the relation). */
  addRelationship(
    child: string,
    column: string,
    parent: string,
  ): Promise<{ relationName: string } | null>;
  /** Upsert a table definition. (Metadata; see the set-definition-audit follow-up.) */
  documentTable(table: string, description: string): Promise<void>;
  /** Move all rows of `source` into `target`, then retire `source`. Reversible. */
  mergeTables(source: string, target: string): Promise<{ ok: boolean; error?: string }>;
  /** Merge duplicate rows in a table by its natural key. Reversible. */
  dedupRows(table: string): Promise<{ ok: boolean; error?: string }>;
  /** Rename a table to a canonical identifier. Reversible (reference-breaking). */
  renameTable(from: string, to: string): Promise<{ ok: boolean; error?: string }>;
  /** Extract a repeated column into its own dimension table + relationship. */
  extractDimension(
    table: string,
    column: string,
    dimTable: string,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Retype a TEXT column to a narrower type (rewrites stored values). */
  retypeColumn(
    table: string,
    column: string,
    toType: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

function done(
  op: PlanOp,
  ok: boolean,
  summary: string,
  extra: { auditId?: string | undefined; error?: string | undefined } = {},
): AppliedOp {
  const out: AppliedOp = { id: op.id, kind: op.kind, summary, ok };
  if (extra.auditId !== undefined) out.auditId = extra.auditId;
  if (extra.error !== undefined) out.error = extra.error;
  return out;
}

export async function applyPlanOp(op: PlanOp, deps: ApplyDeps): Promise<AppliedOp> {
  switch (op.kind) {
    case 'add_relationship': {
      const { table, column, toTable } = op.target;
      if (!toTable) return done(op, false, op.rationale, { error: 'missing target table' });
      if (!column) return done(op, false, op.rationale, { error: 'missing foreign-key column' });
      const r = await deps.addRelationship(table, column, toTable);
      return r
        ? done(op, true, `Related ${table} → ${toTable}`, { auditId: r.relationName })
        : done(op, false, op.rationale, {
            error:
              'relationship not created (already related, target native/read-only, or a junction exists)',
          });
    }
    case 'document': {
      const t = (op.evidence as { text?: unknown }).text;
      const text = typeof t === 'string' ? t : op.rationale;
      await deps.documentTable(op.target.table, text);
      return done(op, true, `Documented ${op.target.table}`);
    }
    case 'merge_tables': {
      const { table, toTable } = op.target;
      if (!toTable) return done(op, false, op.rationale, { error: 'missing merge target' });
      const r = await deps.mergeTables(table, toTable);
      return done(op, r.ok, r.ok ? `Merged ${table} into ${toTable}` : op.rationale, {
        error: r.error,
      });
    }
    case 'dedup_rows': {
      const r = await deps.dedupRows(op.target.table);
      return done(op, r.ok, r.ok ? `Deduplicated ${op.target.table}` : op.rationale, {
        error: r.error,
      });
    }
    case 'canonical_rename': {
      const { table, toTable } = op.target;
      if (!toTable) return done(op, false, op.rationale, { error: 'missing rename target' });
      const r = await deps.renameTable(table, toTable);
      return done(op, r.ok, r.ok ? `Renamed ${table} → ${toTable}` : op.rationale, {
        error: r.error,
      });
    }
    case 'extract_dimension': {
      const { table, column, toTable } = op.target;
      if (!column || !toTable)
        return done(op, false, op.rationale, { error: 'missing column/target' });
      const r = await deps.extractDimension(table, column, toTable);
      return done(op, r.ok, r.ok ? `Extracted ${table}.${column} → ${toTable}` : op.rationale, {
        error: r.error,
      });
    }
    case 'retype_column': {
      const { table, column } = op.target;
      const rawTo = (op.evidence as { to?: unknown }).to;
      const to = typeof rawTo === 'string' ? rawTo : '';
      if (!column || !to) return done(op, false, op.rationale, { error: 'missing column/type' });
      const r = await deps.retypeColumn(table, column, to);
      return done(op, r.ok, r.ok ? `Retyped ${table}.${column} to ${to}` : op.rationale, {
        error: r.error,
      });
    }
  }
}

/**
 * Run every AUTO-tier op, catching per-op so one failure never aborts the pass
 * or breaks the ingest/connect that triggered it (fail-soft — this is the
 * unattended caller's swallow boundary, G8).
 */
export async function runAutoTier(ops: PlanOp[], deps: ApplyDeps): Promise<AppliedOp[]> {
  const applied: AppliedOp[] = [];
  for (const op of ops) {
    if (op.tier !== 'auto') continue;
    try {
      applied.push(await applyPlanOp(op, deps));
    } catch (e) {
      applied.push({
        id: op.id,
        kind: op.kind,
        summary: op.rationale,
        ok: false,
        error: (e as Error).message,
      });
    }
  }
  return applied;
}
