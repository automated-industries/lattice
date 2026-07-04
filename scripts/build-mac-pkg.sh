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
#   NOTARY_KEY_FILE          path to the .p8 key file
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
# The gate is the literal "status: Accepted" in the submit transcript — the exit
# code of `notarytool submit --wait` is NOT a reliable Accepted/Invalid signal
# across notarytool versions, and stapling an unaccepted artifact fails opaquely.
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
  _log="$_path.notary.log"
  if [ -n "$NOTARY_PROFILE" ]; then
    xcrun notarytool submit "$_submit" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 \
      | tee "$_log"
  elif [ -n "$NOTARY_KEY_FILE" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER_ID" ]; then
    xcrun notarytool submit "$_submit" \
      --key "$NOTARY_KEY_FILE" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait 2>&1 \
      | tee "$_log"
  else
    echo "note: no notary credentials — skipping notarization of $(basename "$_path")" >&2
    if [ -n "$_zip" ]; then rm -f "$_zip"; fi
    return 0
  fi
  if ! grep -q 'status: Accepted' "$_log"; then
    _id="$(sed -n 's/^[[:space:]]*id: \([0-9a-fA-F-]*\)$/\1/p' "$_log" | head -n 1)"
    echo "error: notarization of $(basename "$_path") was not Accepted" >&2
    if [ -n "$_id" ]; then
      echo "  inspect Apple's report with: xcrun notarytool log $_id <same credentials>" >&2
    fi
    exit 1
  fi
  rm -f "$_log"
  xcrun stapler staple "$_path"
  # NOT `[ -n … ] && rm`: for a .pkg/.dmg (no zip) the test is FALSE, that form
  # makes it the function's exit status (1), and set -e aborts the build right
  # AFTER a successful staple.
  if [ -n "$_zip" ]; then rm -f "$_zip"; fi
}

if [ -n "$SIGN_APP_IDENTITY" ]; then
  echo "signing $APPNAME with Developer ID (inside-out)…"
  # Align Info.plist BEFORE signing — the signature seals it, so a later edit
  # would break the seal. Version fields follow package.json (same version the
  # GUI reports), and the minimum OS is pinned to what the embedded webview
  # requires. Best-effort: a missing PlistBuddy or plist warns and continues.
  PLIST="$APP/Contents/Info.plist"
  PLISTBUDDY="/usr/libexec/PlistBuddy"
  if [ -x "$PLISTBUDDY" ] && [ -f "$PLIST" ]; then
    for _kv in "CFBundleShortVersionString:$VERSION" "CFBundleVersion:$VERSION" \
               "LSMinimumSystemVersion:14.0"; do
      _k="${_kv%%:*}"
      _v="${_kv#*:}"
      "$PLISTBUDDY" -c "Set :$_k $_v" "$PLIST" 2>/dev/null \
        || "$PLISTBUDDY" -c "Add :$_k string $_v" "$PLIST" 2>/dev/null \
        || echo "warn: could not set $_k in Info.plist (continuing)" >&2
    done
  else
    echo "warn: PlistBuddy or Info.plist not found — skipping Info.plist alignment" >&2
  fi
  # The auto-update runtime marker must not be sealed into the signature. (Its
  # name derives from the runtime dylib's, which varies — match the suffix.)
  rm -f "$APP/Contents/MacOS/"*.update-ok
  # Sign EVERY nested Mach-O first, bundle LAST. The runtime dylib's NAME varies
  # across desktop-runtime versions (Lattice.dylib, libruntime.dylib, …), so
  # hardcoding filenames silently leaves a binary ad-hoc-signed — which passes
  # `codesign --verify --deep` (integrity only) but fails notarization with
  # "not signed with a valid Developer ID certificate". Enumerate instead.
  # The main executable is skipped here: signing the bundle (below) signs it,
  # with the entitlements applied.
  MAIN_EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  find "$APP/Contents/MacOS" -type f | while IFS= read -r f; do
    [ -n "$MAIN_EXE_NAME" ] && [ "$(basename "$f")" = "$MAIN_EXE_NAME" ] && continue
    file "$f" | grep -q 'Mach-O' || continue
    codesign --force --sign "$SIGN_APP_IDENTITY" \
      --options runtime --timestamp --entitlements "$ENTS" "$f"
  done
  codesign --force --sign "$SIGN_APP_IDENTITY" --options runtime --timestamp \
    --entitlements "$ENTS" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  # Notary-parity gate: deep-verify accepts ad-hoc NESTED signatures, the notary
  # does not. Assert every Mach-O actually carries a Developer ID signature so a
  # missed binary fails HERE (seconds) instead of at Apple (minutes, opaque).
  find "$APP/Contents/MacOS" -type f | while IFS= read -r f; do
    file "$f" | grep -q 'Mach-O' || continue
    if ! codesign -dvv "$f" 2>&1 | grep -q '^Authority=Developer ID Application'; then
      echo "error: $f is not Developer-ID signed (would fail notarization)" >&2
      exit 1
    fi
  done
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
  if [ -n "$SIGN_INSTALLER_IDENTITY" ]; then
    # Hard gates on the shipped installer: a valid installer signature, and —
    # once notarized — Gatekeeper's own install verdict (spctl fails on a
    # signed-but-unnotarized pkg, so it only runs when notary creds were set).
    pkgutil --check-signature "$OUT"
    if [ -n "$NOTARY_PROFILE" ] || [ -n "$NOTARY_KEY_FILE" ]; then
      spctl -a -vv -t install "$OUT"
    fi
  fi
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
