import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque token helpers for the grandfathered direct-connection invite path
 * (`direct-ops` / `register-direct`). Relocated out of the deleted team-cloud
 * HTTP server. Retired together with the direct-connection team model once the
 * cloud is fully on scoped Postgres roles + RLS.
 */
const TOKEN_PREFIX = 'lat_';
const INVITE_PREFIX = 'latinv_';
const TOKEN_BYTES = 32;
const INVITE_BYTES = 24;

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateToken(): { raw: string; hash: string } {
  const raw = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;
  return { raw, hash: hashToken(raw) };
}

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = `${INVITE_PREFIX}${randomBytes(INVITE_BYTES).toString('hex')}`;
  return { raw, hash: hashToken(raw) };
}
