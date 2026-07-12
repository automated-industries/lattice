import type { Lattice } from '../../lattice.js';
import type { LlmClient } from './chat.js';
import type { ClaudeAuth } from '../../ai/llm-client.js';
import { createAnthropicClient, DEFAULT_MODEL } from './chat.js';
import { createOpenAiCompatibleClient } from './openai-client.js';
import { resolveClaudeAuth, isClaudeConnected, isManagedModelAuth } from '../assistant-routes.js';
import { htmlAuthorModelForAuth } from './html-author.js';
import { noteClaudeError, type ClaudeLimitKind } from './limit-state.js';
import {
  readOpenAiCompatConfig,
  activeProviderKind,
  type LlmProviderKind,
} from './provider-config.js';

/**
 * Provider selection for the assistant's LLM backend. The whole app speaks the
 * Anthropic-shaped {@link LlmClient}; this resolves WHICH backend answers a turn — a
 * connected Claude subscription (the historical default) or a user-configured
 * OpenAI-compatible endpoint (OpenAI / Azure / OpenRouter / a local server / a gateway,
 * or GitHub Copilot if the user points it there). No provider-specific impersonation is
 * shipped — the OpenAI-compatible path is a plain base-URL + key + model config.
 *
 * Backward-compatible by construction: with nothing configured the order is
 * [anthropic, …], so existing installs resolve Claude exactly as before.
 */

// Re-exported so existing importers (and tests) can reach the storage helpers here.
export {
  OPENAI_COMPAT_KIND,
  ACTIVE_PROVIDER_KIND,
  readOpenAiCompatConfig,
  activeProviderKind,
  type LlmProviderKind,
  type StoredOpenAiCompat,
} from './provider-config.js';

export interface ResolvedProvider {
  client: LlmClient;
  kind: LlmProviderKind;
  /** Model for delegated sub-agents (e.g. the HTML author). */
  authorModel: string;
  /** Classify + record a turn failure. Only the Anthropic path drives the shared
   *  usage-limit UI; a BYO endpoint has no subscription-limit concept, so 'other'. */
  noteError(e: unknown): ClaudeLimitKind;
}

/**
 * Resolve the active LLM provider into a ready {@link LlmClient} (+ the provider-specific
 * bits call sites need), or null when nothing is configured. Tries the selected provider
 * first, then the other, so a stale selection never bricks the assistant when the other
 * backend IS available. A client-build failure (e.g. the Anthropic SDK not installed)
 * propagates — it is a real, surfaceable error, not a silent "unconfigured".
 */
export async function resolveLlmProvider(db: Lattice | null): Promise<ResolvedProvider | null> {
  // Managed deployment: the operator supplies the model credential via env, and it must
  // NOT be overridable by a user's connected subscription OR their OpenAI-compatible
  // endpoint (billing/model control belongs to the operator). Force the Anthropic
  // managed-env path only — mirroring resolveClaudeAuth's managed short-circuit.
  const order: LlmProviderKind[] = isManagedModelAuth()
    ? ['anthropic']
    : activeProviderKind() === 'openai_compat'
      ? ['openai_compat', 'anthropic']
      : ['anthropic', 'openai_compat'];
  for (const kind of order) {
    if (kind === 'openai_compat') {
      const cfg = readOpenAiCompatConfig();
      if (cfg) {
        // Auto-pick the wire from the ENDPOINT (one config, one calling path): a
        // Claude API key against an Anthropic host speaks the Anthropic Messages
        // wire, so reuse the SAME Anthropic client that powers a connected
        // subscription and the managed cloud key (no reinvention) — and it drives
        // the Claude usage-limit UI. Every other endpoint (OpenAI / Copilot / Azure
        // / a local server / a gateway) speaks OpenAI chat/completions.
        if (isAnthropicEndpoint(cfg.baseUrl)) {
          return {
            client: createAnthropicClient({
              apiKey: cfg.apiKey || undefined,
              baseURL: anthropicBaseFromEndpoint(cfg.baseUrl),
            }),
            kind: 'anthropic',
            authorModel: cfg.model,
            noteError: (e) => noteClaudeError(e),
          };
        }
        return {
          client: createOpenAiCompatibleClient(cfg),
          kind: 'openai_compat',
          authorModel: cfg.model,
          noteError: () => 'other',
        };
      }
    } else {
      const auth = await resolveClaudeAuth(db);
      if (auth) {
        return {
          client: createAnthropicClient(auth),
          kind,
          authorModel: htmlAuthorModelForAuth(auth),
          noteError: (e) => noteClaudeError(e),
        };
      }
    }
  }
  return null;
}

/** The common case: just the active provider's client (or null if none configured). */
/**
 * Anthropic auth for VISION / PDF extraction (image captioning + scanned-PDF read).
 * This unifies vision's credentials with the SAME set chat + text enrichment accept:
 * managed env key, a connected Claude subscription (OAuth), AND a bring-your-own Claude
 * API key configured as an OpenAI-compatible provider pointed at an Anthropic host.
 *
 * Without the BYO-key branch, `resolveClaudeAuth` returns null for a BYO-key user, so
 * `extractImage` no-ops → the image ingests with empty `extracted_text` → the file view
 * shows "No source text.", even though chat + text enrichment work with that same key.
 *
 * Order mirrors {@link resolveLlmProvider}: managed short-circuits inside
 * resolveClaudeAuth; otherwise the user's ACTIVE provider kind decides whether the BYO
 * key or the connected subscription is tried first. (ClaudeAuth carries no baseURL, so a
 * NON-default Anthropic host is not honored for vision — the common api.anthropic.com BYO
 * key works; a custom-host key falls through to the connected subscription, else null.)
 */
export async function resolveVisionAuth(db: Lattice | null): Promise<ClaudeAuth | null> {
  const byoAnthropicKey = (): ClaudeAuth | null => {
    const compat = readOpenAiCompatConfig();
    if (!compat?.apiKey) return null;
    return isAnthropicEndpoint(compat.baseUrl) ? { apiKey: compat.apiKey } : null;
  };
  if (!isManagedModelAuth() && activeProviderKind() === 'openai_compat') {
    return byoAnthropicKey() ?? (await resolveClaudeAuth(db));
  }
  return (await resolveClaudeAuth(db)) ?? byoAnthropicKey();
}

export async function resolveLlmClient(db: Lattice | null): Promise<LlmClient | null> {
  return (await resolveLlmProvider(db))?.client ?? null;
}

/**
 * A minimal "does the model actually respond" check — the onboarding "Testing your AI"
 * step and the settings model-edit save both run this against the resolved provider.
 * Returns `{ ok: true }` when the model answers, or `{ ok: false, error }` with the
 * failure reason (never throws).
 */
export async function smokeTestProvider(
  provider: ResolvedProvider,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const turn = await provider.client.runTurn({
      model: DEFAULT_MODEL,
      system: 'You are a connectivity check. Reply with the single word OK.',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      tools: [],
      temperature: 0,
      maxTokens: 16,
      onText: () => undefined,
    });
    return typeof turn.text === 'string' && turn.text.trim().length > 0
      ? { ok: true }
      : { ok: false, error: 'The model returned an empty response.' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** True when SOME provider is configured (Claude connected or an API-provider endpoint
 *  saved). Cheap presence check for the connected/disconnected gate — mirrors the
 *  `connected` field of GET /api/assistant/config so the server gate and the client wall
 *  agree. */
export async function isAnyProviderConfigured(db: Lattice | null): Promise<boolean> {
  if (readOpenAiCompatConfig()) return true;
  // Reuse the same OAuth/managed presence logic Claude uses.
  const { isClaudeConnected } = await import('../assistant-routes.js');
  return isClaudeConnected(db);
}

/**
 * The RESOLVED wire kind for the active provider, WITHOUT building a client — so the
 * server gate can cheaply decide "any provider connected?" and "does the Claude
 * usage-limit apply?" (only the Anthropic wire does). Returns null when nothing is
 * configured.
 *
 * Uses the CHEAP presence check {@link isClaudeConnected} for the Claude-subscription
 * branch — NOT {@link resolveLlmProvider}'s `resolveClaudeAuth`, which can trigger a
 * network token-refresh + credential write. This gate is on the hot chat/ingest/import
 * path and must not refresh (the route does the real refresh where the token is actually
 * used). It also makes this predicate identical to GET /api/assistant/config's `connected`
 * (both presence), so the server gate and the client wall never disagree. The wire-pick
 * order + endpoint detection otherwise mirror {@link resolveLlmProvider}.
 */
export async function resolvedProviderKind(db: Lattice | null): Promise<LlmProviderKind | null> {
  const order: LlmProviderKind[] = isManagedModelAuth()
    ? ['anthropic']
    : activeProviderKind() === 'openai_compat'
      ? ['openai_compat', 'anthropic']
      : ['anthropic', 'openai_compat'];
  for (const kind of order) {
    if (kind === 'openai_compat') {
      const cfg = readOpenAiCompatConfig();
      if (cfg) return isAnthropicEndpoint(cfg.baseUrl) ? 'anthropic' : 'openai_compat';
    } else if (await isClaudeConnected(db)) {
      return 'anthropic';
    }
  }
  return null;
}

/** True when a base URL points at Anthropic's API (the native Messages wire), so a Claude
 *  API key configured against it uses the Anthropic client, not the OpenAI-compat one. */
export function isAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'anthropic.com' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')
    );
  } catch {
    return false;
  }
}

/** Normalize a user-entered Anthropic endpoint to the SDK `baseURL` (host origin); the
 *  SDK appends `/v1/messages`. Strips a trailing `/v1/messages`, `/v1`, or `/` so
 *  `https://api.anthropic.com`, `.../v1`, and `.../v1/messages` all resolve identically. */
export function anthropicBaseFromEndpoint(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const path = u.pathname.replace(/\/v1(\/messages)?\/?$/i, '').replace(/\/+$/, '');
    return u.origin + path;
  } catch {
    return baseUrl;
  }
}
