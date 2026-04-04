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
 * Check the npm registry for a newer version. Caches results for 24 hours.
 * Returns the latest version string if an update is available, null otherwise.
 */
export async function checkForUpdate(
  pkgName: string,
  currentVersion: string,
): Promise<string | null> {
  const cacheDir = join(homedir(), `.${pkgName}`);
  const cachePath = join(cacheDir, 'update-check.json');

  // Check cache first
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCheck;
      if (Date.now() - cached.checked < ONE_DAY_MS) {
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
