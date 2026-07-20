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
 * typed WITHOUT a scheme (e.g. `example.com`) has `https://` inferred. Deterministic —
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
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  // 192.0.0.0/24 IETF protocol assignments ONLY — NOT the whole 192.0.0.0/16, which is public
  // (e.g. 192.0.66/73/78.0/24 = WordPress.com / Jetpack / Gravatar). The third octet MUST be 0.
  if (a === 192 && b === 0 && c === 0) return true;
  return false;
}

/**
 * Expand any valid IPv6 literal (compressed `::`, a trailing IPv4 dotted-quad, or a `%zone`
 * suffix) into its 8 16-bit groups. Returns null if it can't parse — callers MUST treat null
 * as private (fail closed). The caller has already confirmed `isIP(ip) === 6`, so this is a
 * normalizer, not a validator.
 */
function ipv6ToGroups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone); // drop scope id
  // A trailing IPv4 dotted-quad (::ffff:127.0.0.1, 64:ff9b::1.2.3.4) → two hex groups, so the
  // rest parses uniformly. This is the whole point: WHATWG `new URL()` also emits the HEX form
  // (::ffff:7f00:1), which the old dotted-only regex missed — both must resolve identically.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map((x) => Number(x));
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = o as [number, number, number, number];
    const g1 = ((a << 8) | b).toString(16);
    const g2 = ((c << 8) | d).toString(16);
    s = `${dotted[1] ?? ''}${g1}:${g2}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((h) => (h === '' ? 0 : parseInt(h, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isPrivateIpv6(ip: string): boolean {
  const g = ipv6ToGroups(ip);
  if (!g) return true; // unparseable → fail closed (treat as private)
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return true; // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // Any IPv6 that EMBEDS an IPv4 address routes to that v4 at the socket layer, so the private/
  // metadata check must apply to the embedded v4 — for the HEX form as much as the dotted one.
  const v4 = (hi: number, lo: number): string =>
    [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].map((n) => String(n)).join('.');
  // The trailing 32 bits (g6:g7) carry the embedded v4 for the /96 embeddings below.
  const embeddedV4Low = v4(g6, g7);
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstSixZero && g5 === 0xffff) return isPrivateIpv4(embeddedV4Low); // ::ffff:0:0/96 v4-mapped
  if (firstSixZero && g5 === 0) return isPrivateIpv4(embeddedV4Low); // ::/96 v4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isPrivateIpv4(embeddedV4Low); // 64:ff9b::/96 well-known NAT64 (RFC 6052 /96 → last 32 bits)
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): the embedded v4 lives in DIFFERENT bits than the
  // /96 form (RFC 6052 §2.2), so the g6:g7 value is NOT its v4. Rather than decode the /48 bit
  // layout (and risk mis-decoding a metadata address as public), deny the whole prefix — it is a
  // translation range, never a legitimate public crawl target.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 6to4 (2002::/16): bits 16-47 (g1:g2) embed the gateway's IPv4 — check it (a 2002:0a00:1::
  // address routes to 10.0.0.1). Teredo (2001:0::/32): legacy tunneling that embeds server/client
  // IPv4 in an obfuscated layout — deny the whole prefix (fail closed; not a legit crawl target).
  if (g0 === 0x2002) return isPrivateIpv4(v4(g1, g2));
  if (g0 === 0x2001 && g1 === 0x0000) return true;
  return false;
}
