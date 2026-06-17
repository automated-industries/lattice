import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface CachedCheck {
  latest: string;
  checked: number;
}

const ONE_DAY_MS = 86_400_000;

function isNewer(latest: string, current: string): boolean {
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
  const cacheDir = join(homedir(), `.${pkgName}`);
  const cachePath = join(cacheDir, 'update-check.json');

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
