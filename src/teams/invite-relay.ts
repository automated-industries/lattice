/**
 * Client-side glue for the latticesql.com invite relay.
 *
 * Two operations: publish (inviter posts an encrypted envelope on mint)
 * and resolve (invitee posts {token, email} to discover the cloud URL).
 *
 * Both are best-effort against a public HTTPS endpoint. Network errors
 * never block invite minting — the old URL+password path remains
 * available behind the GUI's "Advanced" disclosure if the relay is
 * down or unreachable.
 *
 * Security knobs (Part C11 of the 1.14 plan):
 *   LATTICE_INVITE_RELAY_BASE   default `https://www.latticesql.com`.
 *                               Non-default values trigger a stderr WARN
 *                               at first use so an attacker can't silently
 *                               redirect the relay via env injection.
 *   LATTICE_DEV=1               allows `http://localhost:*` /
 *                               `http://127.0.0.1:*` overrides; otherwise
 *                               non-https URLs are refused.
 *   LATTICE_INVITE_PUBLISH=off  skip publish entirely (offline / CI).
 */

import { aesGcmEncrypt, sha256Hex } from './invite-crypto.js';

const DEFAULT_BASE = 'https://www.latticesql.com';
const PUBLISH_PATH = '/api/invites/publish';
const REDEEM_PATH = '/api/invites/redeem';
const PUBLISH_TIMEOUT_MS = 3_000;
const REDEEM_TIMEOUT_MS = 8_000;

let warnedNonDefault = false;

function relayBase(): string {
  return process.env.LATTICE_INVITE_RELAY_BASE ?? DEFAULT_BASE;
}

function warnIfNonDefault(base: string): void {
  if (warnedNonDefault) return;
  if (base !== DEFAULT_BASE) {
    process.stderr.write(`WARN: Using non-default lattice invite relay <${base}>\n`);
    warnedNonDefault = true;
  }
}

function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid invite relay URL: ${url}`);
  }
  if (parsed.protocol === 'https:') return;
  if (
    process.env.LATTICE_DEV === '1' &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return;
  }
  throw new Error(`Refusing non-https invite relay URL: ${url}`);
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 204) return { status: res.status, body: null };
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body — ignore
      }
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export interface PublishInviteEnvelopeOpts {
  rawToken: string;
  email: string;
  cloudUrl: string;
  teamId: string;
  teamName: string;
  expiresAt: string;
}

/**
 * Publish an invite envelope. Fire-and-forget by design: errors are
 * swallowed so a relay outage never blocks invite issuance. The cloud
 * `__lattice_invitations` row is still authoritative — the relay just
 * shortcuts URL discovery for the happy path.
 */
export async function publishInviteEnvelope(opts: PublishInviteEnvelopeOpts): Promise<void> {
  if (process.env.LATTICE_INVITE_PUBLISH === 'off') return;
  const base = relayBase();
  warnIfNonDefault(base);
  const url = `${base}${PUBLISH_PATH}`;
  try {
    assertSafeUrl(url);
  } catch {
    return;
  }

  const tokenHash = sha256Hex(opts.rawToken);
  const { ciphertextHex, ivHex } = aesGcmEncrypt(opts.cloudUrl, opts.rawToken);
  const emailHash = sha256Hex(opts.email.toLowerCase());

  try {
    await fetchJson(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token_hash: tokenHash,
          ciphertext: ciphertextHex,
          iv: ivHex,
          email_hash: emailHash,
          team_id: opts.teamId,
          team_name: opts.teamName,
          expires_at: opts.expiresAt,
        }),
      },
      PUBLISH_TIMEOUT_MS,
    );
  } catch {
    // Network / timeout / DNS — never block the inviter. The cloud
    // row is already committed; the user just falls back to the
    // Advanced URL-paste flow if the relay is unreachable.
  }
}

export interface ResolveInviteResult {
  cloud_url: string;
  team_id: string;
  team_name: string;
}

export class InviteRelayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`InviteRelayError ${String(status)}: ${code}`);
    this.name = 'InviteRelayError';
  }
}

/**
 * Resolve an invite to its cloud URL by posting {token, email} to the
 * relay. Unlike publish, redeem failures are visible — the user sees
 * a clear error if the token is unknown, the email doesn't match, the
 * invite expired, or the token is locked out from too many bad attempts.
 */
export async function resolveInviteEnvelope(
  token: string,
  email: string,
): Promise<ResolveInviteResult> {
  const base = relayBase();
  warnIfNonDefault(base);
  const url = `${base}${REDEEM_PATH}`;
  assertSafeUrl(url);

  const { status, body } = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email }),
    },
    REDEEM_TIMEOUT_MS,
  );

  if (
    status >= 200 &&
    status < 300 &&
    body !== null &&
    typeof body === 'object' &&
    'cloud_url' in body
  ) {
    return body as ResolveInviteResult;
  }
  const code =
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : 'unknown_error';
  throw new InviteRelayError(status, code);
}
