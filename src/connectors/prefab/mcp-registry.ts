/**
 * The official MCP Registry as a metadata source: it lists servers with `remotes[]` (hosted URLs),
 * optional sparse `icons[]`, and no tool schema. We consume it ONLY to render the "browse more" grid
 * — the actual MCP connection stays direct from Lattice to the server, so nothing routes through the
 * registry. Bounded + SSRF-guarded; a slow/failed fetch degrades to curated-only upstream.
 */

import { safeFetch } from '../../sources/url-safety.js';
import { resolveIcon } from './icons.js';
import type { CatalogEntry } from './types.js';

const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const MAX_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 5000;

interface RawRemote {
  type?: string;
  transport_type?: string;
  url?: string;
}
interface RawServer {
  name?: string;
  description?: string;
  remotes?: RawRemote[];
  icons?: { src?: string }[];
}

/** Fetch the registry server list (bounded, timed, SSRF-guarded). Throws on a non-OK response. */
export async function fetchMcpRegistry(
  fetchImpl: typeof fetch = fetch,
  url: string = DEFAULT_REGISTRY_URL,
): Promise<RawServer[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, fetchImpl, {
      init: { signal: ctrl.signal, headers: { accept: 'application/json' } },
    });
    if (!res.ok) throw new Error(`MCP registry responded ${String(res.status)}`);
    const body = (await res.json()) as { servers?: RawServer[] } | RawServer[];
    const servers = Array.isArray(body) ? body : (body.servers ?? []);
    return servers.slice(0, MAX_ENTRIES);
  } finally {
    clearTimeout(timer);
  }
}

function displayLabel(name: string): string {
  const last = name.split('/').pop() ?? name;
  const humanized = last
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return (humanized || name).slice(0, 40);
}

function hostSlug(url: string, fallback: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  } catch {
    return fallback.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
}

/** Normalize registry servers to catalog entries — keep only https `remotes[]` (streamable-http/sse);
 *  drop stdio/package-only servers (a local user can still paste those via the custom-URL form). */
export function normalizeMcpRegistry(servers: RawServer[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const s of servers) {
    const name = (s.name ?? '').trim();
    if (!name) continue;
    const remote = (s.remotes ?? []).find((r) => {
      const t = (r.type ?? r.transport_type ?? '').toLowerCase();
      return !!r.url && /^https:\/\//i.test(r.url) && (t.includes('http') || t.includes('sse'));
    });
    if (!remote?.url) continue;
    const transport: 'http' | 'sse' = /sse/i.test(remote.type ?? remote.transport_type ?? '')
      ? 'sse'
      : 'http';
    const label = displayLabel(name);
    out.push({
      id: hostSlug(remote.url, name),
      label,
      icon: resolveIcon({ iconUrl: s.icons?.[0]?.src, label }),
      serverUrl: remote.url,
      transport,
      source: 'registry',
      origin: 'mcp-registry',
    });
  }
  return out;
}
