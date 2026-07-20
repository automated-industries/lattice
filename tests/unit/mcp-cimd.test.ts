import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LatticeOAuthProvider,
  mcpClientMetadataUrl,
  DEFAULT_CLIENT_METADATA_URL,
} from '../../src/connectors/mcp/oauth.js';

/**
 * Client-ID metadata document (CIMD) support — the fix for authorization
 * servers that have NO dynamic-client-registration endpoint (the real-world
 * shape: `client_id_metadata_document_supported: true`, no
 * `registration_endpoint`). The SDK takes the CIMD branch only when the
 * provider exposes `clientMetadataUrl`; without it, such servers dead-end with
 * "Incompatible auth server: does not support dynamic client registration".
 * Run against the REAL SDK `auth()` with a fake fetch serving the metadata, so
 * the branch selection is the SDK's own, not a reimplementation.
 */

let tmp: string;
let prevCfg: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lattice-cimd-test-'));
  prevCfg = process.env.LATTICE_CONFIG_DIR;
  process.env.LATTICE_CONFIG_DIR = tmp;
  process.env.LATTICE_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  if (prevCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prevCfg;
  rmSync(tmp, { recursive: true, force: true });
});

const sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js').then(
  (m) => (m as { auth: SdkAuthFn }).auth,
  () => null,
);
type SdkAuthFn = (
  provider: unknown,
  options: { serverUrl: string; fetchFn?: typeof fetch },
) => Promise<string>;

const AS = 'https://as.example';

/** Authorization-server metadata in the no-DCR shape; CIMD flag per test. */
function asMetadata(cimdSupported: boolean): Record<string, unknown> {
  return {
    issuer: AS,
    authorization_endpoint: `${AS}/oauth/authorize`,
    token_endpoint: `${AS}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    ...(cimdSupported ? { client_id_metadata_document_supported: true } : {}),
  };
}

function fakeFetchFor(cimdSupported: boolean): typeof fetch {
  return ((input: string | URL) => {
    const u = typeof input === 'string' ? input : input.toString();
    if (u.includes('/.well-known/oauth-authorization-server')) {
      return Promise.resolve(
        new Response(JSON.stringify(asMetadata(cimdSupported)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    // Protected-resource metadata + OIDC discovery: not served — the SDK falls
    // back to treating the server URL as its own authorization server.
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

describe.skipIf(!sdkAuth)('CIMD: URL-based client id against the real SDK auth()', () => {
  it('uses the hosted metadata-document URL as the client_id when the AS supports CIMD', async () => {
    const provider = new LatticeOAuthProvider(
      `cimd-${Date.now()}`,
      'http://127.0.0.1/api/connectors/oauth/callback',
      { state: 'st-1' },
    );
    const result = await sdkAuth!(provider, { serverUrl: AS, fetchFn: fakeFetchFor(true) });
    expect(result).toBe('REDIRECT');
    const authz = provider.capturedAuthorizationUrl;
    expect(authz).toBeTruthy();
    expect(authz?.origin + authz!.pathname).toBe(`${AS}/oauth/authorize`);
    // THE fix: the client_id is the hosted client-ID metadata document URL.
    expect(authz?.searchParams.get('client_id')).toBe(mcpClientMetadataUrl());
    // Still a PKCE public client.
    expect(authz?.searchParams.get('code_challenge')).toBeTruthy();
    expect(authz?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authz?.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1/api/connectors/oauth/callback',
    );
  });

  it('still dead-ends loudly when the AS supports neither CIMD nor DCR', async () => {
    const provider = new LatticeOAuthProvider(
      `nodcr-${Date.now()}`,
      'http://127.0.0.1/api/connectors/oauth/callback',
    );
    await expect(
      sdkAuth!(provider, { serverUrl: AS, fetchFn: fakeFetchFor(false) }),
    ).rejects.toThrow(/does not support dynamic client registration/i);
  });

  it('skips registration entirely when a pre-registered client is stored (manual path)', async () => {
    const provider = new LatticeOAuthProvider(
      `manual-${Date.now()}`,
      'http://127.0.0.1/api/connectors/oauth/callback',
    );
    provider.saveClientInformation({ client_id: 'preregistered-id' });
    // No CIMD, no DCR — but the stored client short-circuits both.
    const result = await sdkAuth!(provider, { serverUrl: AS, fetchFn: fakeFetchFor(false) });
    expect(result).toBe('REDIRECT');
    expect(provider.capturedAuthorizationUrl?.searchParams.get('client_id')).toBe(
      'preregistered-id',
    );
  });
});

describe('mcpClientMetadataUrl()', () => {
  it('defaults to the hosted document', () => {
    const prev = process.env.LATTICE_MCP_CLIENT_METADATA_URL;
    delete process.env.LATTICE_MCP_CLIENT_METADATA_URL;
    try {
      expect(mcpClientMetadataUrl()).toBe(DEFAULT_CLIENT_METADATA_URL);
    } finally {
      if (prev !== undefined) process.env.LATTICE_MCP_CLIENT_METADATA_URL = prev;
    }
  });

  it('honors the env override and treats empty as disabled', () => {
    const prev = process.env.LATTICE_MCP_CLIENT_METADATA_URL;
    try {
      process.env.LATTICE_MCP_CLIENT_METADATA_URL = 'https://self.hosted/meta.json';
      expect(mcpClientMetadataUrl()).toBe('https://self.hosted/meta.json');
      process.env.LATTICE_MCP_CLIENT_METADATA_URL = '';
      expect(mcpClientMetadataUrl()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.LATTICE_MCP_CLIENT_METADATA_URL;
      else process.env.LATTICE_MCP_CLIENT_METADATA_URL = prev;
    }
  });
});
