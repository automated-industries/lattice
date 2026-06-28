import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isValidVersion } from './update-context.js';

interface CachedCheck {
  latest: string;
  checked: number;
}

const ONE_DAY_MS = 86_400_000;

/**
 * True when `latest` is a strictly higher version than `current`. Numeric,
 * dot-segment compare — correct for plain `X.Y.Z` releases. Prerelease tags
 * (`-beta.1`) are NOT ordered (a segment like `3-beta` parses to NaN and
 * compares false), so callers that may see prereleases must guard accordingly.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

/**
 * Check the npm registry for a newer version. Caches results for `ttlMs`
 * (default 24h). Returns the latest version string if an update is available,
 * null otherwise.
 *
 * @param opts.ttlMs - Max age of a cached result to trust. The long-running GUI
 *   poll passes a shorter window so it isn't pinned to a stale 24h entry.
 * @param opts.force - Skip the cache read entirely and fetch fresh (the cache is
 *   still written, so the CLI exit-notice path benefits from the warm result).
 */
export async function checkForUpdate(
  pkgName: string,
  currentVersion: string,
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<string | null> {
  const ttlMs = opts.ttlMs ?? ONE_DAY_MS;
  // The update-check cache lives in the shared `~/.lattice` home — the same dotdir
  // the installer's managed Node, the legacy user-config, and the workspace root
  // marker all use. A separate `~/.${pkgName}` (`~/.latticesql`) dotdir just for
  // this one cache file was an inconsistency. The file is keyed by package name so
  // a single home can cache more than one package without collisions.
  const cacheDir = join(homedir(), '.lattice');
  const cachePath = join(cacheDir, `update-check-${pkgName}.json`);

  // Check cache first (unless forced fresh)
  try {
    if (!opts.force && existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCheck;
      if (Date.now() - cached.checked < ttlMs) {
        return isNewer(cached.latest, currentVersion) ? cached.latest : null;
      }
    }
  } catch {
    // Cache corrupt or unreadable — proceed to fetch
  }

  // Fetch latest version from npm
  const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { version: string };
  const latest = data.version;

  // Write cache
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ latest, checked: Date.now() } satisfies CachedCheck));
  } catch {
    // Non-critical — skip caching
  }

  return isNewer(latest, currentVersion) ? latest : null;
}

/**
 * Desktop update probe. Reads the release manifest the bundled binary updater
 * pulls from (`<baseUrl>latest.json`, written by `gen-desktop-manifest.mjs` with
 * a `version` field) and returns that version when it's newer than `current`,
 * else null.
 *
 * Unlike the binary updater, this is a pure READ — it never downloads the
 * installer or relaunches — so a long-running desktop window can surface an
 * "update available" hint without disrupting the user; applying the update stays
 * an explicit, user-triggered action. Best-effort: any network/parse/validation
 * failure resolves to null (the hint simply doesn't appear; never a crash, never
 * a false "up to date"). No on-disk cache: the manifest is small and the caller
 * polls on a slow cadence.
 */
export async function checkManifestForUpdate(
  baseUrl: string,
  currentVersion: string,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(new URL('latest.json', baseUrl), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null; // offline / DNS / timeout — retried on the next poll tick
  }
  if (!res.ok) return null;
  let version: string;
  try {
    const data = (await res.json()) as { version?: unknown };
    version = typeof data.version === 'string' ? data.version : '';
  } catch {
    return null; // malformed manifest
  }
  if (!isValidVersion(version)) return null; // missing/non-string/garbage version
  return isNewer(version, currentVersion) ? version : null;
}
