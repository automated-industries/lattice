/**
 * Opt-out usage analytics for the lattice npm package + GUI.
 *
 * Default is ON. A user can turn it off with `lattice analytics off`
 * (writes ~/.lattice/analytics.json) or set the `LATTICE_ANALYTICS=off`
 * env var (overrides the file for CI / scripted contexts). Disabled
 * means zero network calls.
 *
 * What's sent: function name, package version, and a per-install random
 * `anonymous_id` (generated lazily on first read). What's never sent:
 * email, display name, row data, DB contents, file paths, cloud URLs.
 *
 * Emit is fire-and-forget with a 2s timeout and silent error swallow —
 * a network outage or unreachable proxy never blocks user work.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './user-config.js';

const ANALYTICS_FILENAME = 'analytics.json';
const DEFAULT_ENDPOINT = 'https://www.latticesql.com/api/telemetry';
const EMIT_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000;

export interface AnalyticsConfig {
  enabled: boolean;
  anonymous_id: string;
  set_at: string;
}

let cached: { value: AnalyticsConfig; loadedAt: number } | null = null;

function analyticsPath(): string {
  return join(configDir(), ANALYTICS_FILENAME);
}

function freshAnonymousId(): string {
  return `anon_${randomBytes(16).toString('hex')}`;
}

function makeDefault(): AnalyticsConfig {
  return {
    enabled: true,
    anonymous_id: freshAnonymousId(),
    set_at: new Date().toISOString(),
  };
}

/**
 * Read the persisted analytics config. Creates the file on first read
 * with `enabled: true` + a fresh anonymous ID. Returns a shallow copy
 * so callers can't mutate the cache.
 */
export function readAnalyticsConfig(): AnalyticsConfig {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return { ...cached.value };
  }
  const path = analyticsPath();
  if (!existsSync(path)) {
    const fresh = makeDefault();
    try {
      writeFileSync(path, JSON.stringify(fresh, null, 2), 'utf8');
    } catch {
      // Read-only homedir or similar — fall back to in-memory default.
    }
    cached = { value: fresh, loadedAt: Date.now() };
    return { ...fresh };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AnalyticsConfig>;
    const config: AnalyticsConfig = {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      anonymous_id:
        typeof parsed.anonymous_id === 'string' && /^anon_[0-9a-f]{32}$/.test(parsed.anonymous_id)
          ? parsed.anonymous_id
          : freshAnonymousId(),
      set_at: typeof parsed.set_at === 'string' ? parsed.set_at : new Date().toISOString(),
    };
    cached = { value: config, loadedAt: Date.now() };
    return { ...config };
  } catch {
    const fallback = makeDefault();
    cached = { value: fallback, loadedAt: Date.now() };
    return { ...fallback };
  }
}

export function writeAnalyticsConfig(patch: Partial<AnalyticsConfig>): AnalyticsConfig {
  const current = readAnalyticsConfig();
  const next: AnalyticsConfig = {
    enabled: patch.enabled ?? current.enabled,
    anonymous_id: patch.anonymous_id ?? current.anonymous_id,
    set_at: new Date().toISOString(),
  };
  try {
    writeFileSync(analyticsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // best-effort
  }
  cached = { value: next, loadedAt: Date.now() };
  return { ...next };
}

function envOverride(): boolean | null {
  const v = process.env.LATTICE_ANALYTICS;
  if (!v) return null;
  if (v.toLowerCase() === 'off' || v === '0' || v.toLowerCase() === 'false') return false;
  return true;
}

/**
 * Package version. Updated in lockstep with `package.json` on every
 * release — kept as a constant so the value works under both ESM and
 * CJS builds (no `import.meta.url` games) and never depends on the
 * caller's working directory.
 */
const PACKAGE_VERSION = '1.14.0';
function packageVersion(): string {
  return PACKAGE_VERSION;
}

function isTestRun(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

/**
 * Fire-and-forget emit. Returns immediately; the POST runs in the
 * background. Cached config read keeps overhead at one disk stat per
 * minute (the 60s cache TTL). Errors are silent — the function never
 * throws so it's safe at the top of any other public method.
 *
 * Auto-disabled during vitest runs (`VITEST=true`) and any time
 * `NODE_ENV=test` is set, so unit tests don't open thousands of
 * background fetches against the public proxy.
 */
export function emitAnalytics(fn: string): void {
  if (isTestRun()) return;
  const envFlag = envOverride();
  if (envFlag === false) return;
  let cfg: AnalyticsConfig;
  try {
    cfg = readAnalyticsConfig();
  } catch {
    return;
  }
  if (envFlag === null && !cfg.enabled) return;
  const endpoint = process.env.LATTICE_ANALYTICS_ENDPOINT ?? DEFAULT_ENDPOINT;
  void postEvent(endpoint, {
    event: 'lattice_function_called',
    function: fn,
    package_version: packageVersion(),
    anonymous_id: cfg.anonymous_id,
  });
}

async function postEvent(endpoint: string, body: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, EMIT_TIMEOUT_MS);
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // network down, timeout, DNS — silent
  } finally {
    clearTimeout(timer);
  }
}
