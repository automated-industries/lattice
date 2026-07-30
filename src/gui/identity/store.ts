import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, deriveKey, encrypt } from '../../security/encryption.js';
import {
  ensureConfigDir,
  getOrCreateMasterKey,
  writeFileAtomic,
} from '../../framework/user-config.js';
import type { IdentityEndpoints } from './service.js';

/**
 * Machine-local storage for the linked identity session: the personal bearer a
 * browser-approved sign-in produced, plus the linked email/display name and the
 * membership → local-workspace bookkeeping the sync pass needs for idempotence.
 * Encrypted at rest with the SAME master key as the DB credential store — a
 * bearer is a credential.
 *
 * The half-finished sign-in lives here too, and for the same reason it is
 * encrypted: between "start" and "the person pastes the code back" there is a
 * request secret on this machine that is worth exactly as much as the bearer it
 * will become.
 */

const IDENTITY_SESSION_FILENAME = 'identity-session.json.enc';
const PENDING_SIGNIN_FILENAME = 'identity-pending.json.enc';

export interface IdentitySession {
  /** The personal session bearer. Never logged, never sent anywhere but the service. */
  token: string;
  email: string;
  name: string | null;
  /** Identity-service base the session belongs to (a session never crosses services). */
  serviceBase: string;
  linkedAt: string;
  /** membershipId → local workspace id, written as the sync pass materializes. */
  materialized: Record<string, string>;
  /** membershipIds the service reported revoked — surfaced, not silently hidden. */
  revoked: string[];
}

function sessionPath(): string {
  return join(ensureConfigDir(), IDENTITY_SESSION_FILENAME);
}

export function readIdentitySession(): IdentitySession | null {
  const path = sessionPath();
  if (!existsSync(path)) return null;
  try {
    const key = deriveKey(getOrCreateMasterKey());
    const parsed = JSON.parse(
      decrypt(readFileSync(path, 'utf8').trim(), key),
    ) as Partial<IdentitySession>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    return {
      token: parsed.token,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      name: typeof parsed.name === 'string' ? parsed.name : null,
      serviceBase: typeof parsed.serviceBase === 'string' ? parsed.serviceBase : '',
      linkedAt: typeof parsed.linkedAt === 'string' ? parsed.linkedAt : '',
      materialized:
        parsed.materialized && typeof parsed.materialized === 'object' ? parsed.materialized : {},
      revoked: Array.isArray(parsed.revoked)
        ? parsed.revoked.filter((r) => typeof r === 'string')
        : [],
    };
  } catch (e) {
    // Exists but unreadable = wrong master key / corrupt store — surface, never
    // silently treat as signed-out (the user would re-link and orphan a session).
    console.warn(
      `[lattice] ${IDENTITY_SESSION_FILENAME} exists but could not be read (wrong encryption ` +
        `key or corrupt store): ${(e as Error).message}`,
    );
    return null;
  }
}

export function writeIdentitySession(session: IdentitySession): void {
  const key = deriveKey(getOrCreateMasterKey());
  writeFileAtomic(sessionPath(), encrypt(JSON.stringify(session), key) + '\n');
}

/** Sign out locally: forget the bearer + bookkeeping. (Materialized workspaces
 *  stay — they are the user's data; a revoked membership stops CONNECTING.) */
export function clearIdentitySession(): void {
  try {
    unlinkSync(sessionPath());
  } catch {
    // already gone
  }
}

// ── The half-finished sign-in ──────────────────────────────────────────────

/**
 * A sign-in that has been started and not yet finished: the service issued a
 * request id and a matching secret, and it is waiting for the one-time code the
 * person gets after approving it.
 *
 * On disk rather than in a variable, because the two halves of the handshake do
 * not have to happen in the same process. A command that starts a sign-in exits
 * before the person has finished approving it; the command that hands the code
 * back is a separate run, and with the request secret held in memory it would
 * have nothing to exchange. Persisting it is what makes "start it here, finish
 * it there" possible at all — and it also means a restart mid-sign-in no longer
 * silently throws the attempt away.
 *
 * Exactly one is kept: starting a sign-in replaces whatever was waiting, which
 * is the same rule the in-memory version enforced by assignment.
 */
export interface PendingSignIn {
  /** The service's id for this attempt — echoed back by the approval page. */
  requestId: string;
  /** The half of the handshake only this machine holds. Worth as much as a bearer. */
  requestSecret: string;
  /** The service the attempt was started against; a code never crosses services. */
  endpoints: IdentityEndpoints;
  /** Epoch milliseconds the attempt started, for the expiry below. */
  startedAt: number;
}

/**
 * How long an unfinished sign-in stays usable. Long enough to walk to another
 * machine, open the link, and approve it; short enough that an abandoned attempt
 * does not leave a usable secret lying around for the rest of the day.
 */
export const PENDING_SIGNIN_TTL_MS = 20 * 60 * 1000;

function pendingPath(): string {
  return join(ensureConfigDir(), PENDING_SIGNIN_FILENAME);
}

/**
 * The sign-in waiting for its code, or null when there is none.
 *
 * An expired attempt reads as no attempt AND is deleted on the way out: leaving
 * a spent secret on disk to be re-read forever is the failure this store exists
 * to avoid, and a caller that has to remember to check the age would eventually
 * forget.
 */
export function readPendingSignIn(): PendingSignIn | null {
  const path = pendingPath();
  if (!existsSync(path)) return null;
  let parsed: Partial<PendingSignIn>;
  try {
    const key = deriveKey(getOrCreateMasterKey());
    parsed = JSON.parse(decrypt(readFileSync(path, 'utf8').trim(), key)) as Partial<PendingSignIn>;
  } catch (e) {
    // Same reasoning as the session store: unreadable is a fact worth saying out
    // loud, not a quiet "no sign-in in progress" that sends the user in circles.
    console.warn(
      `[lattice] ${PENDING_SIGNIN_FILENAME} exists but could not be read (wrong encryption ` +
        `key or corrupt store): ${(e as Error).message}`,
    );
    return null;
  }
  const { requestId, requestSecret, endpoints, startedAt } = parsed;
  if (
    typeof requestId !== 'string' ||
    !requestId ||
    typeof requestSecret !== 'string' ||
    !requestSecret ||
    typeof startedAt !== 'number' ||
    !endpoints ||
    typeof endpoints.exchange !== 'string'
  ) {
    return null;
  }
  if (Date.now() - startedAt > PENDING_SIGNIN_TTL_MS) {
    clearPendingSignIn();
    return null;
  }
  return { requestId, requestSecret, endpoints, startedAt };
}

/** Record the sign-in now waiting for its code, replacing any earlier attempt. */
export function writePendingSignIn(pending: PendingSignIn): void {
  const key = deriveKey(getOrCreateMasterKey());
  writeFileAtomic(pendingPath(), encrypt(JSON.stringify(pending), key) + '\n');
}

/** Forget the waiting sign-in — finished, abandoned, or signed out. */
export function clearPendingSignIn(): void {
  try {
    unlinkSync(pendingPath());
  } catch {
    // already gone
  }
}
