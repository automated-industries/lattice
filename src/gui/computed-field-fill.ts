/**
 * GUI driver for #10 AI computed COLUMNS. The schema layer owns the fill engine +
 * the "never serve stale" NULL contract; this layer decides WHEN to fill in the
 * running app: once on open (backfill any NULL cells) and after each write to a
 * table that has AI computed fields. Model calls stay out of the core DB layer —
 * this driver injects the real {@link buildComputedFillLlm} model adapter.
 *
 * Fills are COALESCED per table: at most one fill runs per table at a time, and a
 * write that lands mid-fill sets a dirty flag so exactly one more pass runs after —
 * so a bulk import that fires hundreds of writes does not spawn hundreds of
 * overlapping fill passes (each of which would re-scan the same NULL rows and make
 * duplicate model calls).
 */

import type { ActiveDb } from './active-db.js';
import { buildComputedFillLlm } from './computed-llm.js';

export interface ComputedFieldFillHandle {
  dispose(): void;
}

export function installComputedFieldFill(active: ActiveDb): ComputedFieldFillHandle {
  const db = active.db;
  const tables = db.aiComputedFieldTables();
  if (tables.length === 0) {
    return {
      dispose() {
        /* nothing registered */
      },
    };
  }

  const inFlight = new Set<string>();
  const dirty = new Set<string>();
  let disposed = false;
  const resolveLlm = () => active.computedFillLlm?.() ?? buildComputedFillLlm(db);

  async function runFill(table: string): Promise<void> {
    if (disposed) return;
    if (inFlight.has(table)) {
      dirty.add(table); // a fill is already running — coalesce, run once more after
      return;
    }
    inFlight.add(table);
    try {
      const report = await db.fillComputedFields(table, resolveLlm());
      if (report.failed > 0) {
        // surface, don't swallow. Per-cell derivation failures are not fatal,
        // but the user should see that some cells could not be filled.
        active.feed.publish({
          table,
          op: 'update',
          rowId: null,
          source: 'system',
          summary:
            `AI computed fields on "${table}": ${String(report.filled)} filled, ` +
            `${String(report.failed)} could not be derived` +
            (report.errors[0] ? ` (${report.errors[0]})` : ''),
        });
      }
    } catch (err) {
      // A hard failure (e.g. no model configured) is background work, not a crash — log
      // it and surface it into the feed rather than letting it reject unobserved.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[computed-field-fill] ${table}:`, err);
      active.feed.publish({
        table,
        op: 'update',
        rowId: null,
        source: 'system',
        summary: `AI computed fields on "${table}" could not run: ${msg}`,
      });
    } finally {
      inFlight.delete(table);
      // A write landed mid-fill → run exactly one more pass (runFill itself no-ops if
      // the workspace was disposed in the meantime).
      if (dirty.delete(table)) void runFill(table);
    }
  }

  for (const table of tables) {
    // Watch only the AI input columns for updates — an update that changes an input is
    // exactly when the core NULLs a cell, so that is exactly when a refill is needed.
    const inputs = new Set<string>();
    for (const plan of db.getComputedFieldPlans(table)) {
      if (plan.deferred === 'ai' && plan.ai) for (const col of plan.ai.inputs) inputs.add(col);
    }
    db.defineWriteHook({
      table,
      on: ['insert', 'update'],
      ...(inputs.size > 0 ? { watchColumns: [...inputs] } : {}),
      handler: () => void runFill(table),
    });
    // Backfill any cells already NULL when the workspace opens.
    void runFill(table);
  }

  return {
    dispose() {
      disposed = true;
    },
  };
}
