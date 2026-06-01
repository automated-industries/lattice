import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Lattice } from '../../lattice.js';

/**
 * Bearer-token auth for team-cloud server mode.
 *
 * Tokens are issued as random 32-byte strings prefixed with `lat_` and
 * stored only as a SHA-256 hex hash in `__lattice_api_tokens.token_hash`.
 * Verification recomputes the hash on the incoming bearer and looks it up
 * directly in the tokens table — SHA-256 over 256 bits of entropy gives a
 * collision probability vanishingly close to zero, so the lookup is the
 * authentication step. A `timingSafeEqual` re-check on the matched row is
 * defence-in-depth against pathological cases (corrupted hash column,
 * adapter-level case-folding).
 *
 * scrypt/bcrypt are intentionally NOT used here — they exist to slow down
 * brute-forcing of low-entropy human passwords. API tokens with 256 bits
 * of entropy don't need slowdown; a fast hash is correct.
 */

const TOKEN_PREFIX = 'lat_';
const INVITE_PREFIX = 'latinv_';
const TOKEN_BYTES = 32;
const INVITE_BYTES = 24;

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  name: string | null;
}

export interface AuthContext {
  user: AuthenticatedUser;
  tokenId: string;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  revoked_at: string | null;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  deleted_at: string | null;
}

/**
 * Parse a bearer token out of the Authorization header. Returns null when
 * the header is missing, malformed, or doesn't carry the expected prefix.
 */
export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  if (!token?.startsWith(TOKEN_PREFIX)) return null;
  return token;
}

/** Hash a raw API token. Used at issue and at verify. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a new API token. Returns the raw form (shown to the user exactly
 * once) and its hash (stored in `__lattice_api_tokens.token_hash`).
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;
  return { raw, hash: hashToken(raw) };
}

/**
 * Mint a new invitation token. Distinct prefix (`latinv_`) so the bearer
 * extractor in `extractBearer()` rejects it for authentication — invites
 * are exchanged via the redeem endpoint, never used as bearer tokens.
 *
 * Slightly shorter than API tokens (24 bytes vs 32) because invites are
 * short-lived and one-time — still 192 bits of entropy, well past brute-
 * force range.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = `${INVITE_PREFIX}${randomBytes(INVITE_BYTES).toString('hex')}`;
  return { raw, hash: hashToken(raw) };
}

/**
 * Resolve the user behind an incoming request's bearer token. Returns null
 * when the header is absent, the token doesn't match a stored hash, the
 * matching row is revoked, or the user is soft-deleted.
 *
 * On success, fires a best-effort `last_used_at` update on the matched
 * token row; failures there are swallowed so they don't fail auth.
 */
export async function authenticate(req: IncomingMessage, db: Lattice): Promise<AuthContext | null> {
  const raw = extractBearer(req);
  if (!raw) return null;

  const incomingHash = hashToken(raw);
  const rows = (await db.query('__lattice_api_tokens', {
    filters: [
      { col: 'token_hash', op: 'eq', val: incomingHash },
      { col: 'revoked_at', op: 'isNull' },
    ],
    limit: 1,
  })) as unknown as ApiTokenRow[];

  const tokenRow = rows[0];
  if (!tokenRow) return null;

  const storedBuf = Buffer.from(tokenRow.token_hash, 'hex');
  const incomingBuf = Buffer.from(incomingHash, 'hex');
  if (storedBuf.length !== incomingBuf.length || !timingSafeEqual(storedBuf, incomingBuf)) {
    return null;
  }

  const userRow = (await db.get('__lattice_users', tokenRow.user_id)) as unknown as UserRow | null;
  if (!userRow || userRow.deleted_at) return null;

  db.update('__lattice_api_tokens', tokenRow.id, {
    last_used_at: new Date().toISOString(),
  }).catch(() => undefined);

  return {
    user: { id: userRow.id, email: userRow.email, name: userRow.name },
    tokenId: tokenRow.id,
  };
}
