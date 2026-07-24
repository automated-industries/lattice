// Fail-closed update-integrity helpers. These have NO top-level Deno references — they
// are imported by the Deno desktop entry AND unit-tested under Node/vitest — and take
// their side-effecting deps (fetch, command output) as plain arguments so the trust
// decisions are pure and testable.
//
// The polarity matters: a party able to tamper with an installer download is typically
// also able to fail the manifest fetch. So an unreachable manifest, a missing entry, or
// an entry with no checksum must all REFUSE the download, never silently skip the check.

export interface VerifiedAsset {
  sha: string;
  size: number | null;
}

/**
 * Resolve the release manifest's checksum + size for `filename`, FAILING CLOSED. Throws
 * when the manifest is unreachable, lists no entry for the artifact, or the entry carries
 * no checksum — so an artifact no manifest describes/verifies is never downloaded.
 */
export async function resolveVerifiedAsset(
  fetchFn: typeof fetch,
  manifestUrl: string,
  filename: string,
): Promise<VerifiedAsset> {
  let res: Response;
  try {
    res = await fetchFn(manifestUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(
      `update manifest unreachable — refusing an unverifiable download (${(e as Error).message})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `update manifest unavailable (HTTP ${res.status}) — refusing an unverifiable download`,
    );
  }
  const m = (await res.json()) as {
    assets?: Record<string, { name?: string; sha256?: unknown; sizeBytes?: unknown }>;
  };
  for (const asset of Object.values(m.assets ?? {})) {
    if (asset && asset.name === filename) {
      if (typeof asset.sha256 !== 'string' || asset.sha256.length === 0) {
        throw new Error(
          `update manifest has no checksum for ${filename} — refusing an unverifiable download`,
        );
      }
      return {
        sha: asset.sha256,
        size: typeof asset.sizeBytes === 'number' ? asset.sizeBytes : null,
      };
    }
  }
  throw new Error(`update manifest does not list ${filename} — refusing an unverifiable download`);
}

/**
 * Parse the 10-character Apple Team Identifier from `pkgutil --check-signature` output.
 * The signing-cert line reads e.g. `Developer ID Installer: Some Co (ABCDE12345)`.
 *
 * pkgutil prints the WHOLE certificate chain, so anchor to the leaf (signing) line and
 * take the LAST parenthesized token on it — the Team Identifier always trails the CN.
 * A first-match-anywhere parse could otherwise pick a parenthesized token from elsewhere
 * in the chain or embedded in the org name, which is the wrong value to pin identity on.
 */
export function parsePkgTeamIdentifier(pkgutilOutput: string): string | null {
  const leaf = pkgutilOutput.split('\n').find((l) => /Developer ID Installer:/i.test(l));
  const scope = leaf ?? pkgutilOutput;
  const all = scope.match(/\(([A-Z0-9]{10})\)/g);
  if (!all || all.length === 0) return null;
  const m = /\(([A-Z0-9]{10})\)/.exec(all[all.length - 1]);
  return m ? m[1] : null;
}

/**
 * Decide whether a downloaded OS installer may be launched — the app-level gate that
 * brings the installer-fallback path up to parity with the bundle-swap path. Fails
 * closed: Gatekeeper must accept the package AND (when the running app's signing team is
 * known) the installer's team must match it, so a validly-signed but DIFFERENT-identity
 * package can't be substituted. Returns an error message, or null when trustworthy.
 */
export function installerTrustError(opts: {
  gatekeeperAccepted: boolean;
  runningTeam: string | null;
  installerTeam: string | null;
}): string | null {
  if (!opts.gatekeeperAccepted) {
    return 'downloaded installer is not notarized (Gatekeeper rejected it) — refusing to launch it';
  }
  if (opts.runningTeam) {
    if (!opts.installerTeam) {
      return 'downloaded installer is unsigned or its identity could not be read — refusing to launch it';
    }
    if (opts.runningTeam !== opts.installerTeam) {
      return 'downloaded installer has a different signing identity — refusing to launch it';
    }
  }
  return null;
}
