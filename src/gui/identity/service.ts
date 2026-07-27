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
 *   session   DELETE (Bearer) → revoke this device session and every credential
 *                               minted from it
 */

import { ACCOUNT_HOME_ORIGIN } from '../site-origin.js';
import type { IdentityStep } from '../ai/error-humanize.js';

/**
 * A failure from the identity service, tagged with WHICH leg of the handshake it
 * came from and the endpoint that was called. Discovery, start, and exchange used to
 * throw the same opaque `identity service error (<code>)` string, so neither the
 * person reading it nor the person triaging the report could tell them apart.
 *
 * `message` stays short and free of status codes and of the remote body — the routes
 * humanize it for display. The diagnosable parts (endpoint, status, remote detail)
 * live on the instance and are written to the server log where the failure is raised.
 */
export class IdentityServiceError extends Error {
  readonly step: IdentityStep;
  readonly endpoint: string;
  readonly status: number | null;
  readonly detail: string;
  constructor(step: IdentityStep, endpoint: string, status: number | null, detail: string) {
    super(`identity service failed at step: ${step}`);
    this.name = 'IdentityServiceError';
    this.step = step;
    this.endpoint = endpoint;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Build a tagged failure, logging the resolved endpoint + status + remote detail
 * server-side first. Nothing logged here is shown to a user; the log is what makes
 * "sign-in failed" answerable without source-tracing.
 */
function identityFailure(
  step: IdentityStep,
  endpoint: string,
  status: number | null,
  detail: string,
): IdentityServiceError {
  const code = status === null ? 'no response' : String(status);
  console.warn(
    `[lattice] identity step "${step}" failed: ${endpoint} -> ${code}${detail ? ` ${detail}` : ''}`,
  );
  return new IdentityServiceError(step, endpoint, status, detail);
}

export interface IdentityEndpoints {
  base: string;
  start: string;
  exchange: string;
  workspaces: string;
  account: string;
  /** Mint a scoped model credential (proxy token + base URL) for the signed-in
   *  account — powers the "Lattice Cloud account" model option. */
  modelCredential: string;
  /** Revoke THIS device session. The service must invalidate every credential
   *  minted from it — signing a device out has to cut its spending immediately,
   *  not whenever the last minted token happens to expire. */
  session: string;
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
    session: `${b}/api/me/session`,
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

/** Call the service, converting BOTH a transport failure and a non-2xx answer into a
 *  step-tagged {@link IdentityServiceError}. */
async function postJson<T>(
  step: IdentityStep,
  url: string,
  body: unknown,
  bearer?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw identityFailure(step, url, null, (e as Error).message);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw identityFailure(step, url, res.status, typeof data.error === 'string' ? data.error : '');
  }
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
  }>('start', endpoints.start, { label, ...(redirectPort ? { redirectPort } : {}) });
  if (!out.requestId || !out.requestSecret || !out.verifyUrl) {
    throw identityFailure('start', endpoints.start, null, 'incomplete sign-in request');
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
    'exchange',
    endpoints.exchange,
    { requestId, requestSecret, code },
  );
  if (!out.token || !out.email) {
    throw identityFailure('exchange', endpoints.exchange, null, 'no session in response');
  }
  return { token: out.token, email: out.email, name: out.name ?? null };
}

export async function fetchRemoteWorkspaces(
  endpoints: IdentityEndpoints,
  bearer: string,
): Promise<RemoteWorkspace[]> {
  let res: Response;
  try {
    res = await fetch(endpoints.workspaces, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw identityFailure('workspaces', endpoints.workspaces, null, (e as Error).message);
  }
  if (res.status === 401) throw new IdentityAuthError('identity session expired or revoked');
  const data = (await res.json().catch(() => ({}))) as {
    workspaces?: RemoteWorkspace[];
    error?: string;
  };
  if (!res.ok) {
    throw identityFailure(
      'workspaces',
      endpoints.workspaces,
      res.status,
      typeof data.error === 'string' ? data.error : '',
    );
  }
  return Array.isArray(data.workspaces) ? data.workspaces : [];
}

export async function fetchWorkspaceCredential(
  endpoints: IdentityEndpoints,
  bearer: string,
  workspaceId: string,
): Promise<IssuedCredential> {
  const url = `${endpoints.workspaces}/${encodeURIComponent(workspaceId)}/credential`;
  const out = await postJson<{ connUrl?: string; role?: string; workspaceName?: string }>(
    'credential',
    url,
    {},
    bearer,
  );
  if (!out.connUrl) throw identityFailure('credential', url, null, 'no credential in response');
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
    'model-credential',
    endpoints.modelCredential,
    {},
    bearer,
  );
  if (!out.token || !out.proxyBaseUrl || !out.expiresAt) {
    throw identityFailure(
      'model-credential',
      endpoints.modelCredential,
      null,
      'no model credential in response',
    );
  }
  // The minted token IS a spendable credential — it's sent to proxyBaseUrl as the
  // API key. Require the same HTTPS-or-loopback trust the identity base gets, so a
  // misconfigured/tampered service can't downgrade the money-token to cleartext.
  if (!isTrustedBase(out.proxyBaseUrl)) {
    throw new Error('identity service issued a non-HTTPS model proxy URL');
  }
  return { token: out.token, proxyBaseUrl: out.proxyBaseUrl, expiresAt: out.expiresAt };
}

/**
 * Revoke this device session at the service. Signing a device out must cut that
 * device's model access AT ONCE: the minted proxy token is spendable money, and
 * deleting the local copy does nothing about a copy that already left the machine
 * (a backup, a synced config directory, a shoulder-surfed log). The service is the
 * only party that can make the token itself stop working, so sign-out asks it to.
 *
 * ONLY a 2xx counts as revoked. Anything else — including a 404 from a service
 * that has not implemented this yet — leaves a live credential behind, and the
 * caller reports that rather than claiming a revocation that did not happen.
 */
export async function revokeDeviceSession(
  endpoints: IdentityEndpoints,
  bearer: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(endpoints.session, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw identityFailure('model-credential', endpoints.session, null, (e as Error).message);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw identityFailure(
      'model-credential',
      endpoints.session,
      res.status,
      typeof data.error === 'string' ? data.error : '',
    );
  }
}

/** A 401 from the service — the stored session is dead; the caller signs out locally. */
export class IdentityAuthError extends Error {}
