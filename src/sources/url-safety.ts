import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RefProvider } from './types.js';

/**
 * SSRF guard for user-supplied URLs. Rejects non-http(s) schemes and, unless
 * explicitly allowed, any host that resolves to a private / loopback /
 * link-local / cloud-metadata address. Used at reference-record time and again
 * before any fetch.
 */
export async function assertSafeUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Lattice: invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Lattice: refusing non-http(s) URL scheme "${u.protocol}"`);
  }
  if (allowPrivate) return u;

  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`Lattice: refusing to fetch private host "${host}"`);
  }

  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addresses) {
    if (isPrivateIp(ip)) {
      throw new Error(`Lattice: refusing to fetch private address ${ip} (host "${host}")`);
    }
  }
  return u;
}

/** Coarse provider tag for a URL. */
export function providerForUrl(rawUrl: string): RefProvider {
  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return 'web';
  }
  if (
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host.endsWith('.googleusercontent.com')
  ) {
    return 'gdrive';
  }
  return 'web';
}

/** True for loopback / private / link-local / ULA / cloud-metadata addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  const head = lower.split(':')[0] ?? '';
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 ULA
  if (
    head.startsWith('fe8') ||
    head.startsWith('fe9') ||
    head.startsWith('fea') ||
    head.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  return false;
}
