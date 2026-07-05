import { DEFAULT_MODEL } from '../../ai/llm-client.js';

/**
 * Claude usage-limit state — a per-process singleton (chat is per-operator; this
 * is never persisted to the shared DB). When Claude reports a genuine usage limit
 * we flip this on so the assistant AND the Configure-side AI features (ingest,
 * enrich, computed) can show one standard "you've hit your Claude limit" notice
 * and stop spending doomed calls, until the limit resets.
 *
 * The subtlety (see html-author.ts): a `429 rate_limit_error` is NOT always a
 * usage limit. On a Claude subscription a non-entitled model 429s on EVERY call
 * (an entitlement gap, not exhaustion), and a transient rate-limit carries a short
 * retry-after (the SDK already retried). So only a 429 on the entitled DEFAULT
 * chat model with a long/absent retry-after flips the banner.
 */

export type ClaudeLimitKind = 'usage' | 'transient' | 'entitlement' | 'other';

export interface ClaudeLimitState {
  kind: 'usage';
  /** Epoch ms when the limit resets (from retry-after, else a default TTL). */
  resetAt: number;
  message: string;
}

export const CLAUDE_LIMIT_MESSAGE =
  "You've hit your Claude usage limit — the assistant and AI features are paused until it resets.";

/** How long a transient rate-limit's retry-after can be before we treat the 429 as
 *  a real usage limit. The SDK already retried twice, so a 429 that reaches us has
 *  survived backoff; a wait past this is a plan/usage cap, not momentary pressure. */
const TRANSIENT_MAX_MS = 60_000;

/** Fallback reset horizon when a usage 429 gives no retry-after — so the banner
 *  always auto-clears eventually even if nothing else clears it first. */
const DEFAULT_RESET_MS = 30 * 60_000;

let current: ClaudeLimitState | null = null;

interface ClaudeErrorish {
  status?: number;
  headers?: Headers | Record<string, string | undefined>;
}

function retryAfterMs(err: ClaudeErrorish): number | null {
  const h = err.headers;
  let raw: string | undefined | null;
  if (h && typeof (h as Headers).get === 'function') raw = (h as Headers).get('retry-after');
  else if (h) raw = (h as Record<string, string | undefined>)['retry-after'];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1000 : null;
}

/**
 * Classify a Claude error. `model` is the model the failing call used (chat always
 * uses DEFAULT_MODEL). A non-default model implies an entitlement gap, not usage.
 */
export function classifyClaudeError(err: unknown, model: string = DEFAULT_MODEL): ClaudeLimitKind {
  const e = err as ClaudeErrorish | null;
  if (!e || e.status !== 429) return 'other';
  if (model !== DEFAULT_MODEL) return 'entitlement';
  const ra = retryAfterMs(e);
  if (ra !== null && ra < TRANSIENT_MAX_MS) return 'transient';
  return 'usage';
}

/**
 * Record a Claude error; flips the shared limit state ON only for a genuine usage
 * 429. Returns the classification so the caller can decide what to surface.
 */
export function noteClaudeError(err: unknown, model: string = DEFAULT_MODEL): ClaudeLimitKind {
  const kind = classifyClaudeError(err, model);
  if (kind === 'usage') {
    const ra = retryAfterMs(err as ClaudeErrorish);
    current = {
      kind: 'usage',
      resetAt: nowMs() + (ra ?? DEFAULT_RESET_MS),
      message: CLAUDE_LIMIT_MESSAGE,
    };
  }
  return kind;
}

/** The active usage-limit state, or null. Auto-clears once the reset time passes. */
export function getClaudeLimitState(): ClaudeLimitState | null {
  if (current && nowMs() >= current.resetAt) current = null;
  return current;
}

/** Clear the limit — called after any successful model call (Claude is answering). */
export function clearClaudeLimit(): void {
  current = null;
}

function nowMs(): number {
  return Date.now();
}
