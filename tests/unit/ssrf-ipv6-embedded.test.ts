import { describe, it, expect } from 'vitest';
import { isPrivateIp } from '../../src/sources/url-safety.js';

/**
 * Regression (S3): the private-IP guard must reject IPv6 addresses that EMBED a private/metadata
 * IPv4 in ANY form. The old `isPrivateIpv6` only matched the DOTTED-decimal v4-mapped form
 * (`::ffff:127.0.0.1`), but WHATWG `new URL()` normalizes an IPv4-mapped literal to the HEX form
 * (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), which fell through as "public" — an SSRF bypass:
 * `http://[::ffff:a9fe:a9fe]/` reaches 169.254.169.254 (cloud IMDS). The OS routes any
 * v4-embedding IPv6 to the embedded v4 at the socket layer, so the check must too.
 */
describe('isPrivateIp — IPv6 with embedded IPv4 (SSRF bypass class)', () => {
  const privateV6 = [
    '::1', // loopback
    '::', // unspecified
    '::ffff:127.0.0.1', // v4-mapped, dotted (the one form the old guard caught)
    '::ffff:7f00:1', // v4-mapped, HEX = 127.0.0.1 — the bypass
    '::ffff:a9fe:a9fe', // v4-mapped, HEX = 169.254.169.254 (IMDS) — the bypass
    '::ffff:169.254.169.254', // v4-mapped, dotted IMDS
    '::ffff:0a00:0001', // v4-mapped, HEX = 10.0.0.1 (private)
    '::ffff:c0a8:0101', // v4-mapped, HEX = 192.168.1.1 (private)
    '::7f00:1', // v4-compatible (deprecated) = 127.0.0.1
    '::a9fe:a9fe', // v4-compatible = 169.254.169.254
    '64:ff9b::a9fe:a9fe', // NAT64 well-known = 169.254.169.254
    '64:ff9b::7f00:1', // NAT64 well-known = 127.0.0.1
    '64:ff9b:1::a9fe:a9fe', // NAT64 local-use = 169.254.169.254
    'fd00::1', // ULA fc00::/7
    'fc00::1234', // ULA
    'fe80::1', // link-local fe80::/10
    'feb0::1', // link-local (top of fe80::/10)
  ];
  for (const ip of privateV6) {
    it(`rejects ${ip} as private`, () => {
      expect(isPrivateIp(ip)).toBe(true);
    });
  }

  const publicV6 = [
    '2606:4700:4700::1111', // Cloudflare DNS — genuinely public
    '2001:4860:4860::8888', // Google DNS — genuinely public
    '::ffff:8.8.8.8', // v4-mapped PUBLIC v4 → stays allowed
    '::ffff:0808:0808', // v4-mapped HEX = 8.8.8.8 (public) → allowed
    '64:ff9b::0808:0808', // NAT64 of a public v4 (8.8.8.8) → allowed
  ];
  for (const ip of publicV6) {
    it(`allows genuinely public ${ip}`, () => {
      expect(isPrivateIp(ip)).toBe(false);
    });
  }

  it('closes the NAT64 /48, 6to4, and Teredo embedding classes (round-2)', () => {
    // 64:ff9b:1::/48 local-use NAT64 — denied wholesale (the embedded v4 is in different bits
    // than the /96 form; a g6/g7 decode could mislabel a metadata address as public).
    expect(isPrivateIp('64:ff9b:1:a9fe:a9:fe00:808:808')).toBe(true);
    expect(isPrivateIp('64:ff9b:1::1')).toBe(true);
    // 6to4 (2002::/16) embeds the gateway v4 in bits 16-47 — a private gateway is rejected,
    // a public one allowed.
    expect(isPrivateIp('2002:0a00:0001::1')).toBe(true); // 10.0.0.1 gateway
    expect(isPrivateIp('2002:a9fe:a9fe::1')).toBe(true); // 169.254.169.254 gateway
    expect(isPrivateIp('2002:0808:0808::1')).toBe(false); // 8.8.8.8 gateway — public
    // Teredo (2001:0::/32) — denied wholesale (legacy, obfuscated embedding).
    expect(isPrivateIp('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true);
    // The well-known NAT64 /96 still decodes correctly (last 32 bits).
    expect(isPrivateIp('64:ff9b::a9fe:a9fe')).toBe(true); // IMDS
    expect(isPrivateIp('64:ff9b::0808:0808')).toBe(false); // 8.8.8.8 — public
  });

  it('leaves non-IP strings to the upstream DNS resolver (not judged here)', () => {
    // isPrivateIp only classifies actual IP literals; a hostname (or a malformed IP that fails
    // isIP) returns false here because assertSafeUrl resolves it via DNS and re-checks the
    // resolved address. This documents that contract — the v6 parser's null→private fail-closed
    // is defense-in-depth for the (unreachable-via-isIP) case of a valid-per-isIP but odd form.
    expect(isPrivateIp('::ffff:99999:1')).toBe(false); // fails isIP → not an IP literal
    expect(isPrivateIp('example.com')).toBe(false); // a hostname, resolved+rechecked upstream
  });

  it('still classifies IPv4 correctly (unchanged)', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    // 192.0.0.0/24 is reserved (private) but the rest of 192.0.0.0/16 is PUBLIC — the guard
    // must not over-block WordPress.com / Gravatar (192.0.66/73/78.x).
    expect(isPrivateIp('192.0.0.1')).toBe(true); // 192.0.0.0/24 reserved
    expect(isPrivateIp('192.0.78.9')).toBe(false); // WordPress.com — public
    expect(isPrivateIp('192.0.73.2')).toBe(false); // Gravatar — public
  });
});
