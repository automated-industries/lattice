import { describe, it, expect } from 'vitest';
import { beginOAuth, makeGuardedFetch } from '../../src/connectors/mcp/direct-transport.js';

/**
 * The generic MCP connector fetches a USER-SUPPLIED server URL. Without a guard it
 * reached cloud metadata (169.254.169.254), loopback, and internal hosts — classic
 * SSRF, with tool responses ingested into mcp_items (read-back exfil). beginOAuth
 * now runs assertSafeUrl FIRST — before persisting the URL or loading the SDK — so
 * these reject with no side effects and no network (IP literals skip DNS).
 */
describe('MCP connector SSRF guard (generic serverUrl)', () => {
  const base = {
    connectionId: 'ssrf-test',
    redirectUri: 'http://127.0.0.1/cb',
    state: 's',
    transportKind: 'http' as const,
  };

  it('refuses the cloud-metadata / link-local address', async () => {
    await expect(
      beginOAuth({ ...base, serverUrl: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow(/private|refusing/i);
  });

  it('refuses loopback (local MCP servers use stdio, not HTTP-to-loopback)', async () => {
    await expect(beginOAuth({ ...base, serverUrl: 'http://127.0.0.1:8080/mcp' })).rejects.toThrow(
      /private|refusing/i,
    );
  });

  it('refuses an RFC-1918 private address', async () => {
    await expect(beginOAuth({ ...base, serverUrl: 'http://10.0.0.5/mcp' })).rejects.toThrow(
      /private|refusing/i,
    );
  });

  it('refuses a non-http(s) scheme (no file:// / gopher:// smuggling)', async () => {
    await expect(beginOAuth({ ...base, serverUrl: 'file:///etc/passwd' })).rejects.toThrow(
      /scheme|http/i,
    );
  });

  it('refuses the literal localhost hostname', async () => {
    await expect(beginOAuth({ ...base, serverUrl: 'http://localhost:9000/mcp' })).rejects.toThrow(
      /private|refusing/i,
    );
  });
});

/**
 * The up-front assertSafeUrl only guards the FIRST request. The SDK then follows
 * redirects and fetches OAuth-discovered endpoints; a malicious server can 302
 * (or advertise an OAuth endpoint) to a private/metadata address after passing
 * the initial check. The transports are now built with a guarded fetch that
 * re-validates EVERY hop, so those requests are refused too. Network-free: the
 * first hop is a public IP literal (skips DNS), the redirect target is the
 * metadata IP literal.
 */
describe('MCP connector SSRF guard (redirects + OAuth-discovered endpoints)', () => {
  const PUBLIC_IP = 'http://93.184.216.34/mcp'; // public IP literal → passes, no DNS

  it('re-validates a redirect hop and refuses a 302 to cloud metadata', async () => {
    const base302: typeof fetch = (async (url: string | URL) => {
      if (String(url).startsWith('http://93.184.216.34')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as unknown as typeof fetch;

    const guarded = makeGuardedFetch(base302);
    await expect(guarded(PUBLIC_IP)).rejects.toThrow(/private|refusing/i);
  });

  it('passes a non-redirect response from a public host straight through', async () => {
    const base200: typeof fetch = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof fetch;

    const guarded = makeGuardedFetch(base200);
    const res = await guarded(PUBLIC_IP);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
