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
 * THROWS when the registry could not be asked — unreachable, timed out, or an
 * answer that is not a 2xx. A non-2xx used to resolve to `null`, which is the
 * same value "you are already current" produces, so a proxy returning 403 or a
 * mirror returning 404 for the package name told every caller they were up to
 * date while nothing had been learned at all. A caller that genuinely wants
 * silence catches; the ones that report to a person must not, and cannot if the
 * two outcomes are the same value.
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

  if (!res.ok) {
    throw new Error(
      `the registry answered ${String(res.status)} for "${pkgName}" — nothing was learned about newer versions`,
    );
  }

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
 * Where the packaged desktop application's release manifest lives.
 *
 * The desktop app is not installed from the npm registry and cannot be upgraded
 * from it, so "is there a newer version?" is a different question on that surface
 * with a different answer — the two channels can and do disagree, and pointing a
 * desktop user at a version their channel cannot serve is worse than saying
 * nothing. Overridable by environment so the desktop shell and anything asking on
 * its behalf resolve to the same place.
 */
export const DESKTOP_RELEASE_BASE_URL =
  'https://github.com/automated-industries/lattice/releases/latest/download/';

export function desktopReleaseBaseUrl(): string {
  return process.env.LATTICE_DESKTOP_UPDATE_URL ?? DESKTOP_RELEASE_BASE_URL;
}

/**
 * Read the desktop release manifest (`<baseUrl>latest.json`, written at release
 * time with a `version` field) and return that version when it is newer than
 * `current`, else null.
 *
 * A pure READ — it never downloads the installer or relaunches.
 *
 * THROWS when the manifest could not be read or does not say what it must:
 * unreachable, non-2xx, unparseable, or a version that is not a version. Every
 * one of those means nothing was learned, which is not the same fact as "you are
 * on the newest release" and must not arrive as the same value. The polling
 * variant that wants silence is {@link checkManifestForUpdate}.
 */
export async function readManifestForUpdate(
  baseUrl: string,
  currentVersion: string,
): Promise<string | null> {
  const url = new URL('latest.json', baseUrl);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`the release manifest at ${url.toString()} answered ${String(res.status)}`);
  }
  let version: string;
  try {
    const data = (await res.json()) as { version?: unknown };
    version = typeof data.version === 'string' ? data.version : '';
  } catch (e) {
    throw new Error(`the release manifest at ${url.toString()} is not readable JSON`, { cause: e });
  }
  if (!isValidVersion(version)) {
    throw new Error(
      `the release manifest at ${url.toString()} names no usable version (${JSON.stringify(version)})`,
    );
  }
  return isNewer(version, currentVersion) ? version : null;
}

/**
 * The polling form of {@link readManifestForUpdate}: any failure resolves to
 * null instead of throwing.
 *
 * This is for the long-running desktop window, whose only use of the answer is
 * whether to show an "update available" hint. There, a failed probe means the
 * hint does not appear this tick and the next tick tries again — nobody is told
 * anything either way, so nothing can be told wrongly. Any caller that REPORTS
 * the outcome to a person uses the throwing form, because for them null and a
 * failure are two different sentences. No on-disk cache: the manifest is small
 * and the caller polls on a slow cadence.
 */
export async function checkManifestForUpdate(
  baseUrl: string,
  currentVersion: string,
): Promise<string | null> {
  try {
    return await readManifestForUpdate(baseUrl, currentVersion);
  } catch {
    return null; // offline / non-2xx / malformed — retried on the next poll tick
  }
}
