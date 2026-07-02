/**
 * CSRF / DNS-rebinding guard primitives for the local GUI server.
 *
 * The server is unauthenticated by design and trusts the loopback — but a browser
 * running on that same loopback is precisely the cross-site attacker's vehicle:
 * any website the user visits can issue requests to 127.0.0.1. So every
 * state-changing request (and the WebSocket upgrade) must be BOTH same-origin AND
 * carry the exact Host authority we bound. This adds no auth layer; legitimate
 * same-origin GUI requests always satisfy it.
 *
 * Kept pure + exported so the policy is unit-tested directly (origin-guard.test.ts)
 * rather than by booting a server.
 */

/**
 * True for loopback bind hosts. The GUI's data routes are unauthenticated, so
 * serving on a non-loopback host is an explicit-opt-in exposure (see the CLI's
 * --allow-remote gate).
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** The exact `Host` header authorities a request may legitimately carry. */
export function computeBoundAuthorities(
  host: string,
  port: number,
  isLoopback: boolean,
): Set<string> {
  const p = String(port);
  const auth = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  // Operator opted into a non-loopback bind: also accept that host:port. (The
  // printed URL still advertises loopback, so keep those aliases too.)
  if (!isLoopback) auth.add(`${host.toLowerCase()}:${p}`);
  return auth;
}

export interface OriginGuardHeaders {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
  'sec-fetch-site'?: string | string[] | undefined;
}

function first(v?: string | string[]): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * True iff `headers` describe a same-origin request to one of our bound
 * authorities. Rejects cross-site scripts (Sec-Fetch-Site: cross-site/same-site)
 * and rebound Host headers (DNS rebinding sends the attacker's own hostname).
 * Non-browser clients that send neither Sec-Fetch-Site nor Origin (curl, the Node
 * test harness) are allowed — a cross-site browser fetch always carries one.
 */
export function isSameOriginRequest(headers: OriginGuardHeaders, allowed: Set<string>): boolean {
  // Host must match the bound authority — this is what defeats DNS rebinding.
  if (!allowed.has((first(headers.host) ?? '').toLowerCase())) return false;
  // Prefer Sec-Fetch-Site (modern browsers always send it on fetch/XHR/WS).
  const site = first(headers['sec-fetch-site']);
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  // Fall back to Origin for older/non-browser clients.
  const origin = first(headers.origin);
  if (typeof origin === 'string' && origin) {
    try {
      return allowed.has(new URL(origin).host.toLowerCase());
    } catch {
      return false;
    }
  }
  return true;
}
