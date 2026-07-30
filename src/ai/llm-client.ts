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

/**
 * THE default model id — the one place it is written down. Every feature that
 * means "the model we answer with by default" must import this constant rather
 * than restating the id, so bumping the default is a one-line change and two
 * halves of the app can never end up on different models.
 *
 * Override via the `LATTICE_DEFAULT_MODEL` environment variable. When unset,
 * defaults to `claude-haiku-4-5`.
 *
 * This module is the right home for it: it has no imports of its own beyond
 * `node:module`, so anything (library AI features, GUI features, the assistant
 * loop) can depend on it without an import cycle.
 */
export const DEFAULT_MODEL = process.env.LATTICE_DEFAULT_MODEL ?? 'claude-haiku-4-5';
/**
 * Cheapest capable model, pinned for high-volume background passes (e.g. the
 * enrichment fold) where the customer bears the token cost. Deliberately its OWN
 * literal rather than an alias of {@link DEFAULT_MODEL}: they happen to be equal
 * today, and writing it as an alias would silently make every bulk pass expensive
 * the day the default is upgraded to a larger model.
 *
 * Override via the `LATTICE_CHEAPEST_MODEL` environment variable. When unset,
 * defaults to `claude-haiku-4-5`.
 */
export const CHEAPEST_MODEL = process.env.LATTICE_CHEAPEST_MODEL ?? 'claude-haiku-4-5';
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface TurnResult {
  stopReason: string;
  text: string;
  toolUses: ToolUse[];
  usage?: TokenUsage;
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
  /** Override the Anthropic API host (the SDK's `baseURL`). Needed for a BYO custom-host key
   *  or a proxy; when unset the SDK reads `process.env.ANTHROPIC_BASE_URL` or the default host. */
  baseURL?: string | undefined;
}

// ── Real client (lazy-loaded SDK) ───────────────────────────────────────────

interface AnthropicClientConfig {
  // `null` is meaningful: passing it explicitly stops the SDK from falling back
  // to its own `process.env.ANTHROPIC_API_KEY` default (its default only fires
  // on `undefined`). That env default would otherwise add an `x-api-key` header
  // alongside an OAuth Bearer token, and the API rejects a request carrying both.
  apiKey?: string | null;
  authToken?: string;
  defaultHeaders?: Record<string, string>;
  baseURL?: string;
}
type AnthropicCtor = new (config: AnthropicClientConfig) => AnthropicSdk;

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

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
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
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
 * Build the SDK constructor config from a {@link ClaudeAuth}. Exported as a pure
 * test seam. The critical invariant: `apiKey` is ALWAYS set explicitly (to a key
 * or to null), so the SDK never falls back to its own `process.env.ANTHROPIC_API_KEY`
 * default — which, on the OAuth path, would add an `x-api-key` header alongside
 * the Bearer token and get the request rejected.
 */
export function buildAnthropicConfig(auth: ClaudeAuth): AnthropicClientConfig {
  const config: AnthropicClientConfig = {};
  // OAuth (Bearer token) wins and sends no key; an explicit key is used as-is;
  // with no auth we still pin apiKey to null so the env key isn't leaked.
  if (auth.authToken) {
    config.authToken = auth.authToken;
    config.apiKey = null;
  } else if (auth.apiKey) {
    config.apiKey = auth.apiKey;
  } else {
    config.apiKey = null;
  }
  if (auth.betaHeader) config.defaultHeaders = { 'anthropic-beta': auth.betaHeader };
  if (auth.baseURL) config.baseURL = auth.baseURL;
  return config;
}

/**
 * Build the real Anthropic-backed client. Lazy-loads the SDK at call time.
 * Accepts either a raw API key or an OAuth Bearer token (subscription).
 *
 * Implements prompt caching by converting the static system prompt into a
 * cached content block. The entire system prompt is treated as the cached
 * prefix, with any dynamic/volatile content (timestamps, workspace state)
 * arriving in the user messages instead, ensuring a stable byte-exact cache.
 */
export function createAnthropicClient(auth: ClaudeAuth): LlmClient {
  const Anthropic = loadSdk();
  const sdk = new Anthropic(buildAnthropicConfig(auth));
  return {
    async runTurn(params: TurnParams): Promise<TurnResult> {
      // Build system blocks with cache control on the static prompt.
      // All runtime dynamics (timestamps, workspace state) must live in messages,
      // not the cached system, so the cache prefix remains byte-stable.
      const systemBlocks: AnthropicSystemBlock[] = [
        {
          type: 'text',
          text: params.system,
          cache_control: { type: 'ephemeral' },
        },
      ];

      const stream = sdk.messages.stream({
        model: params.model,
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
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

      // Capture usage metrics for visibility.
      const usage: TokenUsage | undefined = final.usage
        ? {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
            ...(final.usage.cache_read_input_tokens !== undefined
              ? { cacheReadInputTokens: final.usage.cache_read_input_tokens }
              : {}),
            ...(final.usage.cache_creation_input_tokens !== undefined
              ? { cacheCreationInputTokens: final.usage.cache_creation_input_tokens }
              : {}),
          }
        : undefined;

      return {
        stopReason: final.stop_reason ?? 'end_turn',
        text,
        toolUses,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
