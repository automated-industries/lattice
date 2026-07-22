/**
 * Merge the curated flagship entries with registry-sourced ones: curated are authoritative and sort
 * FIRST; a registry entry whose server host matches a curated one is dropped (no double Slack);
 * registry entries de-dupe by host and are capped so a huge registry can't flood the grid.
 */

import type { CatalogEntry } from './types.js';

const MAX_CATALOG = 60;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function mergeCatalog(
  curated: CatalogEntry[],
  registry: CatalogEntry[],
  maxTotal = MAX_CATALOG,
): CatalogEntry[] {
  const seen = new Set(curated.map((e) => hostOf(e.serverUrl)));
  const out: CatalogEntry[] = [...curated];
  const sorted = [...registry].sort((a, b) => a.label.localeCompare(b.label));
  for (const e of sorted) {
    if (out.length >= maxTotal) break;
    const h = hostOf(e.serverUrl);
    if (seen.has(h)) continue; // a curated entry (or an earlier registry one) already covers this host
    seen.add(h);
    out.push(e);
  }
  return out;
}
