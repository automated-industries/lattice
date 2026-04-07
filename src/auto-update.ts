/**
 * Auto-update — checks npm for a newer version of latticesql and installs it.
 * Call at app startup before initializing Lattice.
 *
 * Usage:
 *   import { autoUpdate } from 'latticesql';
 *   await autoUpdate();
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AutoUpdateResult {
  updated: boolean;
  packages: { name: string; from: string; to: string }[];
  restartRequired: boolean;
}

function getInstalledVersion(pkgName: string): string | null {
  try {
    const pkgPath = join(process.cwd(), "node_modules", pkgName, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

async function getLatestVersion(pkgName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Check npm for a newer version of latticesql and install it.
 * Safe to call on every startup — skips if already on latest.
 */
export async function autoUpdate(
  opts?: { quiet?: boolean },
): Promise<AutoUpdateResult> {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const log = opts?.quiet ? () => {} : console.log;
  const result: AutoUpdateResult = { updated: false, packages: [], restartRequired: false };

  const installed = getInstalledVersion("latticesql");
  if (!installed) return result;

  const latest = await getLatestVersion("latticesql");
  if (!latest || !isNewer(latest, installed)) return result;

  // Validate version format to prevent command injection
  const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
  if (!SEMVER_RE.test(latest)) {
    console.error(`[latticesql] Rejecting invalid version: "${latest}"`);
    return result;
  }

  log(`[latticesql] Updating: latticesql@${installed} → ${latest}`);

  try {
    execFileSync("npm", ["install", `latticesql@${latest}`], {
      cwd: process.cwd(),
      stdio: opts?.quiet ? "ignore" : "inherit",
      timeout: 60_000,
    });
    result.updated = true;
    result.restartRequired = true;
    result.packages.push({ name: "latticesql", from: installed, to: latest });
    log(`[latticesql] Updated successfully. Restart required.`);
  } catch (err) {
    console.error("[latticesql] Auto-update failed:", err);
  }

  return result;
}
