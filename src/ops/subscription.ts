/**
 * Connecting a Claude subscription, headless.
 *
 * This looked like the one model backend a browser had to own. It does not, and
 * the reason it looked that way is worth writing down: the flow is a PKCE
 * authorization-code exchange, and the verifier it turns on was being kept in a
 * cookie. A cookie makes the exchange browser-shaped by construction — the leg
 * that redeems the code can only run in the session that started it, which means
 * the same process, holding the same browser.
 *
 * Nothing about PKCE requires that. The verifier is a random string this machine
 * generates and keeps; it is a client secret for one attempt, not a session
 * artefact. Kept where the other machine-local secrets are kept — encrypted, with
 * a short life — the two legs become two ordinary calls, and they no longer have
 * to happen in one process:
 *
 *     lattice model subscription      prints the URL to approve
 *     …approve it in any browser…     the page shows a one-time code
 *     lattice model code <code>       this machine is connected
 *
 * ONE leg genuinely needs a person and a browser, and it is not ours: approving
 * the consent screen on the provider's own site, on whatever machine that person
 * happens to be at. Everything on either side of it is here.
 *
 * The app skips the paste when it can, by having the provider redirect back to
 * the running server — a convenience for a machine that has a browser attached,
 * not a second mechanism. Both paths call {@link completeSubscriptionSignIn},
 * store the same token in the same machine-local store, and are indistinguishable
 * afterwards.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, deriveKey, encrypt } from '../security/encryption.js';
import {
  ensureConfigDir,
  getOrCreateMasterKey,
  setAssistantCredential,
  writeFileAtomic,
} from '../framework/user-config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkceVerifier,
  generateState,
  isManualPasteRedirect,
  pkceChallengeFor,
  readOAuthConfig,
  type OAuthConfig,
} from '../gui/ai/oauth.js';
import { CLAUDE_OAUTH_KIND, isManagedModelAuth } from './ai-config.js';
import { clearClaudeAuthWarning } from '../gui/ai/auth-warn-state.js';
import { modelError, MANAGED_CREDENTIAL_REFUSAL } from './model-errors.js';

// ── The half-finished connection ────────────────────────────────────────────

const PENDING_FILENAME = 'subscription-pending.json.enc';

/**
 * A subscription connection that has been started and not yet finished: the PKCE
 * verifier this machine generated, the state it issued, and the redirect the
 * authorize URL was built with.
 *
 * On disk rather than in a cookie or a variable, because the two halves of the
 * handshake do not have to happen in the same process — a command that starts
 * one exits before the person has finished approving it. Encrypted for the same
 * reason the identity store encrypts its half-finished sign-in: between "start"
 * and "the code comes back" the verifier is worth exactly as much as the token it
 * is about to become.
 *
 * Exactly one is kept: starting a connection replaces whatever was waiting.
 */
export interface PendingSubscription {
  /** The PKCE verifier. Only this machine has it, and the exchange needs it. */
  verifier: string;
  /** The state issued at authorize time, echoed back with the code. */
  state: string;
  /** The redirect the authorize URL was built with; the exchange must match it. */
  redirectUri: string;
  /** Epoch milliseconds the attempt started, for the expiry below. */
  startedAt: number;
}

/**
 * How long an unfinished connection stays usable. Long enough to open the link
 * on another machine, approve it, and copy the code back; short enough that an
 * abandoned attempt does not leave a usable verifier lying around all day.
 */
export const PENDING_SUBSCRIPTION_TTL_MS = 20 * 60 * 1000;

function pendingPath(): string {
  return join(ensureConfigDir(), PENDING_FILENAME);
}

/**
 * The connection waiting for its code, or null when there is none.
 *
 * An expired attempt reads as no attempt AND is deleted on the way out: leaving a
 * spent verifier on disk to be re-read forever is the failure this store exists
 * to avoid, and a caller that had to remember to check the age would forget.
 */
export function readPendingSubscription(): PendingSubscription | null {
  const path = pendingPath();
  if (!existsSync(path)) return null;
  let parsed: Partial<PendingSubscription>;
  try {
    const key = deriveKey(getOrCreateMasterKey());
    parsed = JSON.parse(
      decrypt(readFileSync(path, 'utf8').trim(), key),
    ) as Partial<PendingSubscription>;
  } catch (e) {
    // Unreadable is a fact worth saying out loud, not a quiet "nothing in
    // progress" that sends somebody round the same loop again.
    console.warn(
      `[lattice] ${PENDING_FILENAME} exists but could not be read (wrong encryption key or ` +
        `corrupt store): ${(e as Error).message}`,
    );
    return null;
  }
  const { verifier, state, redirectUri, startedAt } = parsed;
  if (
    typeof verifier !== 'string' ||
    !verifier ||
    typeof state !== 'string' ||
    !state ||
    typeof redirectUri !== 'string' ||
    !redirectUri ||
    typeof startedAt !== 'number'
  ) {
    return null;
  }
  if (Date.now() - startedAt > PENDING_SUBSCRIPTION_TTL_MS) {
    clearPendingSubscription();
    return null;
  }
  return { verifier, state, redirectUri, startedAt };
}

/** Record the connection now waiting for its code, replacing any earlier attempt. */
function writePendingSubscription(pending: PendingSubscription): void {
  const key = deriveKey(getOrCreateMasterKey());
  writeFileAtomic(pendingPath(), encrypt(JSON.stringify(pending), key) + '\n');
}

/** Forget the waiting connection — finished, abandoned, or expired. */
export function clearPendingSubscription(): void {
  try {
    unlinkSync(pendingPath());
  } catch {
    // already gone
  }
}

/**
 * The connection waiting for its code, WITHOUT the verifier that would let a
 * caller finish it somewhere else. Enough to tell a person "you started one and
 * it has not been finished", which is the difference between a stuck attempt and
 * no attempt at all.
 */
export interface PendingSubscriptionSignIn {
  /** When it was started, ISO-8601. */
  startedAt: string;
}

export function pendingSubscriptionSignIn(): PendingSubscriptionSignIn | null {
  const pending = readPendingSubscription();
  if (!pending) return null;
  return { startedAt: new Date(pending.startedAt).toISOString() };
}

// ── Starting one ────────────────────────────────────────────────────────────

/** What a started connection gives the caller to act on. */
export interface StartedSubscriptionSignIn {
  /** The URL a person opens and approves. Anywhere — it need not be this machine. */
  authorizeUrl: string;
  /**
   * True when the provider will DISPLAY the code for a person to copy, which is
   * the headless path. False when it will redirect back to a running server
   * instead, and nothing has to be pasted.
   */
  manualPaste: boolean;
}

export interface StartSubscriptionSignInInput {
  /**
   * Where the provider should send the approval back to, when the caller is
   * running a server that can receive it. Omit it and the provider's registered
   * console redirect is used, which shows the code to be pasted.
   */
  redirectUri?: string;
}

/**
 * Begin connecting a Claude subscription: generate this attempt's PKCE verifier
 * and state, remember them, and return the URL to approve.
 *
 * @throws `managed_model_auth` on a deployment whose operator owns the model
 * credential — per-user configuration is switched off there, and offering a
 * connect that would never be read would be worse than saying so.
 */
export function startSubscriptionSignIn(
  input: StartSubscriptionSignInInput = {},
): StartedSubscriptionSignIn {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_CREDENTIAL_REFUSAL);
  const cfg = readOAuthConfig();
  // Only fill in a redirect when none is configured: the default is the
  // provider's registered console redirect, i.e. the code-paste flow.
  if (!cfg.redirectUri && input.redirectUri) cfg.redirectUri = input.redirectUri;
  const verifier = generatePkceVerifier();
  const state = generateState();
  writePendingSubscription({
    verifier,
    state,
    redirectUri: cfg.redirectUri,
    startedAt: Date.now(),
  });
  return {
    authorizeUrl: buildAuthorizeUrl(cfg, state, pkceChallengeFor(verifier)),
    manualPaste: isManualPasteRedirect(cfg.redirectUri),
  };
}

// ── Finishing one ───────────────────────────────────────────────────────────

/** The config the exchange runs against, pinned to the redirect the start used. */
function exchangeConfig(redirectUri: string): OAuthConfig {
  // The authorization server binds the code to the redirect it was issued for,
  // so the exchange has to present the SAME one the authorize URL carried — not
  // whatever the environment resolves to now.
  return { ...readOAuthConfig(), redirectUri };
}

/**
 * Finish connecting a subscription: redeem the approved code and store the
 * token.
 *
 * The pasted value may be `<code>#<state>`, which is how the provider's page
 * presents it; the state half is split off and checked against the one this
 * machine issued.
 *
 * @throws `invalid_request` when the code is empty or its state does not match
 * the attempt in progress, and `no_signin_in_progress` when nothing is waiting
 * for a code — never started here, already finished, or aged out. Those are
 * different fixes, and collapsing them into one message sends people round the
 * loop re-pasting a code that can never work. A rejected code arrives from the
 * exchange itself, already carrying the reason.
 */
export async function completeSubscriptionSignIn(pastedCode: string): Promise<void> {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_CREDENTIAL_REFUSAL);
  const raw = pastedCode.trim();
  const hash = raw.indexOf('#');
  const code = hash >= 0 ? raw.slice(0, hash) : raw;
  const pastedState = hash >= 0 ? raw.slice(hash + 1) : '';
  const pending = readPendingSubscription();
  if (!pending) {
    throw modelError(
      'no_signin_in_progress',
      'This connection attempt expired or was interrupted — start a new one and approve it ' +
        'again, then hand the fresh code back right away.',
    );
  }
  if (!code) {
    throw modelError('invalid_request', 'Paste the full code from the authorization page.');
  }
  // A code that carried a state must match the one we issued.
  if (pastedState && pastedState !== pending.state) {
    throw modelError(
      'invalid_request',
      'That code does not match this connection attempt — start the connection again.',
    );
  }
  const tokens = await exchangeCodeForTokens(
    exchangeConfig(pending.redirectUri),
    code,
    pending.verifier,
    pending.state,
  );
  // Machine-level, like the refresh path — so a connected subscription persists
  // across every workspace, not just whichever one happened to be open.
  setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify(tokens));
  // Successful connect clears any standing "reconnect me" warning.
  clearClaudeAuthWarning();
  // Single-use: the attempt is spent whether or not the caller asks again.
  clearPendingSubscription();
}
