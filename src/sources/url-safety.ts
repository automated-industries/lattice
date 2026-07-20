import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RefProvider } from './types.js';

/** A hostname the user could have typed without a scheme: dot-separated alnum/hyphen labels with
 *  a ≥2-alpha TLD, plus an optional path/query/fragment. Requires the TLD so `e.g` never matches. */
const BARE_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#].*)?$/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize a web address the user WROTE into a full URL string, or null if it isn't one. A token
 * that already carries a scheme is returned canonicalized (if it parses); a bare domain the user
 * typed WITHOUT a scheme (e.g. `automatedindustries.ai`) has `https://` inferred. Deterministic —
 * so the URL detectors never re-prompt for a domain they already recognized. This does NOT
 * authorize a fetch: {@link assertSafeUrl} still enforces http(s)-only + the SSRF host checks, and
 * the policy/budget/concurrency guards still run downstream on the result.
 */
export function normalizeUserUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (HAS_SCHEME_RE.test(t)) {
    try {
      return new URL(t).toString();
    } catch {
      return null;
    }
  }
  if (!BARE_HOST_RE.test(t)) return null; // scheme-less, not host-shaped → not a URL
  try {
    return new URL('https://' + t).toString();
  } catch {
    return null;
  }
}

/**
 * SSRF guard for user-supplied URLs. Rejects non-http(s) schemes and, unless
 * explicitly allowed, any host that resolves to a private / loopback /
 * link-local / cloud-metadata address. Used at reference-record time and again
 * before any fetch.
 */
export async function assertSafeUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let u: URL;
  try {
    // Infer a scheme for a bare domain the user typed (e.g. "example.com" → "https://example.com")
    // so a valid host isn't wrongly rejected as "invalid URL". A non-http(s) scheme is still
    // rejected below, and the private-address checks still run on the inferred host.
    u = new URL(normalizeUserUrl(rawUrl) ?? rawUrl);
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

/**
 * Fetch a URL with SSRF protection that survives redirects. Each hop's target
 * (including the resolved `Location`) is re-validated with {@link assertSafeUrl}
 * before it is fetched, so an attacker cannot 302 from a public host to a
 * private/metadata address. Redirects are followed manually up to `maxRedirects`.
 *
 * Residual risk — DNS-rebinding TOCTOU: validation resolves the hostname, then
 * the runtime's fetch resolves it again to open the connection. A hostname whose
 * authoritative DNS returns a public IP to the first lookup and a private IP to
 * the second (very low TTL, attacker-controlled zone, for a host the user
 * explicitly referenced) could slip past. Closing this fully requires pinning
 * the validated IP at the socket layer (a custom dispatcher/agent), which is
 * deferred. Deployments that must guarantee it should pin DNS at the network
 * layer or run the fetch egress through an allow-list proxy.
 */
export async function safeFetch(
  rawUrl: string,
  fetchImpl: typeof fetch,
  opts: { allowPrivate?: boolean; maxRedirects?: number; init?: RequestInit } = {},
): Promise<Response> {
  const allowPrivate = opts.allowPrivate ?? false;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = await assertSafeUrl(current, allowPrivate);
    const res = await fetchImpl(u.toString(), { ...opts.init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res; // redirect without a target — hand back as-is
      current = new URL(location, u).toString(); // resolve relative redirects
      continue;
    }
    return res;
  }
  throw new Error(`Lattice: too many redirects fetching ${rawUrl}`);
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
