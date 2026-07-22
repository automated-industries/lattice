/**
 * Pure, unit-testable helpers for the desktop app's frictionless (Sparkle-style)
 * auto-update.
 *
 * The compiled desktop app cannot patch itself in place: its dylib is sealed by a
 * Developer-ID signature under the hardened runtime, so any byte change breaks the
 * signature and macOS SIGKILLs the tampered process (`Code Signature Invalid`).
 * `Deno.autoUpdate`'s bsdiff-patch model is therefore unusable for a signed +
 * notarized build. The signature-safe path (what Sparkle / Electron-Squirrel do)
 * is to download the FULL new signed `.app`, verify it, and swap the whole bundle
 * into place via a detached helper AFTER the app quits — each version's own
 * signature stays valid because nothing is edited in place.
 *
 * The Deno-API glue (hdiutil mount, ditto, codesign/spctl verification, the spawn
 * + exit) lives in `desktop/main.ts`, which is Deno-only and not reachable by the
 * Node test runner. The DECIDABLE logic lives here so it can be unit-tested — and
 * {@link BUNDLE_SWAP_SH} can be executed against throwaway directories to prove the
 * swap + rollback are correct (the one part whose bug could brick an install).
 */

/** Which mechanism applies a downloaded update on the desktop. */
export type UpdateStrategy = 'swap' | 'installer';

/**
 * Choose the frictionless in-place bundle SWAP when it is safe, else fall back to
 * the OS INSTALLER (`.pkg` / `.msi`). The swap is macOS-only (Deno/Windows can't
 * hot-swap a loaded DLL, and there's no Linux installer artifact here) and only
 * when the running app bundle's parent directory is writable by us — i.e. an admin
 * user's `/Applications` (`drwxrwxr-x root:admin`). A standard user's non-writable
 * `/Applications`, or an App-Translocated read-only launch, both fall back to the
 * installer, which can elevate. Signature/notarization verification of the
 * downloaded bundle is a HARD gate inside the swap path (a failure aborts loudly —
 * it never silently downgrades to the installer), so it is not a strategy input.
 */
export function chooseUpdateStrategy(opts: {
  platform: string; // Deno.build.os
  bundleParentWritable: boolean;
}): UpdateStrategy {
  if (opts.platform !== 'darwin') return 'installer';
  if (!opts.bundleParentWritable) return 'installer';
  return 'swap';
}

/**
 * Resolve the enclosing `.app` bundle from the running executable path
 * (`Deno.execPath()` → `/Applications/Lattice.app/Contents/MacOS/<exe>`). Walks up
 * to the nearest ancestor whose name ends in `.app`. Returns null when not inside a
 * bundle (dev run, odd layout) — the caller then uses the installer path.
 */
export function resolveAppBundle(execPath: string): string | null {
  if (!execPath) return null;
  // Normalize and split on POSIX separators (desktop swap is macOS-only).
  const parts = execPath.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.endsWith('.app')) {
      return parts.slice(0, i + 1).join('/');
    }
  }
  return null;
}

/**
 * Parse `TeamIdentifier=XXXXXXXXXX` from `codesign -dvv` output (it prints to
 * stderr). Returns null when absent or literally `not set` (ad-hoc / unsigned) so a
 * same-team comparison against an unsigned bundle can never spuriously match.
 */
export function parseTeamIdentifier(codesignOutput: string): string | null {
  const m = /^TeamIdentifier=(.+)$/m.exec(codesignOutput);
  const id = m?.[1]?.trim();
  return id && id !== 'not set' ? id : null;
}

/**
 * True only when both bundles carry the same, present Team Identifier — the check
 * that stops a validly-signed-but-DIFFERENT-identity bundle from being swapped in
 * (the Squirrel.Mac "same designated requirement" guard). Two nulls do NOT match.
 */
export function sameSigningTeam(runningTeam: string | null, stagedTeam: string | null): boolean {
  return runningTeam != null && stagedTeam != null && runningTeam === stagedTeam;
}

/**
 * The detached POSIX-sh helper that performs the swap AFTER the app quits.
 *
 * It is STATIC — the running-app path, staged-app path, and PID arrive as
 * positional arguments `$1`/`$2`/`$3` (passed via an argv array, which is NOT
 * shell-interpreted), so a bundle path containing spaces or shell metacharacters
 * can never inject. It waits (bounded) for the app to exit, swaps atomically with
 * ROLLBACK on any failure, relaunches either way, and cleans up the staged copy.
 *
 * `mv` within the same parent directory is an atomic rename, so the running bundle
 * is never in a half-replaced state; on a failed swap the original is restored.
 */
export const BUNDLE_SWAP_SH = `#!/bin/sh
# Swap a verified new .app bundle into place after the app quits, then relaunch.
# $1 = running .app bundle   $2 = staged (verified) new .app   $3 = pid to wait for
RUNNING="$1"
STAGED="$2"
PID="$3"
# Refuse to run without a real staged bundle — never delete the running app blindly.
if [ -z "$RUNNING" ] || [ -z "$STAGED" ] || [ ! -d "$STAGED" ]; then
  exit 1
fi
BAK="$RUNNING.bak-$$"
# Wait (bounded ~30s) for the app to fully exit, then a short settle beat.
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 300 ] && break
  sleep 0.1
done
sleep 0.5
# Atomic swap with rollback. Same-directory mv is an atomic rename.
if mv "$RUNNING" "$BAK" 2>/dev/null; then
  if mv "$STAGED" "$RUNNING" 2>/dev/null; then
    rm -rf "$BAK" 2>/dev/null
  else
    mv "$BAK" "$RUNNING" 2>/dev/null
  fi
fi
# Best-effort cleanup of a leftover staged copy (present only after a failed swap).
[ -e "$STAGED" ] && rm -rf "$STAGED" 2>/dev/null
# Relaunch whatever now sits at the running path (new on success, original on
# rollback) so the user is never left without an app.
open "$RUNNING" 2>/dev/null || true
exit 0
`;
