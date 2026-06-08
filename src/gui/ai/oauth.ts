import { createHash, randomBytes } from 'node:crypto';

/**
 * Standard OAuth 2.0 Authorization-Code + PKCE helpers for connecting a Claude
 * subscription (as an alternative to a pasted API token). The flow is generic
 * and config-driven: the authorize/token endpoints, client id, and redirect
 * URI come from environment variables, because the concrete Anthropic OAuth
 * values must be sourced from Anthropic's OAuth documentation — they are not
 * hardcoded here. Until those env vars are set, {@link oauthConfigured} is
 * false and the GUI surfaces "configure to enable" instead of a Connect button.
 *
 * The PKCE primitives + state round-trip + token parsing are provider-agnostic
 * and fully unit-tested.
 */

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

/** Read the OAuth config from env, or null when not fully configured. */
export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const authorizeUrl = env.ANTHROPIC_OAUTH_AUTHORIZE_URL;
  const tokenUrl = env.ANTHROPIC_OAUTH_TOKEN_URL;
  const clientId = env.ANTHROPIC_OAUTH_CLIENT_ID;
  const redirectUri = env.ANTHROPIC_OAUTH_REDIRECT_URI;
  if (!authorizeUrl || !tokenUrl || !clientId || !redirectUri) return null;
  const scopes = (env.ANTHROPIC_OAUTH_SCOPES ?? '').split(/\s+/).filter(Boolean);
  return { authorizeUrl, tokenUrl, clientId, redirectUri, scopes };
}

/** True when the OAuth subscription flow is fully configured via env. */
export function oauthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOAuthConfig(env) !== null;
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
