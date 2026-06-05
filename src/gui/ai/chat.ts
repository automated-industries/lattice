import { createRequire } from 'node:module';
import {
  executeFunction,
  DISPATCHABLE,
  ASSISTANT_HIDDEN_TABLES,
  type DispatchCtx,
} from './dispatch.js';
import { buildAnthropicTools, type AnthropicTool } from './tools.js';
import type { ChatStreamEvent } from './sse.js';

/**
 * The assistant tool loop. Streams an Anthropic turn, executes any tool calls
 * through the function dispatcher (which writes via the shared mutation
 * primitives, so every AI edit is audited + fed to the sidebar), feeds the
 * results back, and repeats until the model stops. Emits the SSE event
 * protocol from {@link ChatStreamEvent} so the server can pipe it to the
 * browser and a test can assert the sequence.
 *
 * All @anthropic-ai/sdk specifics live behind {@link LlmClient}. The real
 * client is built by {@link createAnthropicClient} (lazy-loaded — the SDK is
 * an optionalDependency, mirroring how realtime.ts loads pg). Tests inject a
 * fake client, so the loop compiles and runs without the SDK installed.
 */

export const DEFAULT_MODEL = 'claude-haiku-4-5';
// Tool-loop + output budget. Sized for multi-step agentic work — e.g. "create
// one row per line of an attached CSV" needs many tool rounds, and each turn
// may emit several tool_use blocks, so a 2048-token cap truncated bulk work.
// (Capacity, not a workaround — see CHANGELOG; flagged for review per Rule 12.)
const MAX_TOOL_LOOPS = 16;
const MAX_TOKENS = 4096;

const BASE_SYSTEM_PROMPT = [
  'You are the assistant inside a Lattice database GUI. Help the user inspect and edit their data by calling the provided tools.',
  '',
  'Rules:',
  '- The tables under "Current database" below are what already exists. When the user asks for an object type that has no table, CREATE it with create_entity (pass sensible starter columns), then add rows with create_row — do not refuse or ask whether you "have the ability."',
  '- To relate two tables (link their rows), call create_relationship(table_a, table_b) to get a junction + its two foreign-key columns, then `link` each pair using those columns. If the junction already exists, just `link`.',
  '- Use the exact table names from the schema (or one you just created) — never guess a name for a table that should already exist.',
  '- Prefer reading (list_rows, get_row) before writing.',
  "- Attached files are rows in the `files` table; a file's full text content (CSV, document, etc.) is in its `extracted_text` column. To work from an attached file, read the relevant `files` row(s) and parse `extracted_text` — never guess a file's contents.",
  '- A tool result that contains "error" means the call FAILED. Do NOT claim success or proceed as if it returned data — read the error, correct your arguments, and retry.',
  '- For bulk work, emit several tool calls in one turn instead of one at a time. Every change is recorded in version history and can be undone.',
  '- When you change data, briefly confirm what you did. Be concise.',
].join('\n');

/**
 * A compact description of the live database — table names, columns, and row
 * counts — appended to the system prompt so the model calls tools with REAL
 * table names instead of guessing (guessing was the source of the "Unknown
 * table" → "Could not fetch/list row" errors, and across turns the model has no
 * other way to know what exists since history is text-only). Junctions are
 * marked so link/unlink target the right table. Best-effort: a count failure
 * never aborts the turn.
 */
async function buildSchemaContext(d: DispatchCtx): Promise<string> {
  const names = [...d.validTables]
    .filter((n) => !n.startsWith('_') && !ASSISTANT_HIDDEN_TABLES.has(n))
    .sort();
  if (names.length === 0) {
    return '(no tables yet — the user must create one before you can add rows)';
  }
  const lines: string[] = [];
  for (const t of names) {
    const cols = d.db.getRegisteredColumns(t);
    const colNames = cols ? Object.keys(cols).filter((c) => c !== 'deleted_at') : [];
    let count = 0;
    try {
      count = await d.db.count(t);
    } catch {
      // best-effort — list the table even if the count query fails
    }
    const tag = d.junctionTables.has(t) ? ' [junction]' : '';
    lines.push(
      `- ${t}${tag} (${colNames.join(', ')}) — ${String(count)} row${count === 1 ? '' : 's'}`,
    );
  }
  return lines.join('\n');
}

function buildSystemPrompt(schema: string): string {
  return `${BASE_SYSTEM_PROMPT}\n\n# Current database\n${schema}`;
}

/** A content block in the Anthropic message format we use. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnResult {
  stopReason: string;
  text: string;
  toolUses: ToolUse[];
}

export interface TurnParams {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: AnthropicTool[];
  /** Sampling temperature [0,1]. Omitted → the model default. */
  temperature?: number;
  /** Called with each streamed text delta. */
  onText: (delta: string) => void;
}

/** The slice of the Anthropic client the loop depends on. */
export interface LlmClient {
  runTurn(params: TurnParams): Promise<TurnResult>;
}

export interface RunChatOptions {
  client: LlmClient;
  dispatch: DispatchCtx;
  /** Prior conversation turns (excluding the new user message). */
  history?: LlmMessage[];
  userMessage: string;
  model?: string;
  /** Sampling temperature [0,1] (from inference aggressiveness). */
  temperature?: number;
}

/** Tools the model is allowed to call (only those the dispatcher can run). */
function dispatchableTools(): AnthropicTool[] {
  return buildAnthropicTools().filter((t) => DISPATCHABLE.has(t.name));
}

/**
 * Run the chat loop, yielding SSE events. Never throws — model/tool failures
 * are surfaced as `error` / tool_result events so the stream always ends with
 * `done`.
 */
export async function* runChat(opts: RunChatOptions): AsyncGenerator<ChatStreamEvent> {
  const model = opts.model ?? DEFAULT_MODEL;
  const tools = dispatchableTools();
  const messages: LlmMessage[] = [
    ...(opts.history ?? []),
    { role: 'user', content: opts.userMessage },
  ];
  // Build the schema-aware system prompt once per turn — gives the model the
  // real table list so it stops guessing (and re-establishes context each turn,
  // since the persisted history is text-only).
  const system = buildSystemPrompt(await buildSchemaContext(opts.dispatch));

  try {
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const deltas: string[] = [];
      yield { type: 'assistant_message_start', id: `m${String(loop)}` };
      const turn = await opts.client.runTurn({
        model,
        system,
        messages,
        tools,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        onText: (d) => deltas.push(d),
      });
      for (const d of deltas) yield { type: 'text_delta', delta: d };
      yield { type: 'assistant_message_end' };

      // Record the assistant turn (text + any tool_use blocks).
      const assistantBlocks: ContentBlock[] = [];
      if (turn.text) assistantBlocks.push({ type: 'text', text: turn.text });
      for (const tu of turn.toolUses) {
        assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: 'assistant', content: assistantBlocks });

      if (turn.toolUses.length === 0) break;

      // Execute each tool call and feed results back as a single user turn.
      const resultBlocks: ContentBlock[] = [];
      for (const tu of turn.toolUses) {
        yield { type: 'tool_use', id: tu.id, name: tu.name };
        const res = await executeFunction(opts.dispatch, tu.name, tu.input);
        yield { type: 'tool_result', toolUseId: tu.id, isError: !res.ok };
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(res.ok ? res.result : { error: res.error }),
          is_error: !res.ok,
        });
      }
      messages.push({ role: 'user', content: resultBlocks });
    }
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
  }
  yield { type: 'done' };
}

// ── Real client (lazy-loaded SDK) ───────────────────────────────────────────

/**
 * How to authenticate to Anthropic: a raw API key, or an OAuth Bearer token
 * (from a connected Claude subscription). `betaHeader` carries an optional
 * `anthropic-beta` value (sourced from env for the OAuth path — not hardcoded).
 */
export interface ClaudeAuth {
  apiKey?: string | undefined;
  authToken?: string | undefined;
  betaHeader?: string | undefined;
}

interface AnthropicClientConfig {
  apiKey?: string;
  authToken?: string;
  defaultHeaders?: Record<string, string>;
}
type AnthropicCtor = new (config: AnthropicClientConfig) => AnthropicSdk;
interface AnthropicSdk {
  messages: {
    stream(params: Record<string, unknown>): AnthropicMessageStream;
  };
}
interface AnthropicMessageStream {
  on(event: 'text', cb: (delta: string) => void): void;
  finalMessage(): Promise<{
    stop_reason: string | null;
    content: (
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: string; [k: string]: unknown }
    )[];
  }>;
}

let _sdk: { Anthropic?: AnthropicCtor; default?: AnthropicCtor } | null = null;
function loadSdk(): AnthropicCtor {
  if (!_sdk) {
    const importMetaUrl = (import.meta as { url?: string }).url;
    const req = importMetaUrl ? createRequire(importMetaUrl) : require;
    try {
      _sdk = req('@anthropic-ai/sdk') as { Anthropic?: AnthropicCtor; default?: AnthropicCtor };
    } catch (err) {
      throw new Error(
        "The assistant requires '@anthropic-ai/sdk'. Install it with: npm install @anthropic-ai/sdk\n" +
          'Underlying error: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  const ctor = _sdk.Anthropic ?? _sdk.default;
  if (!ctor)
    throw new Error("Could not resolve the Anthropic constructor from '@anthropic-ai/sdk'");
  return ctor;
}

/**
 * Build the real Anthropic-backed client. Lazy-loads the SDK at call time.
 * Accepts either a raw API key or an OAuth Bearer token (subscription).
 */
export function createAnthropicClient(auth: ClaudeAuth): LlmClient {
  const Anthropic = loadSdk();
  const config: AnthropicClientConfig = {};
  if (auth.authToken) config.authToken = auth.authToken;
  else if (auth.apiKey) config.apiKey = auth.apiKey;
  if (auth.betaHeader) config.defaultHeaders = { 'anthropic-beta': auth.betaHeader };
  const sdk = new Anthropic(config);
  return {
    async runTurn(params: TurnParams): Promise<TurnResult> {
      const stream = sdk.messages.stream({
        model: params.model,
        max_tokens: MAX_TOKENS,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });
      stream.on('text', (delta) => {
        params.onText(delta);
      });
      const final = await stream.finalMessage();
      let text = '';
      const toolUses: ToolUse[] = [];
      for (const block of final.content) {
        if (block.type === 'text') text += (block as { text: string }).text;
        else if (block.type === 'tool_use') {
          const tu = block as { id: string; name: string; input: Record<string, unknown> };
          toolUses.push({ id: tu.id, name: tu.name, input: tu.input });
        }
      }
      return { stopReason: final.stop_reason ?? 'end_turn', text, toolUses };
    },
  };
}
