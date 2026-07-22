/**
 * The Smithery registry as a secondary metadata source — chosen because its list endpoint carries
 * an `iconUrl` the official registry usually lacks. Reads require a bearer key; when `SMITHERY_API_KEY`
 * is unset we skip it entirely and degrade to the official registry + curated list. Metadata only —
 * the connection stays direct (their hosted gateway is deliberately NOT used, per no-middleman).
 */

import { safeFetch } from '../../sources/url-safety.js';
import { resolveIcon } from './icons.js';
import type { CatalogEntry } from './types.js';

const DEFAULT_SMITHERY_URL = 'https://registry.smithery.ai/servers';
const MAX_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 5000;

interface RawSmithery {
  qualifiedName?: string;
  displayName?: string;
  iconUrl?: string;
  connections?: { type?: string; deploymentUrl?: string }[];
  remote?: boolean;
}

/** Fetch Smithery servers, or `[]` when no API key is configured (skip, don't fail). */
export async function fetchSmithery(
  fetchImpl: typeof fetch = fetch,
  apiKey?: string,
  url: string = DEFAULT_SMITHERY_URL,
): Promise<RawSmithery[]> {
  if (!apiKey) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, fetchImpl, {
      init: {
        signal: ctrl.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      },
    });
    if (!res.ok) throw new Error(`Smithery registry responded ${String(res.status)}`);
    const body = (await res.json()) as { servers?: RawSmithery[] } | RawSmithery[];
    const servers = Array.isArray(body) ? body : (body.servers ?? []);
    return servers.slice(0, MAX_ENTRIES);
  } finally {
    clearTimeout(timer);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Normalize Smithery servers to catalog entries — only those exposing a hosted https deployment. */
export function normalizeSmithery(servers: RawSmithery[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const s of servers) {
    const conn = (s.connections ?? []).find(
      (c) => !!c.deploymentUrl && /^https:\/\//i.test(c.deploymentUrl),
    );
    if (!conn?.deploymentUrl) continue;
    const label = (s.displayName ?? s.qualifiedName ?? '').trim();
    if (!label) continue;
    out.push({
      id: slug(s.qualifiedName ?? label),
      label: label.slice(0, 40),
      icon: resolveIcon({ iconUrl: s.iconUrl, label }),
      serverUrl: conn.deploymentUrl,
      transport: /sse/i.test(conn.type ?? '') ? 'sse' : 'http',
      source: 'registry',
      origin: 'smithery',
    });
  }
  return out;
}
