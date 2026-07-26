/**
 * Client for a WORKSPACE IDENTITY SERVICE — the account system a managed
 * deployment exposes so the desktop app and terminal GUI can sign in with the
 * same account as the hosted web app, list the workspaces that account owns or
 * was invited to, and obtain each membership's scoped connection credential.
 *
 * Provider-generic on purpose: this module knows only "an identity service",
 * discovered from a `.well-known` manifest on the project's own public website
 * (the same pattern as the desktop update manifest) or pointed at directly via
 * env/config. No hosted deployment is named here.
 *
 * Endpoints (all JSON over HTTPS):
 *   start     POST { label, redirectPort? } → { requestId, requestSecret, verifyUrl }
 *   exchange  POST { requestId, requestSecret, code } → { token, email, name }
 *   workspaces GET  (Bearer) → { workspaces: [{ id, name, status, membershipId,
 *                                 role, membershipStatus }] }
 *   credential POST (Bearer) /:id → { connUrl, role, workspaceName }
 */

import { ACCOUNT_HOME_ORIGIN } from '../site-origin.js';

export interface IdentityEndpoints {
  base: string;
  start: string;
  exchange: string;
  workspaces: string;
  account: string;
  /** Mint a scoped model credential (proxy token + base URL) for the signed-in
   *  account — powers the "Lattice Cloud account" model option. */
  modelCredential: string;
}

export interface StartedSignIn {
  requestId: string;
  requestSecret: string;
  verifyUrl: string;
  expiresInSeconds?: number;
}

export interface ExchangedSignIn {
  token: string;
  email: string;
  name: string | null;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
  status: string;
  membershipId: string;
  role: string;
  membershipStatus: string;
}

export interface IssuedCredential {
  connUrl: string;
  role: string;
  workspaceName: string;
}

export interface IssuedModelCredential {
  /** The hosted metered-proxy base URL (Anthropic-compatible). */
  proxyBaseUrl: string;
  /** Short-lived model token; the caller re-mints on expiry. */
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

/** Manifest cache: refetched at most every 5 minutes (mirrors its cache-control). */
let cachedEndpoints: { at: number; endpoints: IdentityEndpoints } | null = null;
const MANIFEST_TTL_MS = 5 * 60 * 1000;

/**
 * True when `base` may carry the personal bearer + a scoped Postgres/model
 * credential. HTTPS is required — those secrets must never ride cleartext — EXCEPT
 * for a loopback base (an operator/dev/test pointing `LATTICE_IDENTITY_URL` at
 * `http://127.0.0.1:…`), which never leaves the machine.
 *
 * Validates the PARSED host, never the raw string: a raw-string/regex check is
 * fooled by URL userinfo — `http://127.0.0.1:80@evil.com` has host `evil.com` but
 * "starts with" a loopback literal — which would send the credential to an
 * arbitrary host. Any embedded credential (`user[:pass]@`) is rejected outright.
 */
function isTrustedBase(base: string): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  // "http://127.0.0.1@evil.com" parses to host evil.com — reject any userinfo so a
  // loopback-looking prefix can never smuggle the real host past the check.
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  const host = u.hostname.toLowerCase();
  const isLoopback =
    host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  return u.protocol === 'http:' && isLoopback;
}

function endpointsFromBase(base: string): IdentityEndpoints {
  const b = base.replace(/\/$/, '');
  return {
    base: b,
    start: `${b}/api/device/start`,
    exchange: `${b}/api/device/exchange`,
    workspaces: `${b}/api/me/workspaces`,
    account: `${b}/account`,
    modelCredential: `${b}/api/me/model-credential`,
  };
}

/** For tests + retries: forget the cached manifest. */
export function resetIdentityDiscovery(): void {
  cachedEndpoints = null;
}

/**
 * Resolve the identity service's endpoints, or null when none is reachable.
 * Order: `LATTICE_IDENTITY_URL` (a direct base URL — self-hosted or tests) →
 * the `.well-known` discovery manifest on the public website. A missing or
 * malformed manifest simply means "no identity service" — the app keeps
 * working with local identity and token-based joins.
 */
export async function discoverIdentityService(): Promise<IdentityEndpoints | null> {
  const direct = process.env.LATTICE_IDENTITY_URL;
  if (direct) return isTrustedBase(direct) ? endpointsFromBase(direct) : null;
  if (process.env.LATTICE_IDENTITY_DISCOVERY === 'off') return null;
  if (cachedEndpoints && Date.now() - cachedEndpoints.at < MANIFEST_TTL_MS) {
    return cachedEndpoints.endpoints;
  }
  const manifestUrl =
    process.env.LATTICE_IDENTITY_MANIFEST ??
    `${ACCOUNT_HOME_ORIGIN}/.well-known/lattice-services.json`;
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const doc = (await res.json()) as { identity?: { base?: string } };
    const base = doc.identity?.base;
    // Require an HTTPS (or loopback) base — the bearer + scoped credential get
    // sent here, so a tampered manifest must never downgrade them to cleartext.
    if (typeof base !== 'string' || !isTrustedBase(base)) return null;
    const endpoints = endpointsFromBase(base);
    cachedEndpoints = { at: Date.now(), endpoints };
    return endpoints;
  } catch {
    return null; // offline / no manifest — identity features simply stay hidden
  }
}

async function postJson<T>(url: string, body: unknown, bearer?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `identity service error (${String(res.status)})`);
  return data;
}

export async function startSignIn(
  endpoints: IdentityEndpoints,
  label: string,
  redirectPort: number | null,
): Promise<StartedSignIn> {
  const out = await postJson<{
    requestId?: string;
    requestSecret?: string;
    verifyUrl?: string;
    expiresInSeconds?: number;
  }>(endpoints.start, { label, ...(redirectPort ? { redirectPort } : {}) });
  if (!out.requestId || !out.requestSecret || !out.verifyUrl) {
    throw new Error('identity service returned an incomplete sign-in request');
  }
  return {
    requestId: out.requestId,
    requestSecret: out.requestSecret,
    verifyUrl: out.verifyUrl,
    ...(out.expiresInSeconds !== undefined ? { expiresInSeconds: out.expiresInSeconds } : {}),
  };
}

export async function exchangeSignIn(
  endpoints: IdentityEndpoints,
  requestId: string,
  requestSecret: string,
  code: string,
): Promise<ExchangedSignIn> {
  const out = await postJson<{ token?: string; email?: string; name?: string | null }>(
    endpoints.exchange,
    { requestId, requestSecret, code },
  );
  if (!out.token || !out.email) throw new Error('identity service returned no session');
  return { token: out.token, email: out.email, name: out.name ?? null };
}

export async function fetchRemoteWorkspaces(
  endpoints: IdentityEndpoints,
  bearer: string,
): Promise<RemoteWorkspace[]> {
  const res = await fetch(endpoints.workspaces, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new IdentityAuthError('identity session expired or revoked');
  const data = (await res.json().catch(() => ({}))) as {
    workspaces?: RemoteWorkspace[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `identity service error (${String(res.status)})`);
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

export async function fetchWorkspaceCredential(
  endpoints: IdentityEndpoints,
  bearer: string,
  workspaceId: string,
): Promise<IssuedCredential> {
  const out = await postJson<{ connUrl?: string; role?: string; workspaceName?: string }>(
    `${endpoints.workspaces}/${encodeURIComponent(workspaceId)}/credential`,
    {},
    bearer,
  );
  if (!out.connUrl) throw new Error('identity service issued no credential');
  return {
    connUrl: out.connUrl,
    role: out.role ?? 'member',
    workspaceName: out.workspaceName ?? 'Cloud workspace',
  };
}

/**
 * Mint a scoped MODEL credential for the signed-in account — the metered-proxy
 * base URL + a short-lived token the client uses as the Anthropic-wire key. The
 * token bills the account's Lattice Cloud balance; the client re-mints on expiry.
 */
export async function fetchModelCredential(
  endpoints: IdentityEndpoints,
  bearer: string,
): Promise<IssuedModelCredential> {
  const out = await postJson<{ token?: string; proxyBaseUrl?: string; expiresAt?: string }>(
    endpoints.modelCredential,
    {},
    bearer,
  );
  if (!out.token || !out.proxyBaseUrl || !out.expiresAt) {
    throw new Error('identity service issued no model credential');
  }
  // The minted token IS a spendable credential — it's sent to proxyBaseUrl as the
  // API key. Require the same HTTPS-or-loopback trust the identity base gets, so a
  // misconfigured/tampered service can't downgrade the money-token to cleartext.
  if (!isTrustedBase(out.proxyBaseUrl)) {
    throw new Error('identity service issued a non-HTTPS model proxy URL');
  }
  return { token: out.token, proxyBaseUrl: out.proxyBaseUrl, expiresAt: out.expiresAt };
}

/** A 401 from the service — the stored session is dead; the caller signs out locally. */
export class IdentityAuthError extends Error {}
