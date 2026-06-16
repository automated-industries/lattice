/**
 * Policy + rate-limiting for assistant-driven URL ingestion. A user-provided URL
 * is fetched (and, for SPA pages, rendered headless) on the server's behalf, so
 * the surface is guarded on four axes: a master on/off switch, a host allow/block
 * policy, a global concurrency cap, a per-host throttle, and a per-chat-turn fetch
 * budget. The SSRF guard itself lives in `../sources/url-safety.ts`
 * (`assertSafeUrl`/`safeFetch`) and is applied alongside `assertUrlPolicy` here.
 *
 * Dependency-free + side-effect-light (mirrors `../concurrency.ts`). All knobs are
 * read from `LATTICE_URL_*` env vars with conservative defaults — headless render
 * is heavy, so concurrency defaults low.
 */

export interface UrlIngestConfig {
  /** Master switch — `LATTICE_URL_INGEST=off` disables the feature entirely. */
  enabled: boolean;
  /** Byte cap per fetch (lower than the generic crawler's — untrusted input). */
  maxBytes: number;
  /** Fetch/render timeout (ms). */
  timeoutMs: number;
  /** Global concurrent-fetch cap (headless render is heavy → low default). */
  maxConcurrency: number;
  /** Max fetches one chat turn may trigger (the real anti-"fetch many" ceiling). */
  fetchBudget: number;
  /** Minimum spacing between fetches to the SAME host (ms). */
  hostMinIntervalMs: number;
  /** Optional host allow-list — when non-empty, only these hosts may be fetched. */
  allowDomains: string[];
  /** Optional host block-list — these hosts are always refused. */
  blockDomains: string[];
}

function numEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function listEnv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Read the current URL-ingestion config from the environment (fresh each call). */
export function urlIngestConfig(): UrlIngestConfig {
  return {
    enabled: (process.env.LATTICE_URL_INGEST ?? 'on').toLowerCase() !== 'off',
    maxBytes: numEnv(process.env.LATTICE_URL_MAX_BYTES, 5_000_000),
    timeoutMs: numEnv(process.env.LATTICE_URL_TIMEOUT_MS, 20_000),
    maxConcurrency: Math.max(1, numEnv(process.env.LATTICE_URL_MAX_CONCURRENCY, 2)),
    fetchBudget: Math.max(1, numEnv(process.env.LATTICE_URL_FETCH_BUDGET, 5)),
    hostMinIntervalMs: numEnv(process.env.LATTICE_URL_HOST_MIN_INTERVAL_MS, 1_000),
    allowDomains: listEnv(process.env.LATTICE_URL_ALLOW_DOMAINS),
    blockDomains: listEnv(process.env.LATTICE_URL_BLOCK_DOMAINS),
  };
}

/** Host match: exact host or any subdomain of `domain` (leading `*.`/`.` ignored). */
function hostMatches(host: string, domain: string): boolean {
  const d = domain.replace(/^\*?\.?/, '');
  return host === d || host.endsWith('.' + d);
}

/**
 * Enforce the on/off switch + allow/block-list for a URL. Throws a human-readable
 * error on a policy violation. Call ALONGSIDE `assertSafeUrl` (which enforces SSRF)
 * — this adds the deployment's allow/block policy on top of the network guard.
 */
export function assertUrlPolicy(u: URL, cfg: UrlIngestConfig = urlIngestConfig()): void {
  if (!cfg.enabled) {
    throw new Error('Lattice: URL ingestion is disabled (set LATTICE_URL_INGEST=on to enable)');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (cfg.blockDomains.length > 0 && cfg.blockDomains.some((d) => hostMatches(host, d))) {
    throw new Error(`Lattice: host "${host}" is on the URL block-list (LATTICE_URL_BLOCK_DOMAINS)`);
  }
  if (cfg.allowDomains.length > 0 && !cfg.allowDomains.some((d) => hostMatches(host, d))) {
    throw new Error(`Lattice: host "${host}" is not on the URL allow-list (LATTICE_URL_ALLOW_DOMAINS)`);
  }
}

/**
 * A minimal counting semaphore. `acquire()` resolves to a single-use `release`
 * function; a released permit is handed directly to the next waiter (FIFO), so
 * no more than `max` holders run at once.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: (() => void)[] = [];
  constructor(max: number) {
    this.permits = Math.max(1, Math.floor(max));
  }
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
    } else {
      // Park until release() hands us its permit (permit count is unchanged — it
      // transfers directly, so we must NOT decrement again on resume).
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.permits += 1;
    };
  }
}

/**
 * A per-chat-turn fetch budget. `take()` throws once `max` fetches have been
 * started — the hard ceiling on a prompt-injected "fetch a hundred URLs" turn
 * (stricter than the assistant's tool-loop limit). One instance per chat turn.
 */
export class FetchBudget {
  private used = 0;
  constructor(private readonly max: number = urlIngestConfig().fetchBudget) {}
  take(): void {
    if (this.used >= this.max) {
      throw new Error(
        `Lattice: URL fetch budget exhausted (${String(this.max)} fetches per turn)`,
      );
    }
    this.used += 1;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

// ── Process-wide shared state (concurrency gate + per-host throttle). ──────────
let sharedGate: Semaphore | null = null;
const hostNextAllowed = new Map<string, number>();

/** The process-wide fetch concurrency gate (lazily sized from config). */
export function fetchGate(): Semaphore {
  sharedGate ??= new Semaphore(urlIngestConfig().maxConcurrency);
  return sharedGate;
}

/**
 * Throttle fetches to a single host: resolves immediately if the host's
 * min-interval has elapsed, else waits out the remainder. Reserves the next slot
 * synchronously so concurrent callers for the same host queue in order.
 */
export async function takeHostSlot(
  host: string,
  minIntervalMs: number = urlIngestConfig().hostMinIntervalMs,
): Promise<void> {
  if (minIntervalMs <= 0) return;
  const key = host.toLowerCase();
  const now = Date.now();
  const earliest = Math.max(now, hostNextAllowed.get(key) ?? 0);
  hostNextAllowed.set(key, earliest + minIntervalMs);
  const wait = earliest - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Reset the process-wide gate + host throttle. Test-only seam. */
export function resetFetchPolicyState(): void {
  sharedGate = null;
  hostNextAllowed.clear();
}
