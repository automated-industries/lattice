import type { Lattice } from '../lattice.js';
import type { FillLlm } from '../schema/computed-fill.js';
import { DEFAULT_MODEL } from './ai/chat.js';
import { resolveLlmClient } from './ai/provider.js';
import { CHEAPEST_MODEL } from '../ai/llm-client.js';

/**
 * Bridge from the computed-table fill engine's minimal {@link FillLlm}
 * interface to the real model client. The engine passes the field's declared
 * tier (`'default'` / `'cheapest'`) as `model`; this adapter maps it to the
 * exported model constants and authenticates the same way every other GUI AI
 * feature does ({@link resolveLlmClient}: the active provider — a connected Claude
 * subscription or a configured OpenAI-compatible endpoint).
 *
 * Auth is resolved PER CALL, not at adapter construction: building the adapter
 * with no credentials must not throw (the fill engine records a per-field
 * error state instead, which is the surfaced, user-visible outcome), and a
 * long-running fill must pick up an OAuth token refresh mid-run.
 */

/** Resolve a field's declared model tier to a concrete model id. */
export function modelForTier(tier: string): string {
  return tier === 'cheapest' ? CHEAPEST_MODEL : DEFAULT_MODEL;
}

/** Build the {@link FillLlm} the computed-table fill runs with. Never throws at build time. */
export function buildComputedFillLlm(db: Lattice): FillLlm {
  return {
    async complete(opts: { system: string; user: string; model: string }): Promise<string> {
      const client = await resolveLlmClient(db);
      if (!client) {
        // Thrown INTO the fill engine, which records it as the field's error
        // state — the loud, user-visible representation of "not configured".
        throw new Error(
          'No model provider is configured — connect Claude or an OpenAI-compatible model to fill AI fields',
        );
      }
      const result = await client.runTurn({
        model: modelForTier(opts.model),
        system: opts.system,
        temperature: 0,
        tools: [],
        messages: [{ role: 'user', content: opts.user }],
        onText: () => {
          /* the fill engine consumes only the final text */
        },
      });
      return result.text;
    },
  };
}
