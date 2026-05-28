import { createRequire } from 'node:module';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from './dispatch.js';
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
const MAX_TOOL_LOOPS = 8;
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT =
  'You are the assistant inside a Lattice database GUI. Help the user inspect ' +
  'and edit their data by calling the provided tools. Prefer reading (listing ' +
  'rows, fetching a row) before writing. When you change data, briefly confirm ' +
  'what you did. Be concise.';

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

  try {
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const deltas: string[] = [];
      yield { type: 'assistant_message_start', id: `m${loop}` };
      const turn = await opts.client.runTurn({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
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

type AnthropicCtor = new (config: { apiKey: string }) => AnthropicSdk;
interface AnthropicSdk {
  messages: {
    stream(params: Record<string, unknown>): AnthropicMessageStream;
  };
}
interface AnthropicMessageStream {
  on(event: 'text', cb: (delta: string) => void): void;
  finalMessage(): Promise<{
    stop_reason: string | null;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: string; [k: string]: unknown }
    >;
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
  if (!ctor) throw new Error("Could not resolve the Anthropic constructor from '@anthropic-ai/sdk'");
  return ctor;
}

/** Build the real Anthropic-backed client. Lazy-loads the SDK at call time. */
export function createAnthropicClient(apiKey: string): LlmClient {
  const Anthropic = loadSdk();
  const sdk = new Anthropic({ apiKey });
  return {
    async runTurn(params: TurnParams): Promise<TurnResult> {
      const stream = sdk.messages.stream({
        model: params.model,
        max_tokens: MAX_TOKENS,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
      });
      stream.on('text', (delta) => params.onText(delta));
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
