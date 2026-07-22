/**
 * The automatic data-model designer (Bug 11).
 *
 * ONE shared routine — {@link designDataModel} — that keeps a workspace a clean,
 * scalable star schema. It is deliberately consumed from several places so the
 * behaviour is identical everywhere:
 *   - deterministically after a new file batch is ingested (debounced so a whole
 *     batch triggers one pass — see {@link scheduleDataModelDesign});
 *   - after an MCP connector or an external database is connected;
 *   - on demand (the assistant's `design_data_model` tool / a user request).
 *
 * It runs UNATTENDED, so it is conservative by construction: it may only READ the
 * model and make ADDITIVE, REVERSIBLE structural improvements — relate tables
 * (create_relationship + link), add live COMPUTED views (create_computed_table),
 * and document meaning (set_definition). It has NO destructive or data-writing tools
 * (no create/update/delete row, no create/delete entity, no bulk_update), so it can
 * never invent, overwrite, or drop the user's data — every change lands in the
 * version-history undo stack. When the model is already clean it does nothing.
 */

import {
  buildSchemaContext,
  DEFAULT_MODEL,
  type LlmClient,
  type LlmMessage,
  type ContentBlock,
} from './chat.js';
import { buildAnthropicTools } from './tools.js';
import { executeFunction, type DispatchCtx } from './dispatch.js';

/** Tool-execution seam — the real dispatcher in production, a fake in tests. */
export type ExecFn = (
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: string }>;

/** Read tools + the ONLY additive/reversible write tools the designer may use. */
const SAFE_DESIGNER_TOOLS = new Set<string>([
  // read / inspect
  'list_entities',
  'get_entity_graph',
  'list_rows',
  'get_row',
  'get_row_context',
  'search',
  // additive, reversible structure only
  'create_relationship',
  'link',
  'preview_computed_table',
  'create_computed_table',
  'set_definition',
]);

/** The subset of {@link SAFE_DESIGNER_TOOLS} that actually change the model — used to
 *  report what the pass did. */
const DESIGNER_WRITE_TOOLS = new Set<string>([
  'create_relationship',
  'link',
  'create_computed_table',
  'set_definition',
]);

const MAX_DESIGNER_LOOPS = 8;
const DESIGNER_MAX_TOKENS = 2048;

const DESIGNER_SYSTEM = [
  "You are Lattice's automatic data-model designer. You run UNATTENDED after new data lands (a file batch ingested, a source connected). Your one job: keep the workspace a clean, scalable STAR SCHEMA (a well-normalized relational model) so every later question, dashboard, and computed view is reliable.",
  '',
  'Principles (priority order):',
  '- ONE CONCEPT PER TABLE — each entity kind (people, companies, meetings, invoices, deals…) is its own table with a stable key.',
  '- FACTS vs DIMENSIONS — event/transaction tables (meetings, orders, messages, tickets) reference the who/what/where dimension tables (people, accounts, products) by relationship.',
  '- NORMALIZE repeated data — when a table repeats the same entity across rows, that entity should be its OWN table linked by a relationship, not copied into every row.',
  '- DERIVED data is a live COMPUTED view (preview_computed_table → create_computed_table), never a stored copy.',
  '- Document what non-obvious objects/fields MEAN with set_definition.',
  '',
  'HARD SAFETY RULES (you have NO user to confirm with):',
  '- You may ONLY relate tables (create_relationship then link), add computed views (create_computed_table, after preview_computed_table shows every field ok), and document meaning (set_definition). You have NO other write tools — you cannot create, edit, or delete rows or tables.',
  '- Be CONSERVATIVE and IDEMPOTENT: FIRST read the current model (list_entities, get_entity_graph). Only act on HIGH-CONFIDENCE improvements. NEVER re-create a relationship that already exists. If the model is already clean, make NO changes and stop.',
  '- Prefer the smallest set of clearly-correct changes; every change is reversible via version history, but avoid churn.',
  '- Produce NO user-facing prose. Call tools, then stop as soon as there is nothing high-confidence left to do.',
].join('\n');

/** What a scheduled design pass needs, resolved lazily at fire time (so a client /
 *  context that isn't ready yet just yields null and the pass is skipped). */
export interface DesignJob {
  client: LlmClient;
  dispatch: DispatchCtx;
}

const DESIGN_DEBOUNCE_MS = 4000;
const designTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced, FAIL-SOFT trigger for a design pass — the deterministic hook the ingest
 * and connect paths call. Debounced per workspace `key` so a whole file batch (or a
 * connect + its initial sync) coalesces into ONE pass shortly after the last event.
 * The pass is scheduled, never awaited, and wrapped in try/catch: a designer failure
 * (no model provider, a bad tool call, anything) is logged and swallowed — it can
 * NEVER break the ingest or connect it followed. `prepare()` is called at fire time
 * and returns the client + dispatch context, or null to skip (e.g. no model
 * configured).
 */
export function scheduleDataModelDesign(
  key: string,
  prepare: () => Promise<DesignJob | null>,
  debounceMs: number = DESIGN_DEBOUNCE_MS,
): void {
  const prev = designTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    designTimers.delete(key);
    void (async () => {
      try {
        const job = await prepare();
        if (!job) return; // no model provider / not applicable → skip quietly
        const res = await designDataModel(job.client, job.dispatch);
        if (res.changes.length > 0) {
          console.log(
            `[data-model designer] applied ${String(res.changes.length)} structural improvement(s)`,
          );
        }
      } catch (e) {
        // FAIL-SOFT: the designer is a best-effort enhancement that runs AFTER the
        // ingest/connect already succeeded — never surface or rethrow.
        console.warn('[data-model designer] pass failed (non-fatal):', (e as Error).message);
      }
    })();
  }, debounceMs);
  // Don't keep the process alive just for a pending design pass.
  (timer as { unref?: () => void }).unref?.();
  designTimers.set(key, timer);
}

export interface DesignChange {
  tool: string;
  ok: boolean;
  detail: string;
}
export interface DesignResult {
  changes: DesignChange[];
  loops: number;
}

/**
 * Run one data-model design pass. Returns the structural changes applied (empty when
 * the model was already clean). Never throws for a tool failure — a bad tool call is
 * fed back to the model as an error result and the pass continues; only a client
 * failure propagates (the caller decides whether that is fatal).
 */
export async function designDataModel(
  client: LlmClient,
  dispatch: DispatchCtx,
  opts: { model?: string; exec?: ExecFn } = {},
): Promise<DesignResult> {
  const exec: ExecFn = opts.exec ?? (executeFunction as ExecFn);
  const schema = await buildSchemaContext(dispatch);
  const tools = buildAnthropicTools().filter((t) => SAFE_DESIGNER_TOOLS.has(t.name));
  const system = `${DESIGNER_SYSTEM}\n\n# Current database\n${schema}`;
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content:
        'Review the current data model and make any high-confidence, additive, reversible star-schema improvements. If it is already clean, do nothing.',
    },
  ];
  const changes: DesignChange[] = [];
  let loops = 0;
  for (; loops < MAX_DESIGNER_LOOPS; loops++) {
    const result = await client.runTurn({
      model: opts.model ?? DEFAULT_MODEL,
      system,
      messages,
      tools,
      maxTokens: DESIGNER_MAX_TOKENS,
      onText: () => {
        /* the designer produces no user-facing prose */
      },
    });
    if (result.toolUses.length === 0) break;

    // Record the assistant turn (text + tool_use blocks) so the follow-up
    // tool_result messages pair correctly.
    const asstBlocks: ContentBlock[] = [];
    if (result.text) asstBlocks.push({ type: 'text', text: result.text });
    for (const tu of result.toolUses) {
      asstBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    messages.push({ role: 'assistant', content: asstBlocks });

    const toolResults: ContentBlock[] = [];
    for (const tu of result.toolUses) {
      if (!SAFE_DESIGNER_TOOLS.has(tu.name)) {
        // Defence in depth: even though the model only SEES the safe tools, refuse
        // anything outside the allowlist rather than execute it.
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `"${tu.name}" is not permitted in the automatic data-model designer.`,
          is_error: true,
        });
        continue;
      }
      const r = await exec(dispatch, tu.name, tu.input);
      const detail = r.ok ? JSON.stringify(r).slice(0, 1500) : (r.error ?? 'failed');
      if (DESIGNER_WRITE_TOOLS.has(tu.name)) {
        changes.push({ tool: tu.name, ok: r.ok, detail });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: detail,
        is_error: !r.ok,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { changes, loops };
}
