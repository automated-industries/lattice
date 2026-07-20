import type {
  LlmClient,
  LlmMessage,
  ContentBlock,
  TurnParams,
  TurnResult,
  ToolUse,
} from './chat.js';

/**
 * An {@link LlmClient} backed by ANY OpenAI-compatible `chat/completions` endpoint
 * (OpenAI, Azure/OpenRouter/together/groq, a local vLLM/Ollama/LM Studio server, or a
 * user's own gateway — or GitHub Copilot if the user points it there). The rest of
 * Lattice speaks the Anthropic-shaped {@link TurnParams}/{@link TurnResult}; this module
 * is the seam that translates to and from the OpenAI wire format, so no other AI feature
 * needs a second code path.
 *
 * Deliberately provider-neutral: it ships NO provider-specific auth, headers, or model
 * impersonation. The caller supplies a base URL, an API key (sent as a Bearer token), a
 * model id, and — for endpoints that need them (Azure's `api-key`, a gateway's custom
 * auth) — optional extra headers. It talks over plain `fetch`, so it adds no dependency
 * and runs identically under Node and the desktop Deno runtime.
 */

export interface OpenAiCompatConfig {
  /** Base URL up to (but not including) `/chat/completions`, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** Bearer API key. Empty string is allowed for keyless local servers. */
  apiKey: string;
  /** The single model id used for every call (there is no per-call tier here). */
  model: string;
  /** Extra request headers (e.g. an Azure `api-key`, a gateway token). Merged last. */
  headers?: Record<string, string>;
  /** Default cap on completion length when a turn doesn't specify one. Default 4096. */
  maxTokens?: number;
  /** Test/advanced seam: inject a `fetch`. Production leaves it unset (global fetch). */
  fetchImpl?: typeof fetch;
}

type ToolInput = { name: string; description?: string; input_schema: unknown };
type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
type OpenAiMessage =
  | { role: 'system' | 'user' | 'tool'; content: string; tool_call_id?: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] };

/** Translate the Anthropic-shaped system + message list into OpenAI chat messages. */
export function toOpenAiMessages(system: string, messages: LlmMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system.trim()) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: ContentBlock[] = m.content;
    if (m.role === 'assistant') {
      // Assistant turn: text + any tool_use blocks become one assistant message
      // carrying `tool_calls` (OpenAI attaches calls to the assistant turn).
      let text = '';
      const toolCalls: OpenAiToolCall[] = [];
      for (const b of blocks) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // User turn: each tool_result becomes its own `tool` message (OpenAI keys the
      // result to the call id); any plain text becomes a trailing user message.
      let text = '';
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
        } else if (b.type === 'text') {
          text += b.text;
        }
      }
      if (text.length > 0) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Translate the tool catalog into OpenAI `function` tools. */
export function toOpenAiTools(
  tools: readonly ToolInput[],
): { type: 'function'; function: { name: string; description?: string; parameters: unknown } }[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
    },
  }));
}

/** Map an OpenAI finish_reason to the Anthropic-shaped stop reason the app expects. */
export function mapFinishReason(fr: string | null | undefined, hadToolCalls: boolean): string {
  // If the model produced tool calls, the loop MUST execute them — even when the
  // terminal chunk reported 'length' (the last of several parallel calls was truncated
  // by the token cap). Mapping that to 'max_tokens' would strand the valid calls.
  if (hadToolCalls) return 'tool_use';
  switch (fr) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

/**
 * Fold the streamed OpenAI SSE deltas into a {@link TurnResult}. Exported so the
 * accumulation logic (text + fragmented tool-call arguments) is unit-testable without
 * a live socket. `onText` is called with each content delta, mirroring the Anthropic
 * client's token streaming.
 */
export function accumulateStream(
  deltas: StreamDelta[],
  finishReason: string | null | undefined,
  onText: (d: string) => void,
): TurnResult {
  let text = '';
  // Tool calls arrive fragmented across deltas, keyed by index; id/name/arguments
  // each stream in piecemeal and must be concatenated in arrival order.
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  for (const d of deltas) {
    if (typeof d.content === 'string' && d.content.length > 0) {
      text += d.content;
      onText(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = byIndex.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      byIndex.set(idx, cur);
    }
  }
  const toolUses: ToolUse[] = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const c = byIndex.get(idx);
    if (!c?.name) continue;
    let input: Record<string, unknown>;
    try {
      input = c.args.trim() ? (JSON.parse(c.args) as Record<string, unknown>) : {};
    } catch {
      // A truncated/malformed tool call (typically the LAST of several parallel calls,
      // cut off by the token cap → finish_reason 'length') must NOT discard the VALID
      // sibling calls + streamed text. Drop just this one — the model re-issues it next
      // round if it mattered — instead of failing the whole turn. Surfaced, not silent.
      console.warn(
        `[openai] dropped tool call "${c.name}" with unparseable (likely truncated) arguments`,
      );
      continue;
    }
    toolUses.push({ id: c.id || `call_${String(idx)}`, name: c.name, input });
  }
  return { stopReason: mapFinishReason(finishReason, toolUses.length > 0), text, toolUses };
}

/** Read an SSE response body line-by-line, yielding each `data:` payload (minus [DONE]). */
async function* readSse(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) throw new Error('OpenAI-compatible response had no body to stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
      nl = buffer.indexOf('\n');
    }
  }
  // Flush a trailing `data:` line with no terminating newline — SSE normally ends with a
  // blank line, but a stream that closes mid-line shouldn't silently drop a final event.
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== '[DONE]') yield payload;
  }
}

/**
 * When an endpoint rejects a request PARAMETER (not auth or the model itself), return a
 * mutated body that renames/drops the offending parameter so the caller can retry — else
 * null. Covers the OpenAI reasoning-model split: `o1`/`o3`/`gpt-5`-class models reject
 * `max_tokens` (they want `max_completion_tokens`) and a non-default `temperature`.
 */
function adaptForParamError(
  body: Record<string, unknown>,
  detail: string,
): Record<string, unknown> | null {
  const d = detail.toLowerCase();
  if ('max_tokens' in body && d.includes('max_completion_tokens')) {
    const next = { ...body };
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  if (
    'temperature' in body &&
    d.includes('temperature') &&
    (d.includes('unsupported') || d.includes('does not support') || d.includes('only the default'))
  ) {
    const next = { ...body };
    delete next.temperature;
    return next;
  }
  return null;
}

/**
 * Build an {@link LlmClient} for an OpenAI-compatible endpoint. `params.model` is
 * IGNORED — the connected provider has one configured model (the app's Anthropic model
 * ids are meaningless here), so every call uses {@link OpenAiCompatConfig.model}.
 */
export function createOpenAiCompatibleClient(cfg: OpenAiCompatConfig): LlmClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return {
    async runTurn(params: TurnParams): Promise<TurnResult> {
      const tools = toOpenAiTools(params.tools);
      let body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAiMessages(params.system, params.messages),
        ...(tools.length > 0 ? { tools } : {}),
        max_tokens: params.maxTokens ?? cfg.maxTokens ?? 4096,
        stream: true,
      };
      if (params.temperature !== undefined) body.temperature = params.temperature;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...(cfg.headers ?? {}),
      };
      // Send, and on a parameter-rejection 400 (e.g. a reasoning model that wants
      // max_completion_tokens / the default temperature) adapt the body and retry,
      // rather than hard-failing an otherwise-usable model.
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (res.ok) break;
        const detail = await res.text().catch(() => '');
        const adapted = attempt < 2 ? adaptForParamError(body, detail) : null;
        if (adapted) {
          body = adapted;
          continue;
        }
        throw new Error(
          `OpenAI-compatible request failed (${String(res.status)}): ${detail.slice(0, 400)}`,
        );
      }
      const deltas: StreamDelta[] = [];
      let finishReason: string | null | undefined;
      for await (const payload of readSse(res)) {
        let chunk: { choices?: { delta?: StreamDelta; finish_reason?: string | null }[] };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          continue; // tolerate a keep-alive / comment line that isn't JSON
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta) deltas.push(choice.delta);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      return accumulateStream(deltas, finishReason, params.onText);
    },
  };
}
