import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';

/**
 * Storage for the OpenAI-compatible LLM provider config + the active-provider
 * selection. Kept as a leaf module (it depends only on the machine-local credential
 * store) so BOTH the provider resolver and the assistant routes can read/write it
 * without an import cycle.
 */

export type LlmProviderKind = 'anthropic' | 'openai_compat';

/** Machine-store kind for the OpenAI-compatible endpoint config (a JSON blob). */
export const OPENAI_COMPAT_KIND = 'llm_openai_compat';
/** Machine-store kind for the active-provider selection ('anthropic' | 'openai_compat'). */
export const ACTIVE_PROVIDER_KIND = 'active_llm_provider';

export interface StoredOpenAiCompat {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}

/** Parse the stored OpenAI-compatible config, or null when unset/invalid/incomplete. */
export function readOpenAiCompatConfig(): StoredOpenAiCompat | null {
  const raw = getAssistantCredential(OPENAI_COMPAT_KIND);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<StoredOpenAiCompat>;
    // baseUrl + model are required; apiKey may be empty (keyless local servers).
    if (typeof o.baseUrl === 'string' && o.baseUrl && typeof o.model === 'string' && o.model) {
      return {
        baseUrl: o.baseUrl,
        apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
        model: o.model,
        ...(o.headers && typeof o.headers === 'object' ? { headers: o.headers } : {}),
      };
    }
  } catch {
    // corrupt blob — treated as unconfigured
  }
  return null;
}

/** Persist the OpenAI-compatible endpoint config and make it the active provider. */
export function setOpenAiCompatConfig(cfg: StoredOpenAiCompat): void {
  setAssistantCredential(OPENAI_COMPAT_KIND, JSON.stringify(cfg));
  setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
}

/** Forget the OpenAI-compatible endpoint and fall back to Anthropic as active. */
export function clearOpenAiCompatConfig(): void {
  deleteAssistantCredential(OPENAI_COMPAT_KIND);
  setAssistantCredential(ACTIVE_PROVIDER_KIND, 'anthropic');
}

/** Set which provider answers turns. */
export function setActiveProvider(kind: LlmProviderKind): void {
  setAssistantCredential(ACTIVE_PROVIDER_KIND, kind);
}

/** The provider the user selected as active; defaults to Anthropic. */
export function activeProviderKind(): LlmProviderKind {
  return getAssistantCredential(ACTIVE_PROVIDER_KIND) === 'openai_compat'
    ? 'openai_compat'
    : 'anthropic';
}
