import { describe, it, expect } from 'vitest';
import { beginOAuth } from '../../src/connectors/mcp/direct-transport.js';

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
