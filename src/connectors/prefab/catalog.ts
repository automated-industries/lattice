/**
 * The prefab catalog provider — the single object the connectors route consults.
 *
 * `getEntries()` is SYNCHRONOUS and always returns at least the curated flagship set: the connectors
 * panel is NEVER blocked on (or failed by) a slow/unreachable registry. Registry data is fetched by
 * `refreshInBackground()` (single-flight, TTL-gated) and merged in on the NEXT read. Any fetch
 * failure is swallowed and the last-good (or curated-only) cache is kept — degrade, never throw.
 *
 * Registry data is metadata only and is fetched server-side; the MCP connection itself stays direct
 * from Lattice to the server, preserving the no-cloud-middleman architecture.
 */

import { curatedCatalog } from './curated.js';
import { mergeCatalog } from './merge.js';
import { fetchMcpRegistry, normalizeMcpRegistry } from './mcp-registry.js';
import { fetchSmithery, normalizeSmithery } from './smithery.js';
import type { CatalogEntry } from './types.js';

const TTL_MS = 60 * 60 * 1000; // registry refresh cadence

/** An async source of registry entries — injectable for tests; defaults to the real registries. */
export type CatalogSource = () => Promise<CatalogEntry[]>;

export interface PrefabCatalogOptions {
  /** When false, the registry is never fetched — `getEntries()` returns curated-only. */
  enabled?: boolean;
  /** Override the registry sources (tests inject canned sources; prod uses the real registries). */
  sources?: CatalogSource[];
}

export class PrefabCatalog {
  private cache: { entries: CatalogEntry[]; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private readonly enabled: boolean;
  private readonly sources: CatalogSource[];

  constructor(opts: PrefabCatalogOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.sources = opts.sources ?? [];
  }

  /** Curated ∪ last-good registry cache. Synchronous; never awaits the network. */
  getEntries(): CatalogEntry[] {
    return mergeCatalog(curatedCatalog(), this.cache?.entries ?? []);
  }

  /** Kick a background refresh if enabled, not already running, and the cache is stale. Fire-and-forget. */
  refreshInBackground(): void {
    if (!this.enabled || this.sources.length === 0 || this.inflight) return;
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
  }

  /** Await a single refresh pass. Failures per source are isolated; the cache only updates when a
   *  source returns something (else last-good / curated is kept). Never throws. */
  async refresh(): Promise<void> {
    const settled = await Promise.allSettled(this.sources.map((s) => s()));
    const entries = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (entries.length > 0 || !this.cache) this.cache = { entries, at: Date.now() };
  }
}

/** Build the production catalog from env: the official MCP Registry + (optional) Smithery. */
export function createPrefabCatalog(): PrefabCatalog {
  const enabled = (process.env.LATTICE_MCP_CATALOG ?? '').toLowerCase() !== 'off';
  const registryUrl = process.env.LATTICE_MCP_REGISTRY_URL;
  const smitheryUrl = process.env.LATTICE_SMITHERY_REGISTRY_URL;
  const smitheryKey = process.env.SMITHERY_API_KEY;
  const sources: CatalogSource[] = [
    () => fetchMcpRegistry(fetch, registryUrl).then(normalizeMcpRegistry),
    () => fetchSmithery(fetch, smitheryKey, smitheryUrl).then(normalizeSmithery),
  ];
  return new PrefabCatalog({ enabled, sources });
}

let sharedCatalog: PrefabCatalog | undefined;

/** A process-wide catalog singleton so the registry cache persists across requests. */
export function sharedPrefabCatalog(): PrefabCatalog {
  sharedCatalog ??= createPrefabCatalog();
  return sharedCatalog;
}
