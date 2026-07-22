import { createHash, randomBytes } from 'node:crypto';

/**
 * Standard OAuth 2.0 Authorization-Code + PKCE helpers for connecting a Claude
 * subscription (as an alternative to a pasted API token). Lattice is an OSS tool
 * the user runs against their OWN Claude account — the same model as the Claude
 * Code CLI — so it uses the public PKCE client below by default. Every value is
 * overridable via `ANTHROPIC_OAUTH_*` env vars (so a future endpoint/client
 * change needs no republish), and the redirect URI is derived per-request from
 * the GUI's own origin (loopback), not baked in.
 *
 * The PKCE primitives + state round-trip + token parsing are provider-agnostic
 * and fully unit-tested.
 */

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Empty when it should be derived per-request from the GUI origin (loopback). */
  redirectUri: string;
  scopes: string[];
}

/**
 * Built-in defaults for connecting a Claude subscription — the public OAuth
 * client used by the Claude CLI ecosystem. Public PKCE client (no secret), so
 * shipping it in OSS is fine. Override any field with the matching
 * `ANTHROPIC_OAUTH_*` env var if these ever change.
 */
const DEFAULT_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const DEFAULT_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference'];
/**
 * The public client only allows ITS registered redirect — an arbitrary loopback
 * callback is rejected ("redirect URI … not supported by client"). So the
 * default is the manual code-paste flow: the user authorizes, the page shows a
 * code, and they paste it back into the GUI. Override via ANTHROPIC_OAUTH_REDIRECT_URI
 * (with a client that allowlists a loopback callback) to use the auto-callback.
 */
const DEFAULT_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

/** True for the manual code-paste flow (the registered console redirect). */
export function isManualPasteRedirect(redirectUri: string): boolean {
  return redirectUri.endsWith('/oauth/code/callback');
}

/**
 * Resolve the OAuth config: env overrides win, otherwise the built-in public
 * client defaults. Never null now (the defaults are always present); the
 * `redirectUri` is left empty when not set via env, to be filled per-request
 * from the GUI's own origin (see the assistant route).
 */
export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const scopes = env.ANTHROPIC_OAUTH_SCOPES
    ? env.ANTHROPIC_OAUTH_SCOPES.split(/\s+/).filter(Boolean)
    : DEFAULT_SCOPES.slice();
  // `||` (not `??`) on purpose: an EMPTY env override should fall back to the
  // default, not pin an empty endpoint/client.
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    authorizeUrl: env.ANTHROPIC_OAUTH_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    tokenUrl: env.ANTHROPIC_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    clientId: env.ANTHROPIC_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    redirectUri: env.ANTHROPIC_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    scopes,
  };
}

/**
 * Whether the subscription-OAuth connect affordance should be offered. Always
 * true now that the client defaults are built in — kept as a function so the GUI
 * + tests have a stable name and an operator could gate it off in the future.
 */
export function oauthConfigured(_env: NodeJS.ProcessEnv = process.env): boolean {
  void _env;
  return true;
}

/** PKCE code verifier — 48 random bytes, base64url (RFC 7636). */
export function generatePkceVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** PKCE code challenge — base64url(SHA-256(verifier)), method S256. */
export function pkceChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** CSRF state token — 24 random bytes, base64url. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/** Build the provider authorize URL for the PKCE flow. */
export function buildAuthorizeUrl(cfg: OAuthConfig, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  if (cfg.scopes.length) params.set('scope', cfg.scopes.join(' '));
  // Manual code-paste flow (the registered console redirect): ask the authorize
  // page to DISPLAY the code for the user to copy, rather than auto-redirect.
  if (isManualPasteRedirect(cfg.redirectUri)) params.set('code', 'true');
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  /** Absolute expiry (epoch ms), derived from expires_in at exchange time. */
  expires_at?: number;
  scope?: string;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Normalize a provider token response into {@link OAuthTokens}. */
export function parseTokenResponse(raw: unknown, now = Date.now()): OAuthTokens {
  const r = (raw ?? {}) as RawTokenResponse;
  if (typeof r.access_token !== 'string' || !r.access_token) {
    throw new Error('token response missing access_token');
  }
  const tokens: OAuthTokens = { access_token: r.access_token };
  if (typeof r.refresh_token === 'string') tokens.refresh_token = r.refresh_token;
  if (typeof r.scope === 'string') tokens.scope = r.scope;
  if (typeof r.expires_in === 'number') tokens.expires_at = now + r.expires_in * 1000;
  return tokens;
}

/** Why a token-endpoint call failed — lets the caller show an actionable message. */
export type OAuthFailureKind = 'tls' | 'network' | 'invalid_grant' | 'http';

/**
 * A token-endpoint failure carrying a coarse `kind`, so the GUI can tailor its
 * message. A bare `fetch failed` is useless to a user behind a corporate
 * TLS-inspecting proxy — the `kind` lets the connect screen say what actually
 * went wrong (untrusted cert vs. network down vs. a stale/used code).
 */
export class OAuthExchangeError extends Error {
  readonly kind: OAuthFailureKind;
  readonly status?: number;
  constructor(kind: OAuthFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'OAuthExchangeError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

// TLS-trust failures read differently across runtimes: Node nests the real cause
// with an OpenSSL-style `code`; Deno throws an "invalid peer certificate" string.
// Match either — the actionable hint (an untrusted proxy/root CA) is the same.
const TLS_TEXT =
  /certificate|self.?signed|unable to (?:verify|get (?:local )?issuer)|invalid peer certificate|unknownissuer|sec_error|\bssl\b|err_cert|\btls\b/i;
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Flatten an error + its `cause` chain into searchable text + collected `code`s. */
function errorChain(err: unknown): { text: string; codes: string[] } {
  const parts: string[] = [];
  const codes: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    if (cur.message) parts.push(cur.message);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return { text: parts.join(' | '), codes };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Classify a thrown fetch (network-layer) error into an actionable
 * {@link OAuthExchangeError}. A TLS/cert failure is the common blocker on
 * managed devices behind an HTTPS-inspecting proxy.
 */
export function classifyFetchFailure(err: unknown, tokenUrl: string): OAuthExchangeError {
  const host = hostOf(tokenUrl);
  const { text, codes } = errorChain(err);
  if (TLS_TEXT.test(text) || codes.some((c) => TLS_CODES.has(c))) {
    return new OAuthExchangeError(
      'tls',
      `Couldn't establish a trusted secure connection to ${host}. The TLS certificate wasn't trusted — on a managed or corporate network you may be behind a TLS-inspecting proxy whose root certificate this app doesn't trust yet. Add your corporate root CA (Settings → Network) or contact IT, then try again.`,
    );
  }
  return new OAuthExchangeError(
    'network',
    `Couldn't reach ${host} (${text || 'network error'}). Check your connection and try again.`,
  );
}

/**
 * Exchange an authorization code for tokens (form-encoded, per OAuth spec).
 * `state` is included when present — the manual code-paste flow binds the code
 * to the state, and the provider expects it echoed back at exchange time.
 */
export async function exchangeCodeForTokens(
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
  state?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  if (state) body.set('state', state);
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw classifyFetchFailure(err, cfg.tokenUrl);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // Single-use codes are the #1 cause of a failed manual paste (the app
    // restarted, the code was already redeemed, or it aged out). Name it.
    if (res.status === 400 && /invalid_grant|expired|already/i.test(detail)) {
      throw new OAuthExchangeError(
        'invalid_grant',
        'That authorization code was already used or has expired — codes are single-use. Click "Connect with Claude" again to get a fresh code.',
        400,
      );
    }
    throw new OAuthExchangeError(
      'http',
      `token exchange failed (${String(res.status)}): ${detail}`,
      res.status,
    );
  }
  return parseTokenResponse(await res.json());
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  cfg: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw classifyFetchFailure(err, cfg.tokenUrl);
  }
  if (!res.ok) {
    throw new OAuthExchangeError(
      'http',
      `token refresh failed (${String(res.status)}): ${(await res.text().catch(() => '')).slice(0, 300)}`,
      res.status,
    );
  }
  const tokens = parseTokenResponse(await res.json());
  tokens.refresh_token ??= refreshToken; // providers often omit it on refresh
  return tokens;
}
