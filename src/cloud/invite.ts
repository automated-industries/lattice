import { randomBytes, scryptSync, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Email-bound, encrypted cloud-invite tokens. An invite carries the SAME scoped
 * `lm_*` member credential the join flow already uses (host/port/dbname/user/
 * password) — just opaque, email-bound, and pooler-correct — so the member
 * enters one token + their email instead of five plaintext fields.
 *
 * Crypto: a random 32-byte `tokenSecret` (the bearer secret) is carried in the
 * token; the AES-256-GCM key is `HKDF(tokenSecret, salt = scrypt(email, salt16))`
 * so decryption needs BOTH the token AND the matching email. The normalized email
 * is also the GCM AAD. This is bearer/magic-link grade: the token IS the secret;
 * email *binds* (you can't decrypt without it) but is not strong confidentiality
 * against someone holding token AND email. Real protections: private delivery,
 * short expiry, and the embedded credential being a scoped, RLS-confined,
 * revocable `lm_*` role. No company/internal identifiers belong in this file.
 */

const VERSION = 1;
const SALT_LEN = 16;
const SECRET_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HKDF_INFO = Buffer.from('lattice-invite-v1', 'utf8');

export interface InviteCoords {
  host: string;
  port: number;
  dbname: string;
}

export interface InvitePayload {
  v: 1;
  host: string;
  port: number;
  dbname: string;
  /** The connection user — scoped `lm_*` role, pooler-corrected when needed. */
  user: string;
  password: string;
  /** The bare role name (for audit + revocation). */
  role: string;
  /** Normalized email the token is bound to. */
  email: string;
  /** ISO-8601 expiry. */
  expires_at: string;
  /** Human name for the workspace the member will create on join (the owner's
   *  cloud name). Optional — older tokens omit it; the join falls back to a
   *  sanitized default. */
  workspace_name?: string;
}

/** Lowercase + trim so the email term is stable regardless of entry casing. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Supabase's pooler requires the connection user be `<role>.<projectref>`. Derive
 * the ref from the owner's own connection user (`postgres.<ref>`) and bake it in
 * so the invitee never has to type/know the username. Non-pooler hosts keep the
 * bare role.
 */
export function poolerAwareUser(host: string, role: string, ownerUser: string): string {
  if (!/\.pooler\.supabase\.com$/i.test(host)) return role;
  const dot = ownerUser.indexOf('.');
  const ref = dot >= 0 ? ownerUser.slice(dot + 1).trim() : '';
  return ref ? `${role}.${ref}` : role;
}

function deriveKey(tokenSecret: Buffer, email: string, salt: Buffer): Buffer {
  // scrypt over the normalized email yields an email-bound HKDF salt; HKDF over
  // the random tokenSecret with that salt yields the AES key — so the email is
  // required to reconstruct the key even though tokenSecret is in the token.
  const emailSalt = Buffer.from(scryptSync(normalizeEmail(email), salt, KEY_LEN));
  return Buffer.from(hkdfSync('sha256', tokenSecret, emailSalt, HKDF_INFO, KEY_LEN));
}

export interface MintInput {
  coords: InviteCoords;
  /** The (already pooler-corrected) connection user. */
  user: string;
  password: string;
  role: string;
  email: string;
  expiresAt: Date;
  /** Human name for the workspace the member creates on join (the owner's cloud
   *  name); stamped into the payload so the member's new workspace is named. */
  workspaceName?: string;
}

/** Mint an email-bound, encrypted invite token. */
export function mintInviteToken(input: MintInput): string {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error('lattice: an invite must be bound to an email');
  const salt = randomBytes(SALT_LEN);
  const tokenSecret = randomBytes(SECRET_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = deriveKey(tokenSecret, email, salt);
  const payload: InvitePayload = {
    v: 1,
    host: input.coords.host,
    port: input.coords.port,
    dbname: input.coords.dbname,
    user: input.user,
    password: input.password,
    role: input.role,
    email,
    expires_at: input.expiresAt.toISOString(),
    ...(input.workspaceName?.trim() ? { workspace_name: input.workspaceName.trim() } : {}),
  };
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(email, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), salt, tokenSecret, nonce, ct, tag]).toString(
    'base64url',
  );
}

/**
 * Redeem an invite locally with the email it was sent to. A GCM tag failure
 * means the wrong email or a corrupt/tampered token — surfaced clearly, never
 * swallowed. Enforces expiry.
 */
export function redeemInviteToken(email: string, token: string): InvitePayload {
  const normEmail = normalizeEmail(email);
  if (!normEmail) throw new Error('lattice: enter the email this invite was sent to');
  const raw = Buffer.from(token.trim(), 'base64url');
  const minLen = 1 + SALT_LEN + SECRET_LEN + NONCE_LEN + TAG_LEN;
  if (raw.length < minLen || raw[0] !== VERSION) {
    throw new Error('lattice: invite token is malformed or from an unsupported version');
  }
  let off = 1;
  const salt = raw.subarray(off, (off += SALT_LEN));
  const tokenSecret = raw.subarray(off, (off += SECRET_LEN));
  const nonce = raw.subarray(off, (off += NONCE_LEN));
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(off, raw.length - TAG_LEN);
  const key = deriveKey(tokenSecret, normEmail, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(normEmail, 'utf8'));
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('lattice: invite token does not match this email (or is corrupt)');
  }
  let payload: InvitePayload;
  try {
    payload = JSON.parse(plaintext) as InvitePayload;
  } catch {
    throw new Error('lattice: invite token payload is unreadable');
  }
  if (normalizeEmail(payload.email) !== normEmail) {
    throw new Error('lattice: invite token does not match this email');
  }
  if (Number.isNaN(Date.parse(payload.expires_at)) || Date.parse(payload.expires_at) < Date.now()) {
    throw new Error('lattice: this invite has expired — ask the owner for a new one');
  }
  return payload;
}
