import { executeFunction, DISPATCHABLE, type DispatchCtx } from './dispatch.js';
import { buildAnthropicTools, type AnthropicTool } from './tools.js';
import type { ChatStreamEvent } from './sse.js';
import { DEFAULT_MODEL } from '../../ai/llm-client.js';
import type { LlmClient, LlmMessage, ContentBlock } from '../../ai/llm-client.js';

// The model-client core now lives in `src/ai/llm-client.ts` (so library AI
// features never import from the GUI). Re-export it here so existing GUI
// importers and tests can keep importing the client from `./ai/chat.js`.
export { DEFAULT_MODEL, createAnthropicClient } from '../../ai/llm-client.js';
export type {
  LlmClient,
  LlmMessage,
  ContentBlock,
  ToolUse,
  TurnParams,
  TurnResult,
  ClaudeAuth,
} from '../../ai/llm-client.js';

/**
 * The assistant tool loop. Streams an Anthropic turn, executes any tool calls
 * through the function dispatcher (which writes via the shared mutation
 * primitives, so every AI edit is audited + fed to the sidebar), feeds the
 * results back, and repeats until the model stops. Emits the SSE event
 * protocol from {@link ChatStreamEvent} so the server can pipe it to the
 * browser and a test can assert the sequence.
 */

const MAX_TOOL_LOOPS = 8;

const SYSTEM_PROMPT =
  'You are the assistant inside a Lattice database GUI. Help the user inspect ' +
  'and edit their data by calling the provided tools. Prefer reading (listing ' +
  'rows, fetching a row) before writing. When you change data, briefly confirm ' +
  'what you did. Be concise.';

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
      yield { type: 'assistant_message_start', id: `m${String(loop)}` };
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
