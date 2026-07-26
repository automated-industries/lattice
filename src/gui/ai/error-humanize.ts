import type { LlmProviderKind } from './provider-config.js';

/**
 * Turn a raw model/provider failure into a short, human sentence the chat can show.
 * A provider error is often a JSON body (or an SDK error whose message embeds one);
 * that must NEVER reach the user verbatim. We classify by HTTP status where the SDK
 * exposes one and fall back to a generic, blameless message — no stack, no JSON, no
 * internal detail.
 *
 * The ONE deliberate pass-through is an insufficient-credit failure: its structured
 * message carries a top-up URL the chat renders as a friendly "Add more tokens" card
 * (see the GUI's insufficientCreditInfo), so we return it unchanged rather than
 * flattening away the actionable link.
 */

/** Best-effort HTTP status from an SDK/fetch error shape (Anthropic/OpenAI SDKs put
 *  it on `.status`; some transports use `.statusCode`). Null when there is none. */
export function errorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const s = e?.status ?? e?.statusCode;
  return typeof s === 'number' ? s : null;
}

/** The raw error message when present (never stringifies a non-string to
 *  '[object Object]'); empty string when there is no usable message. */
function errorMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  if (typeof m === 'string') return m;
  return typeof err === 'string' ? err : '';
}

/** An authentication failure — an expired/revoked/invalid credential (401/403). */
export function isAuthError(err: unknown): boolean {
  const s = errorStatus(err);
  return s === 401 || s === 403;
}

/** True when the raw failure is an out-of-credit signal the GUI renders as a top-up
 *  card. Matches the proxy's `insufficient_credit` type or an HTTP 402. */
export function isInsufficientCredit(err: unknown): boolean {
  return errorStatus(err) === 402 || errorMessage(err).includes('insufficient_credit');
}

function isLikelyNetworkError(err: unknown): boolean {
  return /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed|timed out|timeout|socket hang/i.test(
    errorMessage(err),
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Human-facing text for an assistant turn failure. Never returns the raw provider
 * error except for the insufficient-credit pass-through described above.
 */
export function humanizeAssistantError(err: unknown, providerKind?: LlmProviderKind): string {
  // Preserve the actionable out-of-credit message (the chat turns it into a top-up card).
  if (isInsufficientCredit(err)) return errorMessage(err);

  const who = providerKind === 'openai_compat' ? 'your AI endpoint' : 'the model';
  const status = errorStatus(err);
  if (status === 401 || status === 403) {
    return `Lattice couldn't sign in to ${who}. Reconnect it in Settings → Assistant and try again.`;
  }
  if (status === 429) {
    return `${cap(who)} is busy right now — wait a moment and send it again.`;
  }
  if (status !== null && status >= 500) {
    return `${cap(who)} had a server error. Please try again in a moment.`;
  }
  if (status !== null && status >= 400) {
    return `${cap(who)} rejected that request. Please try again.`;
  }
  if (isLikelyNetworkError(err)) {
    return `Lattice couldn't reach ${who}. Check your connection and try again.`;
  }
  return `Something went wrong reaching ${who}. Please try again.`;
}
