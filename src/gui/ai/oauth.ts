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
    redirectUri: env.ANTHROPIC_OAUTH_REDIRECT_URI ?? '',
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

/** Exchange an authorization code for tokens (form-encoded, per OAuth spec). */
export async function exchangeCodeForTokens(
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `token exchange failed (${String(res.status)}): ${(await res.text().catch(() => '')).slice(0, 300)}`,
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
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `token refresh failed (${String(res.status)}): ${(await res.text().catch(() => '')).slice(0, 300)}`,
    );
  }
  const tokens = parseTokenResponse(await res.json());
  tokens.refresh_token ??= refreshToken; // providers often omit it on refresh
  return tokens;
}
