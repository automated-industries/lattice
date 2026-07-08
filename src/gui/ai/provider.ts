import type { Lattice } from '../../lattice.js';
import type { LlmClient } from './chat.js';
import { createAnthropicClient, DEFAULT_MODEL } from './chat.js';
import { createOpenAiCompatibleClient } from './openai-client.js';
import { resolveClaudeAuth, isManagedModelAuth } from '../assistant-routes.js';
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
        return {
          client: createOpenAiCompatibleClient(cfg),
          kind,
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

/** True when SOME provider is configured (Claude connected or an OpenAI-compatible
 *  endpoint saved). Cheap presence check for the connected/disconnected gate. */
export async function isAnyProviderConfigured(db: Lattice | null): Promise<boolean> {
  if (readOpenAiCompatConfig()) return true;
  // Reuse the same OAuth/managed presence logic Claude uses.
  const { isClaudeConnected } = await import('../assistant-routes.js');
  return isClaudeConnected(db);
}
