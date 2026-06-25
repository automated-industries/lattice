#!/bin/sh
# Wrap the self-contained `deno desktop` app into an UNSIGNED macOS .pkg installer.
#
# Why a .pkg (vs the raw .app/.dmg): a browser-downloaded app is quarantined and,
# until we're Apple-notarized, Gatekeeper hard-blocks it as "damaged". A .pkg instead
# gets the SOFT "unidentified developer" prompt (right-click → Open) and the installer
# PLACES the app into /Applications itself — so the installed app is not browser-
# quarantined and launches cleanly afterward. The packaged app is the SAME
# self-contained build (no Node prerequisite). When the Apple Developer ID +
# notarization land, add `--sign "Developer ID Installer: …"` + `xcrun notarytool`
# here for a zero-warning flow.
#
#   Usage:  sh scripts/build-mac-pkg.sh [app-path] [out-pkg]
#   Default: wraps dist-desktop/Lattice.app → dist-desktop/Lattice.pkg
#   (the desktop:build:mac npm script builds the .app, then calls this.)

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$REPO/dist-desktop/Lattice.app}"
OUT="${2:-$REPO/dist-desktop/Lattice.pkg}"
IDENTIFIER="com.latticesql.desktop"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"

[ -d "$APP" ] || { echo "error: $APP not found — run 'npm run desktop:build:mac' first" >&2; exit 1; }

PKGROOT="$(mktemp -d)/root"
trap 'rm -rf "$(dirname "$PKGROOT")"' EXIT
mkdir -p "$PKGROOT/Applications"
cp -R "$APP" "$PKGROOT/Applications/"

# Re-affirm a valid ad-hoc seal on exactly the bytes we ship (deno already signs;
# this guards against any seal drift from the copy). Ad-hoc until Developer ID lands.
APPNAME="$(basename "$APP")"
codesign --verify --deep --strict "$PKGROOT/Applications/$APPNAME" 2>/dev/null \
  || codesign --force --deep --sign - "$PKGROOT/Applications/$APPNAME" 2>/dev/null \
  || echo "warn: codesign unavailable (continuing unsigned)"

pkgbuild \
  --root "$PKGROOT" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  "$OUT"

echo "built: $OUT (unsigned, v$VERSION)"
