import { describe, it, expect } from 'vitest';
import {
  generatePkceVerifier,
  pkceChallengeFor,
  generateState,
  buildAuthorizeUrl,
  parseTokenResponse,
  readOAuthConfig,
  oauthConfigured,
  type OAuthConfig,
} from '../../src/gui/ai/oauth.js';

const cfg: OAuthConfig = {
  authorizeUrl: 'https://example.test/oauth/authorize',
  tokenUrl: 'https://example.test/oauth/token',
  clientId: 'client-123',
  redirectUri: 'http://localhost:9999/api/assistant/oauth/callback',
  scopes: ['a', 'b'],
};

describe('oauth helpers', () => {
  it('generates a base64url PKCE verifier + S256 challenge', () => {
    const v = generatePkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    const c1 = pkceChallengeFor(v);
    const c2 = pkceChallengeFor(v);
    expect(c1).toBe(c2); // deterministic
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkceChallengeFor('different')).not.toBe(c1);
  });

  it('generates distinct state tokens', () => {
    expect(generateState()).not.toBe(generateState());
  });

  it('builds an authorize URL with PKCE + state params', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-xyz', 'challenge-abc'));
    expect(url.origin + url.pathname).toBe('https://example.test/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('scope')).toBe('a b');
  });

  it('parses a token response and derives absolute expiry', () => {
    const t = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 100, scope: 'x' }, 1000);
    expect(t.access_token).toBe('at');
    expect(t.refresh_token).toBe('rt');
    expect(t.expires_at).toBe(1000 + 100 * 1000);
    expect(t.scope).toBe('x');
  });

  it('throws when the token response has no access_token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'rt' })).toThrow(/access_token/);
  });

  it('readOAuthConfig returns null until all env vars are set, then a config', () => {
    expect(readOAuthConfig({})).toBeNull();
    expect(oauthConfigured({})).toBe(false);
    const env = {
      ANTHROPIC_OAUTH_AUTHORIZE_URL: 'https://a/au',
      ANTHROPIC_OAUTH_TOKEN_URL: 'https://a/tok',
      ANTHROPIC_OAUTH_CLIENT_ID: 'cid',
      ANTHROPIC_OAUTH_REDIRECT_URI: 'http://localhost/cb',
      ANTHROPIC_OAUTH_SCOPES: 'one two',
    } as NodeJS.ProcessEnv;
    const parsed = readOAuthConfig(env);
    expect(parsed?.clientId).toBe('cid');
    expect(parsed?.scopes).toEqual(['one', 'two']);
    expect(oauthConfigured(env)).toBe(true);
  });
});
