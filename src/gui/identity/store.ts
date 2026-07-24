import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, deriveKey, encrypt } from '../../security/encryption.js';
import {
  ensureConfigDir,
  getOrCreateMasterKey,
  writeFileAtomic,
} from '../../framework/user-config.js';

/**
 * Machine-local storage for the linked identity session: the personal bearer a
 * browser-approved sign-in produced, plus the linked email/display name and the
 * membership → local-workspace bookkeeping the sync pass needs for idempotence.
 * Encrypted at rest with the SAME master key as the DB credential store — a
 * bearer is a credential.
 */

const IDENTITY_SESSION_FILENAME = 'identity-session.json.enc';

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
