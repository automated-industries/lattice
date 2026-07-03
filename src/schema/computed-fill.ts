/**
 * AI-fill engine for computed tables.
 *
 * AI-derived fields never re-run a model at read time: model outputs are
 * materialized once into shared bookkeeping tables that the computed-table
 * view LEFT JOINs, so reads are always deterministic SQL.
 *
 * Three unregistered `__lattice_` bookkeeping tables (raw DDL, dialect-neutral,
 * no SQL-side defaults — every writer supplies explicit ISO timestamps, keeping
 * the CREATE byte-identical across dialects):
 *
 * - `__lattice_ai_map` — classifier memo: one row per (field, distinct input
 *   value). `label` is NULLABLE: NULL records "the model declined", kept so the
 *   same value is never re-asked. The view joins on the CAST-to-TEXT input.
 * - `__lattice_ai_cell` — per-row transform output, keyed (field, row). The
 *   `input_key` column stores the SQL-computed concatenation of the field's
 *   inputs; the view's join also matches on it, so a changed source row makes
 *   the join miss and the field reads NULL until the next fill (never stale).
 * - `__lattice_computed_state` — per-(table, field) fill status for progress
 *   and error reporting. Registration failures land here under field `'*'`.
 *
 * The LLM is INJECTED via the minimal {@link FillLlm} interface — this module
 * performs no model calls of its own and the schema layer stays free of any
 * client dependency. The `model` string passed through is the field's declared
 * tier (`'default'` / `'cheapest'`); the adapter maps it to a real model id.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import type { CompiledComputedTable, CompiledAiField } from './computed-table.js';

export const AI_MAP_TABLE = '__lattice_ai_map';
export const AI_CELL_TABLE = '__lattice_ai_cell';
export const COMPUTED_STATE_TABLE = '__lattice_computed_state';

/**
 * Minimal LLM interface the fill engine depends on. Callers adapt their own
 * client: `model` arrives as the field's declared tier ('default'/'cheapest');
 * the implementation resolves it to a concrete model. The returned string is
 * the raw completion text.
 */
export interface FillLlm {
  complete(opts: { system: string; user: string; model: string }): Promise<string>;
}

export interface ComputedFillOptions {
  /** Pending items fetched (and classifier values sent) per model call. Default 50. */
  batchSize?: number;
}

/** Per-field outcome of a fill run. */
export interface FieldFillResult {
  /** Bare field name. */
  field: string;
  /** Cache key: `<table>.<field>`. */
  key: string;
  kind: 'ai_classify' | 'ai_transform';
  /** 'idle' when the field converged; 'error' when it stopped early. */
  status: 'idle' | 'error';
  /** Rows/values materialized by THIS run. */
  filled: number;
  /** Items still unfilled after the run (0 unless the field errored). */
  pending: number;
  error?: string;
}

/** Report returned by {@link runComputedFill}. Errors are returned, never thrown away. */
export interface ComputedFillReport {
  table: string;
  fields: FieldFillResult[];
}

/** A row of `__lattice_computed_state`. */
export interface ComputedFieldState {
  table_name: string;
  field: string;
  status: 'idle' | 'running' | 'error';
  error: string | null;
  pending: number | null;
  filled: number | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Create the three bookkeeping tables if absent. Idempotent; safe on both
 * dialects (plain TEXT/INTEGER columns, composite PKs, no defaults).
 */
export async function ensureAiTables(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${AI_MAP_TABLE}" (
       "field_key"   TEXT NOT NULL,
       "input_value" TEXT NOT NULL,
       "label"       TEXT,
       "model"       TEXT NOT NULL,
       "prompt_hash" TEXT NOT NULL,
       "created_at"  TEXT NOT NULL,
       PRIMARY KEY ("field_key", "input_value")
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${AI_CELL_TABLE}" (
       "field_key"   TEXT NOT NULL,
       "row_id"      TEXT NOT NULL,
       "input_key"   TEXT NOT NULL,
       "output"      TEXT,
       "model"       TEXT NOT NULL,
       "prompt_hash" TEXT NOT NULL,
       "created_at"  TEXT NOT NULL,
       PRIMARY KEY ("field_key", "row_id")
     )`,
  );
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${COMPUTED_STATE_TABLE}" (
       "table_name"  TEXT NOT NULL,
       "field"       TEXT NOT NULL,
       "status"      TEXT NOT NULL,
       "error"       TEXT,
       "pending"     INTEGER,
       "filled"      INTEGER,
       "started_at"  TEXT,
       "finished_at" TEXT,
       PRIMARY KEY ("table_name", "field")
     )`,
  );
}

/** Deterministic FNV-1a hash (hex) — bookkeeping identity for a field's prompt. */
function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The prompt-identity hash stored on each materialized row. */
function promptHash(field: CompiledAiField): string {
  return fnv1aHex(
    JSON.stringify({
      prompt: field.prompt,
      labels: field.labels ?? null,
      inputs: field.inputs,
      model: field.model,
    }),
  );
}

/** Upsert a `__lattice_computed_state` row (both dialects support ON CONFLICT). */
async function upsertState(
  adapter: StorageAdapter,
  row: {
    table: string;
    field: string;
    status: 'idle' | 'running' | 'error';
    error?: string | null;
    pending?: number | null;
    filled?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${COMPUTED_STATE_TABLE}"
       ("table_name","field","status","error","pending","filled","started_at","finished_at")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT ("table_name","field") DO UPDATE SET
       "status" = excluded."status",
       "error" = excluded."error",
       "pending" = excluded."pending",
       "filled" = excluded."filled",
       "started_at" = excluded."started_at",
       "finished_at" = excluded."finished_at"`,
    [
      row.table,
      row.field,
      row.status,
      row.error ?? null,
      row.pending ?? null,
      row.filled ?? null,
      row.startedAt ?? null,
      row.finishedAt ?? null,
    ],
  );
}

/**
 * Record a table-level registration failure under field `'*'`. Called by the
 * registration path so a computed table that failed to compile at open is
 * visible in the same place fill errors are.
 */
export async function recordComputedTableError(
  adapter: StorageAdapter,
  table: string,
  error: string,
): Promise<void> {
  await upsertState(adapter, {
    table,
    field: '*',
    status: 'error',
    error,
    finishedAt: new Date().toISOString(),
  });
}

/** Clear a prior table-level registration error (successful re-registration). */
export async function clearComputedTableError(
  adapter: StorageAdapter,
  table: string,
): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = ? AND "field" = '*'`,
    [table],
  );
}

/** Read the fill/error state rows for one computed table. */
export async function readComputedState(
  adapter: StorageAdapter,
  tableName: string,
): Promise<ComputedFieldState[]> {
  const rows = await allAsyncOrSync(
    adapter,
    `SELECT * FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = ? ORDER BY "field"`,
    [tableName],
  );
  return rows as unknown as ComputedFieldState[];
}

/**
 * Delete every materialized output + state row for one field. Called when the
 * field's DEFINITION changes (prompt, labels, model, inputs) — the cached
 * outputs no longer describe the field, so they are purged and the next fill
 * re-derives them. `fieldKey` is `'<table>.<field>'`.
 */
export async function purgeAiField(adapter: StorageAdapter, fieldKey: string): Promise<void> {
  await runAsyncOrSync(adapter, `DELETE FROM "${AI_MAP_TABLE}" WHERE "field_key" = ?`, [fieldKey]);
  await runAsyncOrSync(adapter, `DELETE FROM "${AI_CELL_TABLE}" WHERE "field_key" = ?`, [fieldKey]);
  const dot = fieldKey.indexOf('.');
  if (dot > 0) {
    await runAsyncOrSync(
      adapter,
      `DELETE FROM "${COMPUTED_STATE_TABLE}" WHERE "table_name" = ? AND "field" = ?`,
      [fieldKey.slice(0, dot), fieldKey.slice(dot + 1)],
    );
  }
}

/**
 * Auto-invalidate materialized AI values whose stored `prompt_hash` no longer
 * matches the field's CURRENT definition hash — the safety net that makes the
 * stored hash load-bearing. A definition can change through ANY path (the GUI
 * ops layer, a hand-edited YAML, a member-hydrated config); whichever path it
 * took, the next registration calls this and the stale field's whole cache is
 * purged (map + cell + fill state), so its values re-pend instead of serving
 * outputs derived from a prompt/labels/model/inputs that no longer exist.
 *
 * Batched for pooled-connection opens: ONE probe query covers every field at
 * once, and — only when something is stale — three keyed DELETEs follow. The
 * common converged open pays a single round-trip. Purging is whole-field
 * (mirrors {@link purgeAiField}): a key with ANY mismatched row drops all its
 * rows, so a fill interrupted mid-definition-change can never leave a mixed
 * cache. Returns the purged field keys.
 */
export async function purgeStaleAiFields(
  adapter: StorageAdapter,
  fields: readonly CompiledAiField[],
): Promise<string[]> {
  if (fields.length === 0) return [];
  const where = fields.map(() => `("field_key" = ? AND "prompt_hash" <> ?)`).join(' OR ');
  const params = fields.flatMap((f) => [f.key, promptHash(f)]);
  const staleRows = await allAsyncOrSync(
    adapter,
    `SELECT DISTINCT "field_key" FROM "${AI_MAP_TABLE}" WHERE ${where}
     UNION
     SELECT DISTINCT "field_key" FROM "${AI_CELL_TABLE}" WHERE ${where}`,
    [...params, ...params],
  );
  const staleKeys = staleRows.map((r) => String(r.field_key));
  if (staleKeys.length === 0) return [];
  const inList = staleKeys.map(() => '?').join(', ');
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${AI_MAP_TABLE}" WHERE "field_key" IN (${inList})`,
    staleKeys,
  );
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${AI_CELL_TABLE}" WHERE "field_key" IN (${inList})`,
    staleKeys,
  );
  const pairs = staleKeys.map((key) => {
    const dot = key.indexOf('.');
    return [key.slice(0, dot), key.slice(dot + 1)];
  });
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${COMPUTED_STATE_TABLE}" WHERE ${pairs
      .map(() => `("table_name" = ? AND "field" = ?)`)
      .join(' OR ')}`,
    pairs.flat(),
  );
  return staleKeys;
}

/**
 * Count the items a field's pending query would still return. Used internally
 * after each fill pass, and by the ops layer's dry-run preview to report how
 * much AI work a definition would enqueue before anything is materialized.
 */
export async function countPending(
  adapter: StorageAdapter,
  field: CompiledAiField,
): Promise<number> {
  const row = await getAsyncOrSync(
    adapter,
    `SELECT COUNT(*) AS "n" FROM (${field.pendingSql}) AS "p"`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Run the fill pass for every AI field of a compiled computed table.
 *
 * - `ai_classify`: only never-seen DISTINCT input values reach the model, in
 *   batches (~50 per call), as one strict-JSON request mapping each value to a
 *   label. Every returned label is validated against the allowed set; a value
 *   with an out-of-set (or missing) label is recorded as an error for the
 *   field and NEVER stored as a label. A `null` label means the model
 *   declined — stored so the value is not re-asked.
 * - `ai_transform`: one model call per join-miss row; the row's `input_key`
 *   is SELECTed from the database via the same SQL expression the view joins
 *   on, so the two can never disagree.
 *
 * An LLM/parse error records status `'error'` for that field, stops that
 * field's remaining batches (already-written rows stay), continues the other
 * fields, and is RETURNED in the report — unfilled rows keep reading NULL via
 * the view's join miss, never a stale value. This function only throws for
 * infrastructure failures (e.g. the database itself is unreachable).
 */
export async function runComputedFill(
  adapter: StorageAdapter,
  llm: FillLlm,
  compiled: CompiledComputedTable,
  opts: ComputedFillOptions = {},
): Promise<ComputedFillReport> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 50));
  await ensureAiTables(adapter);
  const report: ComputedFillReport = { table: compiled.viewName, fields: [] };

  for (const field of compiled.aiFields) {
    await upsertState(adapter, {
      table: compiled.viewName,
      field: field.field,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const result =
      field.kind === 'ai_classify'
        ? await fillClassifier(adapter, llm, field, batchSize)
        : await fillTransform(adapter, llm, field, batchSize);

    const pending = await countPending(adapter, field);
    const outcome: FieldFillResult = {
      field: field.field,
      key: field.key,
      kind: field.kind,
      status: result.error === undefined ? 'idle' : 'error',
      filled: result.filled,
      pending,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    report.fields.push(outcome);

    await upsertState(adapter, {
      table: compiled.viewName,
      field: field.field,
      status: outcome.status,
      error: result.error ?? null,
      pending,
      filled: result.filled,
      finishedAt: new Date().toISOString(),
    });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Classifier fill
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM =
  'You are a strict classifier. You will receive input values and a fixed set of allowed labels. ' +
  'Respond with ONLY a JSON object mapping every input value (verbatim, as given) to one of the ' +
  'allowed labels, or to null if no label applies. No prose, no code fences, no extra keys.';

async function fillClassifier(
  adapter: StorageAdapter,
  llm: FillLlm,
  field: CompiledAiField,
  batchSize: number,
): Promise<{ filled: number; error?: string }> {
  const labels = field.labels ?? [];
  const labelSet = new Set(labels);
  const hash = promptHash(field);
  let filled = 0;

  for (;;) {
    const rows = await allAsyncOrSync(adapter, `${field.pendingSql} LIMIT ${String(batchSize)}`);
    if (rows.length === 0) return { filled };
    const values = rows.map((r) => String(r.input_value));

    let text: string;
    try {
      text = await llm.complete({
        system: CLASSIFY_SYSTEM,
        user: [
          field.prompt,
          '',
          `Allowed labels: ${JSON.stringify(labels)}`,
          `Input values: ${JSON.stringify(values)}`,
        ].join('\n'),
        model: field.model,
      });
    } catch (e) {
      return { filled, error: `model call failed: ${(e as Error).message}` };
    }

    let mapping: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('response is not a JSON object');
      }
      mapping = parsed as Record<string, unknown>;
    } catch (e) {
      return { filled, error: `unparseable classifier response: ${(e as Error).message}` };
    }

    const rejected: string[] = [];
    const now = new Date().toISOString();
    for (const value of values) {
      if (!Object.prototype.hasOwnProperty.call(mapping, value)) {
        rejected.push(value);
        continue;
      }
      const label = mapping[value];
      if (label !== null && (typeof label !== 'string' || !labelSet.has(label))) {
        // Out-of-set label: recorded as an error, never stored as a label.
        rejected.push(value);
        continue;
      }
      await runAsyncOrSync(
        adapter,
        `INSERT INTO "${AI_MAP_TABLE}"
           ("field_key","input_value","label","model","prompt_hash","created_at")
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT ("field_key","input_value") DO NOTHING`,
        [field.key, value, label, field.model, hash, now],
      );
      filled++;
    }

    if (rejected.length > 0) {
      // Stop this field: without a stored row the same values would pend again
      // and loop forever. Valid values from this batch are already written.
      return {
        filled,
        error: `model returned out-of-set or missing labels for ${String(rejected.length)} value(s): ${rejected
          .slice(0, 5)
          .map((v) => JSON.stringify(v))
          .join(', ')}${rejected.length > 5 ? ', …' : ''}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Transform fill
// ---------------------------------------------------------------------------

const TRANSFORM_SYSTEM =
  'You transform structured inputs into a single output value. Respond with ONLY the output ' +
  'value as plain text — no prose, no labels, no code fences.';

async function fillTransform(
  adapter: StorageAdapter,
  llm: FillLlm,
  field: CompiledAiField,
  batchSize: number,
): Promise<{ filled: number; error?: string }> {
  const hash = promptHash(field);
  let filled = 0;

  for (;;) {
    const rows = await allAsyncOrSync(adapter, `${field.pendingSql} LIMIT ${String(batchSize)}`);
    if (rows.length === 0) return { filled };

    for (const row of rows) {
      const rowId = String(row.row_id);
      // The input_key is read from the database — computed by the SAME SQL
      // expression the view's LEFT JOIN matches on — never recomputed in JS.
      const inputKey = String(row.input_key);
      const inputLines = field.inputs.map((name, i) => {
        const v = row[`input_${String(i)}`];
        return `${name}: ${v === null || v === undefined ? '' : String(v as string | number | boolean)}`;
      });

      let output: string;
      try {
        output = (
          await llm.complete({
            system: TRANSFORM_SYSTEM,
            user: [field.prompt, '', ...inputLines].join('\n'),
            model: field.model,
          })
        ).trim();
      } catch (e) {
        return { filled, error: `model call failed: ${(e as Error).message}` };
      }

      // Upsert on (field, row): a stale row (its input_key changed since the
      // last fill) is REPLACED, which is exactly the staleness contract — the
      // view reads NULL from the moment the source changes until this refill.
      await runAsyncOrSync(
        adapter,
        `INSERT INTO "${AI_CELL_TABLE}"
           ("field_key","row_id","input_key","output","model","prompt_hash","created_at")
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT ("field_key","row_id") DO UPDATE SET
           "input_key" = excluded."input_key",
           "output" = excluded."output",
           "model" = excluded."model",
           "prompt_hash" = excluded."prompt_hash",
           "created_at" = excluded."created_at"`,
        [field.key, rowId, inputKey, output, field.model, hash, new Date().toISOString()],
      );
      filled++;
    }
  }
}
