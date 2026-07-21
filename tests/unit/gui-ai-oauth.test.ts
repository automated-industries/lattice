import { describe, it, expect, afterEach } from 'vitest';
import {
  generatePkceVerifier,
  pkceChallengeFor,
  generateState,
  buildAuthorizeUrl,
  parseTokenResponse,
  readOAuthConfig,
  oauthConfigured,
  exchangeCodeForTokens,
  refreshAccessToken,
  isManualPasteRedirect,
  OAuthExchangeError,
  type OAuthConfig,
} from '../../src/gui/ai/oauth.js';
import { isLoopbackHost } from '../../src/gui/assistant-routes.js';

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

  it('isLoopbackHost trusts only loopback hosts (redirect-URI host-injection guard)', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:4317')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('localhost:8080')).toBe(true);
    expect(isLoopbackHost('[::1]:4317')).toBe(true);
    expect(isLoopbackHost('127.5.5.5')).toBe(true);
    // Attacker-controlled / non-loopback hosts must NOT be trusted.
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost('evil.com:4317')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
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
    const t = parseTokenResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 100, scope: 'x' },
      1000,
    );
    expect(t.access_token).toBe('at');
    expect(t.refresh_token).toBe('rt');
    expect(t.expires_at).toBe(1000 + 100 * 1000);
    expect(t.scope).toBe('x');
  });

  it('throws when the token response has no access_token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'rt' })).toThrow(/access_token/);
  });

  it('readOAuthConfig returns built-in defaults (manual code-paste flow) when env is unset (3.3)', () => {
    // 3.3: the public subscription-OAuth client is built in, so connect works out
    // of the box. The client only allows ITS registered redirect, so the default
    // is the manual code-paste flow (console code callback), not a loopback.
    const cfg = readOAuthConfig({});
    expect(cfg.authorizeUrl).toMatch(/^https:\/\//);
    expect(cfg.tokenUrl).toMatch(/^https:\/\//);
    expect(cfg.clientId).toBeTruthy();
    expect(cfg.scopes.length).toBeGreaterThan(0);
    expect(cfg.redirectUri).toMatch(/\/oauth\/code\/callback$/);
    expect(isManualPasteRedirect(cfg.redirectUri)).toBe(true);
    expect(oauthConfigured({})).toBe(true);
  });

  it('the manual-flow authorize URL carries code=true; a custom loopback redirect does not', () => {
    const manual = new URL(buildAuthorizeUrl(readOAuthConfig({}), 'st', 'ch'));
    expect(manual.searchParams.get('code')).toBe('true');
    const loopback = new URL(
      buildAuthorizeUrl(
        { ...cfg, redirectUri: 'http://127.0.0.1:4317/api/assistant/oauth/callback' },
        'st',
        'ch',
      ),
    );
    expect(loopback.searchParams.get('code')).toBeNull();
    expect(isManualPasteRedirect('http://127.0.0.1:4317/api/assistant/oauth/callback')).toBe(false);
  });

  it('env values override every default', () => {
    const env = {
      ANTHROPIC_OAUTH_AUTHORIZE_URL: 'https://a/au',
      ANTHROPIC_OAUTH_TOKEN_URL: 'https://a/tok',
      ANTHROPIC_OAUTH_CLIENT_ID: 'cid',
      ANTHROPIC_OAUTH_REDIRECT_URI: 'http://localhost/cb',
      ANTHROPIC_OAUTH_SCOPES: 'one two',
    } as NodeJS.ProcessEnv;
    const parsed = readOAuthConfig(env);
    expect(parsed.authorizeUrl).toBe('https://a/au');
    expect(parsed.clientId).toBe('cid');
    expect(parsed.redirectUri).toBe('http://localhost/cb');
    expect(parsed.scopes).toEqual(['one', 'two']);
    expect(oauthConfigured(env)).toBe(true);
  });
});

describe('oauth token endpoints (fetch-backed)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(
    status: number,
    body: unknown,
  ): { calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      );
    }) as unknown as typeof fetch;
    return { calls };
  }

  it('exchangeCodeForTokens posts the auth-code grant and returns parsed tokens', async () => {
    const { calls } = mockFetch(200, { access_token: 'at', refresh_token: 'rt', expires_in: 60 });
    const tokens = await exchangeCodeForTokens(cfg, 'the-code', 'the-verifier');
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    expect(calls[0]?.url).toBe(cfg.tokenUrl);
    const sent = String(calls[0]?.init.body);
    expect(sent).toContain('grant_type=authorization_code');
    expect(sent).toContain('code=the-code');
    expect(sent).toContain('code_verifier=the-verifier');
  });

  it('exchangeCodeForTokens throws (with status) on a non-OK response', async () => {
    mockFetch(400, 'bad request');
    await expect(exchangeCodeForTokens(cfg, 'c', 'v')).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
  });

  it('refreshAccessToken carries the old refresh token when the response omits it', async () => {
    mockFetch(200, { access_token: 'at2' }); // no refresh_token in the response
    const tokens = await refreshAccessToken(cfg, 'old-refresh');
    expect(tokens.access_token).toBe('at2');
    expect(tokens.refresh_token).toBe('old-refresh');
  });

  it('refreshAccessToken throws (with status) on a non-OK response', async () => {
    mockFetch(401, 'expired');
    await expect(refreshAccessToken(cfg, 'rt')).rejects.toThrow(/token refresh failed \(401\)/);
  });

  // A rejected fetch (network layer) — the shape Node/Deno throw for a TLS or
  // connection failure. The bare "fetch failed" string is useless to the user;
  // exchangeCodeForTokens must classify it.
  function mockFetchReject(err: Error): void {
    globalThis.fetch = (() => Promise.reject(err)) as unknown as typeof fetch;
  }

  it('exchangeCodeForTokens classifies a TLS/certificate failure with an actionable proxy hint', async () => {
    // Node throws TypeError('fetch failed') with the real cause nested; a
    // TLS-inspecting proxy surfaces as an untrusted-issuer cert error.
    mockFetchReject(
      Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unable to verify the first certificate'),
      }),
    );
    const err = await exchangeCodeForTokens(cfg, 'c', 'v').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthExchangeError);
    expect((err as OAuthExchangeError).kind).toBe('tls');
    expect((err as Error).message).toMatch(/proxy|certificate|root CA/i);
    expect((err as Error).message).not.toBe('fetch failed');
  });

  it('exchangeCodeForTokens classifies a Deno-style untrusted-cert failure as TLS', async () => {
    mockFetchReject(new TypeError('error sending request: invalid peer certificate: UnknownIssuer'));
    const err = await exchangeCodeForTokens(cfg, 'c', 'v').catch((e: unknown) => e);
    expect((err as OAuthExchangeError).kind).toBe('tls');
    expect((err as Error).message).toMatch(/proxy|certificate/i);
  });

  it('exchangeCodeForTokens classifies a non-TLS connection failure as network', async () => {
    mockFetchReject(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );
    const err = await exchangeCodeForTokens(cfg, 'c', 'v').catch((e: unknown) => e);
    expect((err as OAuthExchangeError).kind).toBe('network');
    expect((err as Error).message).toMatch(/reach|network|connection/i);
    expect((err as Error).message).not.toMatch(/certificate|proxy/i);
  });

  it('exchangeCodeForTokens flags an already-used/expired code (400 invalid_grant)', async () => {
    mockFetch(400, { error: 'invalid_grant', error_description: 'authorization code expired' });
    const err = await exchangeCodeForTokens(cfg, 'c', 'v').catch((e: unknown) => e);
    expect((err as OAuthExchangeError).kind).toBe('invalid_grant');
    expect((err as Error).message).toMatch(/again|fresh|expired|used/i);
  });

  it('a generic non-OK response is still reported with its status (unchanged contract)', async () => {
    mockFetch(400, 'bad request');
    const err = await exchangeCodeForTokens(cfg, 'c', 'v').catch((e: unknown) => e);
    expect((err as OAuthExchangeError).kind).toBe('http');
    expect((err as Error).message).toMatch(/token exchange failed \(400\)/);
  });
});
