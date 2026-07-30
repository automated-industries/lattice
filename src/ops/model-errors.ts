/**
 * Failure reasons the model-configuration capabilities raise, as stable codes.
 *
 * A capability cannot answer with a status. The same call has to serve a request
 * handler, a command line, and a library caller, and only one of those has a
 * response to write — so it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This is the same shape the cloud capabilities already use.
 *
 * The codes name the SITUATION rather than a number, so a caller with no HTTP
 * anywhere near it can branch on one and say something useful.
 */

/**
 * Every failure a model-configuration capability distinguishes. One list feeds
 * both the type and the runtime check, so the two cannot disagree.
 *
 *   invalid_request          the arguments are wrong or incomplete; nothing was attempted
 *   managed_model_auth       the deployment's operator owns the credential — per-user
 *                            configuration is switched off here
 *   provider_not_configured  the backend being selected has nothing stored to select
 *   account_not_signed_in    there is no signed-in account to mint a credential from
 *   no_signin_in_progress    a code came back for a subscription connection that is not
 *                            waiting for one — never started here, already finished, or
 *                            aged out. Kept apart from `invalid_request` because the fix
 *                            is different: start again rather than re-paste
 *   no_voice_key             no speech-to-text credential is available
 *   transcription_failed     the speech service was reached and would not transcribe
 */
const MODEL_ERROR_CODES = [
  'invalid_request',
  'managed_model_auth',
  'provider_not_configured',
  'account_not_signed_in',
  'no_signin_in_progress',
  'no_voice_key',
  'transcription_failed',
] as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type ModelError = Error & { code: ModelErrorCode };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * Plenty of thrown values carry a `code` — a filesystem error, a database
 * refusal — and a reader that accepted any string would classify one of those as
 * a capability's own answer and report it as whatever status happened to be
 * nearest. An unrecognised failure is a real fault and must read as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(MODEL_ERROR_CODES);

/** Build a tagged model-configuration failure. Throw it; never return it. */
export function modelError(code: ModelErrorCode, message: string): ModelError {
  return Object.assign(new Error(message), { code });
}

/**
 * The model-configuration code on a thrown value, or undefined when it carries
 * none of ours — including when it carries somebody else's.
 */
export function modelErrorCode(e: unknown): ModelErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as ModelErrorCode;
}

/** The sentence every managed-deployment refusal uses, so they cannot drift apart. */
export const MANAGED_MODEL_REFUSAL = 'The model backend is managed by the operator.';

/** The same refusal, worded for the per-user credential routes. */
export const MANAGED_CREDENTIAL_REFUSAL =
  'Model access is managed by the host; per-user credentials are disabled.';
