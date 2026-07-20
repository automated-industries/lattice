/**
 * AI fill for #10 computed COLUMNS (the per-entity replacement for the retired
 * computed-TABLE AI fields). An `ai_classify` / `ai_transform` computed field is a
 * real column that starts NULL and is populated asynchronously by a model. This
 * engine scans a bounded window of un-filled cells (`WHERE "<col>" IS NULL`), calls
 * the injected {@link FillLlm} per row, validates the output, and writes it back with
 * a single targeted `UPDATE … WHERE pk` (bounded, never a whole-table scan).
 *
 * It writes through the raw adapter (NOT `Lattice.update`) so a fill does not re-fire
 * the write hooks that trigger it — that would loop forever. The staleness contract
 * ("a changed input NULLs the cell before the refill") is enforced in the write path
 * (`Lattice._nullStaleAiColumns`); this engine only ever FILLS a NULL cell, so it is
 * safe to run repeatedly and idempotent once every cell is populated.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import type { Row } from '../types.js';
import type { FillLlm } from './computed-fill.js';
import type { AiFieldPlan } from './computed-field.js';

/** One AI computed field to fill: its physical column + its plan. */
export interface AiComputedFieldSpec {
  column: string;
  ai: AiFieldPlan;
}

export interface FieldFillReport {
  /** Cells populated this run. */
  filled: number;
  /** Cells whose model output was rejected/failed (left NULL). */
  failed: number;
  /** First few human-readable failure reasons (never secrets). */
  errors: string[];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const DEFAULT_BATCH = 25;
const DEFAULT_MAX_ROWS = 10_000;
const MAX_ERRORS_KEPT = 10;

/**
 * Fill every NULL cell of the given AI computed fields on `entity`. `pkCol` is the
 * primary-key column; `liveFilter` (e.g. `deleted_at IS NULL`) is appended to the
 * pending scan when the table has that column, so tombstones are skipped. Bounded by
 * `opts.batchSize` per query and `opts.maxRows` total per field (a safety backstop).
 */
export async function fillAiComputedFields(
  adapter: StorageAdapter,
  llm: FillLlm,
  entity: string,
  pkCol: string,
  fields: readonly AiComputedFieldSpec[],
  opts: { batchSize?: number; maxRows?: number; liveFilter?: string } = {},
): Promise<FieldFillReport> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const maxRows = Math.max(batchSize, opts.maxRows ?? DEFAULT_MAX_ROWS);
  const liveClause = opts.liveFilter ? ` AND ${opts.liveFilter}` : '';
  const report: FieldFillReport = { filled: 0, failed: 0, errors: [] };

  for (const field of fields) {
    const inputs = [...new Set(field.ai.inputs)];
    const selectCols = [pkCol, ...inputs].map(quoteIdent).join(', ');
    let processed = 0;

    // Loop bounded windows of NULL cells. Each pass re-scans WHERE col IS NULL, so
    // a row filled this pass drops out of the next — the window advances even though
    // the offset is always 0 (bounded, no OFFSET drift on a mutating set).
    for (;;) {
      if (processed >= maxRows) break;
      const rows = await allAsyncOrSync(
        adapter,
        `SELECT ${selectCols} FROM ${quoteIdent(entity)} ` +
          `WHERE ${quoteIdent(field.column)} IS NULL${liveClause} LIMIT ${String(batchSize)}`,
        [],
      );
      if (rows.length === 0) break;

      let wroteThisPass = 0;
      for (const row of rows) {
        processed += 1;
        const pk = row[pkCol];
        if (pk === undefined || pk === null) continue;
        let value: string | null;
        try {
          value = await computeAiCell(llm, field.ai, row, inputs);
        } catch (err) {
          report.failed += 1;
          pushError(report, `${entity}.${field.column}: ${errText(err)}`);
          continue;
        }
        if (value === null) {
          report.failed += 1;
          pushError(report, `${entity}.${field.column}: model returned no usable value`);
          continue;
        }
        await runAsyncOrSync(
          adapter,
          `UPDATE ${quoteIdent(entity)} SET ${quoteIdent(field.column)} = ? ` +
            `WHERE ${quoteIdent(pkCol)} = ?`,
          [value, pk],
        );
        report.filled += 1;
        wroteThisPass += 1;
      }
      // If a whole pass produced no write (every row failed), stop — otherwise we'd
      // re-scan the same still-NULL rows forever.
      if (wroteThisPass === 0) break;
    }
  }
  return report;
}

/** Run one AI cell through the model, returning the validated value or null. */
async function computeAiCell(
  llm: FillLlm,
  plan: AiFieldPlan,
  row: Row,
  inputs: string[],
): Promise<string | null> {
  if (plan.kind === 'classify') {
    const inputValue = stringifyCell(row[inputs[0] ?? '']);
    if (inputValue === '') return null; // nothing to classify
    const labels = plan.labels ?? [];
    const system =
      `${plan.prompt}\n\nRespond with EXACTLY ONE of these labels, verbatim, and nothing else:\n` +
      labels.map((l) => `- ${l}`).join('\n');
    const raw = (await llm.complete({ system, user: inputValue, model: plan.model })).trim();
    // Strict validation: the output must BE one of the labels (case-insensitive match →
    // canonical casing). A model that ignores the instruction leaves the cell NULL
    // rather than writing an invalid label.
    const match = labels.find((l) => l.toLowerCase() === raw.toLowerCase());
    return match ?? null;
  }
  // transform: apply the prompt to the (labelled) inputs, free-text output.
  const body = inputs.map((c) => `${c}: ${stringifyCell(row[c])}`).join('\n');
  const out = (await llm.complete({ system: plan.prompt, user: body, model: plan.model })).trim();
  return out === '' ? null : out;
}

function stringifyCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

function pushError(report: FieldFillReport, msg: string): void {
  if (report.errors.length < MAX_ERRORS_KEPT) report.errors.push(msg);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
