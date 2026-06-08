import { createRequire } from 'node:module';

/**
 * The model-client core: the {@link LlmClient} interface every AI feature
 * depends on, plus the real Anthropic-backed implementation. This lives in
 * `src/ai/` (not the GUI) so library AI features — the organizer, enrich,
 * crawl, summarize/classify — never import from `src/gui/`.
 *
 * The SDK is lazy-loaded (it is an optionalDependency, mirroring how the
 * Postgres adapter loads `pg`). Tests inject a fake {@link LlmClient}, so the
 * AI features compile and run without the SDK installed.
 */

export const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;

/** A content block in the Anthropic message format used here. */
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

/** Minimal tool shape passed to the model (decoupled from the GUI tool catalog). */
export interface LlmTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface TurnParams {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** Called with each streamed text delta. */
  onText: (delta: string) => void;
}

/** The slice of the Anthropic client the AI features depend on. */
export interface LlmClient {
  runTurn(params: TurnParams): Promise<TurnResult>;
}

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

// ── Real client (lazy-loaded SDK) ───────────────────────────────────────────

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
