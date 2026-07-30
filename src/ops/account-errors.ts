/**
 * Failure reasons the account capabilities raise, as stable codes.
 *
 * A capability cannot answer with a status. The same call has to serve a request
 * handler, a command line, and a library caller, and only one of those has a
 * response to write — so it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This is the shape the cloud and model-configuration capabilities already use.
 *
 * The sign-in client raises its OWN tagged failure for the legs that talk to the
 * account service, carrying which leg failed (see the step tag on those errors).
 * That is deliberately left alone: it already answers the question this file
 * answers, with more detail. The codes here cover the situations that are about
 * THIS machine rather than about the remote call — nothing to exchange, nothing
 * to reach, no manager to delegate to.
 */

/**
 * Every failure an account capability distinguishes. One list feeds both the type
 * and the runtime check, so the two cannot disagree.
 *
 *   invalid_request        the arguments are wrong or incomplete; nothing was attempted
 *   service_unavailable    no account service could be found from this machine at all
 *   no_signin_in_progress  nothing is waiting for a code — it was never started, or it expired
 *   not_signed_in          the operation needs a signed-in account and there is none
 *   not_managed            no workspace manager is configured, so there is nothing to delegate to
 *   manager_failed         the workspace manager was reached and refused, or errored
 */
const ACCOUNT_ERROR_CODES = [
  'invalid_request',
  'service_unavailable',
  'no_signin_in_progress',
  'not_signed_in',
  'not_managed',
  'manager_failed',
] as const;

export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type AccountError = Error & { code: AccountErrorCode };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * Plenty of thrown values carry a `code` — a filesystem error, a fetch failure —
 * and a reader that accepted any string would classify one of those as a
 * capability's own answer and report it as whatever status happened to be
 * nearest. An unrecognised failure is a real fault and must read as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(ACCOUNT_ERROR_CODES);

/** Build a tagged account failure. Throw it; never return it. */
export function accountError(code: AccountErrorCode, message: string): AccountError {
  return Object.assign(new Error(message), { code });
}

/**
 * The account code on a thrown value, or undefined when it carries none of ours —
 * including when it carries somebody else's.
 */
export function accountErrorCode(e: unknown): AccountErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as AccountErrorCode;
}

/** The sentence every "no workspace manager here" refusal uses, so they cannot drift. */
export const NO_WORKSPACE_MANAGER = 'No workspace manager is configured for this session.';
