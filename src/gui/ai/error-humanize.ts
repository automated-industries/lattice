import type { LlmProviderKind } from './provider-config.js';

/**
 * Turn a raw failure into a short, human sentence the GUI can show. A remote error
 * is often a JSON body (or an SDK error whose message embeds one); that must NEVER
 * reach the user verbatim. We classify by HTTP status where one is exposed and fall
 * back to a generic, blameless message — no stack, no JSON, no internal detail.
 *
 * The classifier is deliberately provider-agnostic: the same status → cause mapping
 * serves the assistant turn AND the account sign-in handshake, which used to hand a
 * raw string straight to the first-run wall.
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

/**
 * Every scrap of text we may CLASSIFY on: the message plus any `detail` an internal
 * error carries. A transport failure keeps its short user-safe sentence in `message`
 * and the underlying reason in `detail`, so classification has to read both.
 * Classification only — none of this is ever returned to a user.
 */
function rawErrorText(err: unknown): string {
  const d = (err as { detail?: unknown } | null)?.detail;
  return errorMessage(err) + (typeof d === 'string' && d ? ` ${d}` : '');
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
    rawErrorText(err),
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The cause bucket a remote failure falls into, independent of who was called. */
export type FailureKind = 'auth' | 'busy' | 'server' | 'client' | 'network' | 'unknown';

/**
 * Classify any remote failure by cause. Status wins where there is one (it is the
 * only reliable signal); a status-less failure is probed for transport symptoms;
 * everything else is honestly `unknown` rather than guessed at.
 */
export function failureKind(err: unknown): FailureKind {
  const status = errorStatus(err);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'busy';
  if (status !== null && status >= 500) return 'server';
  if (status !== null && status >= 400) return 'client';
  if (isLikelyNetworkError(err)) return 'network';
  return 'unknown';
}

/**
 * Remove a bare HTTP status code from a sentence — "(500)", "HTTP 502",
 * "status code 503". A number is meaningless to the person reading it and tells
 * them nothing about what to do next, so no user-facing string may carry one.
 * Applied as a backstop to text we did not compose ourselves.
 */
export function stripStatusCodes(text: string): string {
  return text
    .replace(/\s*\(\s*(?:HTTP\s*)?[1-5]\d{2}\s*\)/gi, '')
    .replace(/\s*\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*[1-5]\d{2}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Human-facing text for a model refusal (stop_reason: "refusal").
 * Distinct from provider errors — the model declined to answer this request.
 */
export function humanizeAssistantRefusal(): string {
  return 'The model declined to answer that request. Try rephrasing it.';
}

/**
 * Human-facing text when the model runs out of context window (stop_reason: "model_context_window_exceeded").
 * Suggests a smaller scope or fresh conversation.
 */
export function humanizeContextWindowExceeded(): string {
  return 'The response got too long for the model to finish. Try a smaller scope or start a fresh conversation.';
}

/**
 * Human-facing text for an assistant turn failure. Never returns the raw provider
 * error except for the insufficient-credit pass-through described above.
 */
export function humanizeAssistantError(err: unknown, providerKind?: LlmProviderKind): string {
  // Preserve the actionable out-of-credit message (the chat turns it into a top-up card).
  if (isInsufficientCredit(err)) return errorMessage(err);

  const who = providerKind === 'openai_compat' ? 'your AI endpoint' : 'the model';
  switch (failureKind(err)) {
    case 'auth':
      return `Lattice couldn't sign in to ${who}. Reconnect it in Settings → Assistant and try again.`;
    case 'busy':
      return `${cap(who)} is busy right now — wait a moment and send it again.`;
    case 'server':
      return `${cap(who)} had a server error. Please try again in a moment.`;
    case 'client':
      return `${cap(who)} rejected that request. Please try again.`;
    case 'network':
      return `Lattice couldn't reach ${who}. Check your connection and try again.`;
    default:
      return `Something went wrong reaching ${who}. Please try again.`;
  }
}

// ── Account sign-in ────────────────────────────────────────────────────────────
//
// The sign-in handshake has several legs that fail in completely different ways but
// used to surface one identical opaque string. Two consequences, both fixed here:
// a person on the first-run wall was shown a status code they can do nothing with,
// and a bug report could not say WHICH leg failed without reading the source. Every
// failure is now tagged with its step, and the step is named in the message.

/** Which leg of the account handshake a failure came from. */
export type IdentityStep =
  | 'discovery'
  | 'start'
  | 'exchange'
  | 'workspaces'
  | 'credential'
  | 'model-credential';

/** Plain-language name for each leg — this is what makes a report diagnosable. */
const IDENTITY_STEP_LABEL: Record<IdentityStep, string> = {
  discovery: 'finding the sign-in service',
  start: 'starting sign-in',
  exchange: 'confirming your sign-in code',
  workspaces: 'loading your workspaces',
  credential: 'opening your workspace',
  'model-credential': 'setting up your account tokens',
};

export function identityStepLabel(step: IdentityStep): string {
  return IDENTITY_STEP_LABEL[step];
}

/** The step tag carried by a sign-in-client failure; null for anything else. */
export function identityStepOf(err: unknown): IdentityStep | null {
  const s = (err as { step?: unknown } | null)?.step;
  return typeof s === 'string' && s in IDENTITY_STEP_LABEL ? (s as IdentityStep) : null;
}

/**
 * The escape hatch. A sign-in failure lands on the FIRST screen, before any
 * workspace exists — a user who cannot get past it cannot use the app at all, so
 * the message has to point at the two backends that do not depend on this service.
 */
const IDENTITY_ALTERNATIVES =
  'You can connect a Claude account or your own OpenAI-compatible endpoint instead.';

export interface HumanizeIdentityOptions {
  /** Which leg failed, when the error itself is not tagged. */
  step?: IdentityStep;
  /** Append the escape hatch — set where the failure is a dead end (the wall). */
  suggestAlternatives?: boolean;
}

/**
 * Human-facing text for an account sign-in failure. Never returns a status code and
 * never echoes the remote service's own error body; the diagnosable detail is logged
 * where the failure is raised, not shown.
 */
export function humanizeIdentityError(err: unknown, opts: HumanizeIdentityOptions = {}): string {
  const tagged = identityStepOf(err);
  const step = tagged ?? opts.step ?? null;
  const where = step ? ` while ${identityStepLabel(step)}` : '';
  const alt = opts.suggestAlternatives ? ` ${IDENTITY_ALTERNATIVES}` : '';

  // Untagged means the sentence was written by our own code for a person to read
  // (e.g. "No sign-in in progress — start again from the user menu."). Keep it;
  // only strip a status code in case one leaked in from somewhere unexpected.
  if (tagged === null) {
    const own = stripStatusCodes(errorMessage(err));
    return own ? own + alt : `Something went wrong signing in${where}. Please try again.${alt}`;
  }

  const kind = failureKind(err);
  // At the exchange leg the request carries the one-time code, so a 4xx is almost
  // always the code itself — say that instead of blaming the service.
  if (step === 'exchange' && (kind === 'client' || kind === 'auth')) {
    return (
      "That sign-in code wasn't accepted — it may have expired or already been used. " +
      `Start the sign-in again from the beginning (it failed${where}).${alt}`
    );
  }
  switch (kind) {
    case 'auth':
      return `Lattice Cloud rejected your sign-in${where}. Sign in again.${alt}`;
    case 'busy':
      return `Lattice Cloud sign-in is busy right now — it failed${where}. Wait a moment and try again.${alt}`;
    case 'server':
      return `Lattice Cloud sign-in is temporarily unavailable — it failed${where}. Try again shortly.${alt}`;
    case 'client':
      return `Lattice Cloud sign-in refused that request${where}. Start the sign-in again from the beginning.${alt}`;
    case 'network':
      return `Lattice couldn't reach Lattice Cloud sign-in${where}. Check your connection and try again.${alt}`;
    default:
      return `Lattice Cloud sign-in did not complete${where}. Try again shortly.${alt}`;
  }
}

/**
 * Text for "no sign-in service could be found at all" — the discovery leg, which
 * has no error object to classify because nothing ever answered.
 */
export function humanizeIdentityUnavailable(suggestAlternatives = false): string {
  return (
    `Lattice Cloud sign-in isn't reachable from this machine (it failed ${identityStepLabel('discovery')}). ` +
    `Check your connection and try again shortly.${suggestAlternatives ? ` ${IDENTITY_ALTERNATIVES}` : ''}`
  );
}
