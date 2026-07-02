#!/bin/sh
# Wrap the self-contained `deno desktop` app into a macOS .pkg installer.
#
# When Developer ID credentials are present (env vars below) this does a REAL
# code-sign + notarize + staple for a zero-Gatekeeper-warning install. Without them
# it falls back to an ad-hoc-signed UNSIGNED pkg — a soft "unidentified developer"
# prompt (right-click → Open), and the installer still places the app into
# /Applications so it launches cleanly. So contributors without certs can build a
# working local installer, and CI/release builds sign.
#
# Enable real signing by setting (ALL via env / CI secrets — this is a PUBLIC repo,
# NEVER hardcode a Team ID / org / Apple ID / notary key here):
#   SIGN_APP_IDENTITY        "Developer ID Application: <org> (<TEAMID>)" or a cert SHA-1
#   SIGN_INSTALLER_IDENTITY  "Developer ID Installer: <org> (<TEAMID>)" or a cert SHA-1 (optional)
# and notary credentials — EITHER a stored keychain profile:
#   NOTARY_PROFILE           a `notarytool store-credentials` profile name
# OR an App Store Connect API key (CI):
#   NOTARY_KEY               path to the .p8 key file
#   NOTARY_KEY_ID
#   NOTARY_ISSUER_ID
# If SIGN_APP_IDENTITY is unset, the ad-hoc fallback runs.
#
#   Usage:  sh scripts/build-mac-pkg.sh [app-path] [out-pkg]
#   Default: dist-desktop/Lattice.app → dist-desktop/Lattice.pkg

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$REPO/dist-desktop/Lattice.app}"
OUT="${2:-$REPO/dist-desktop/Lattice.pkg}"
IDENTIFIER="com.latticesql.desktop"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"
ENTS="$REPO/scripts/lattice.entitlements"
APPNAME="$(basename "$APP")"

[ -d "$APP" ] || { echo "error: $APP not found — run 'npm run desktop:build:mac' first" >&2; exit 1; }

# notarize <path> — submit (a .app is zipped first; .pkg/.dmg submit directly),
# wait, then staple the original. No-op (returns 0) when no notary creds are set.
notarize() {
  _path="$1"
  _zip=""
  case "$_path" in
    *.app)
      _zip="$_path.notarize.zip"
      # ditto (NOT plain zip) preserves the bundle's symlinks + perms for notary.
      ditto -c -k --keepParent "$_path" "$_zip"
      _submit="$_zip" ;;
    *) _submit="$_path" ;;
  esac
  if [ -n "$NOTARY_PROFILE" ]; then
    xcrun notarytool submit "$_submit" --keychain-profile "$NOTARY_PROFILE" --wait
  elif [ -n "$NOTARY_KEY" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER_ID" ]; then
    xcrun notarytool submit "$_submit" \
      --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
  else
    echo "note: no notary credentials — skipping notarization of $(basename "$_path")" >&2
    [ -n "$_zip" ] && rm -f "$_zip"
    return 0
  fi
  xcrun stapler staple "$_path"
  [ -n "$_zip" ] && rm -f "$_zip"
}

if [ -n "$SIGN_APP_IDENTITY" ]; then
  echo "signing $APPNAME with Developer ID (inside-out)…"
  # The auto-update runtime marker must not be sealed into the signature.
  rm -f "$APP/Contents/MacOS/Lattice.dylib.update-ok"
  # Sign nested Mach-Os FIRST (the V8 dylib needs the JIT entitlements), bundle LAST.
  [ -f "$APP/Contents/MacOS/Lattice.dylib" ] && codesign --force --sign "$SIGN_APP_IDENTITY" \
    --options runtime --timestamp --entitlements "$ENTS" "$APP/Contents/MacOS/Lattice.dylib"
  [ -f "$APP/Contents/MacOS/laufey_webview" ] && codesign --force --sign "$SIGN_APP_IDENTITY" \
    --options runtime --timestamp --entitlements "$ENTS" "$APP/Contents/MacOS/laufey_webview"
  codesign --force --sign "$SIGN_APP_IDENTITY" --options runtime --timestamp \
    --entitlements "$ENTS" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  notarize "$APP"
  # Signed component pkg that installs the app to /Applications.
  if [ -n "$SIGN_INSTALLER_IDENTITY" ]; then
    pkgbuild --root "$APP" --install-location "/Applications/$APPNAME" \
      --identifier "$IDENTIFIER" --version "$VERSION" \
      --sign "$SIGN_INSTALLER_IDENTITY" --timestamp "$OUT"
  else
    pkgbuild --root "$APP" --install-location "/Applications/$APPNAME" \
      --identifier "$IDENTIFIER" --version "$VERSION" "$OUT"
  fi
  notarize "$OUT"
  echo "built + signed: $OUT (v$VERSION)"
else
  # Ad-hoc fallback: no Developer ID → unsigned pkg.
  PKGROOT="$(mktemp -d)/root"
  trap 'rm -rf "$(dirname "$PKGROOT")"' EXIT
  mkdir -p "$PKGROOT/Applications"
  cp -R "$APP" "$PKGROOT/Applications/"
  # Re-affirm a valid ad-hoc seal on exactly the bytes we ship.
  codesign --verify --deep --strict "$PKGROOT/Applications/$APPNAME" 2>/dev/null \
    || codesign --force --deep --sign - "$PKGROOT/Applications/$APPNAME" 2>/dev/null \
    || echo "warn: codesign unavailable (continuing unsigned)"
  pkgbuild --root "$PKGROOT" --identifier "$IDENTIFIER" --version "$VERSION" \
    --install-location "/" "$OUT"
  echo "built: $OUT (unsigned, v$VERSION)"
fi
