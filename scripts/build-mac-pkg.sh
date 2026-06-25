#!/bin/sh
# Build an UNSIGNED macOS .pkg installer for the Lattice launcher.
#
# Why a .pkg (vs a downloadable .app): a browser-downloaded .app is quarantined and,
# because we are not yet Apple-notarized, Gatekeeper hard-blocks it as "damaged". A
# .pkg instead gets the SOFT "unidentified developer" prompt (right-click → Open, or
# Settings → Privacy & Security → Open Anyway), and the installer PLACES the app into
# /Applications itself — so the installed app is not browser-quarantined and launches
# cleanly afterward. When the Apple Developer ID + notarization land, add
# `--sign "Developer ID Installer: …"` + `xcrun notarytool` here for a zero-warning flow.
#
# The launcher inside is PORTABLE: it resolves node/npm/lattice at runtime (a
# double-clicked app does not inherit the shell PATH) instead of baking absolute
# paths — so the same bundle works on any machine + any user, and its content is
# fixed, so the ad-hoc signature seal stays valid (the old setup baked paths AFTER
# signing, which broke the seal and produced the "damaged" error).
#
#   Usage:  sh scripts/build-mac-pkg.sh [outdir]
#   Output: <outdir>/Lattice.pkg  (default outdir = dist-pkg/)

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO/dist-pkg}"
WORK="$(mktemp -d)"
APP="$WORK/root/Applications/Lattice.app"
IDENTIFIER="com.latticesql.launcher"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"

trap 'rm -rf "$WORK"' EXIT
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT"

# --- Info.plist -------------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Lattice</string>
  <key>CFBundleDisplayName</key><string>Lattice</string>
  <key>CFBundleIdentifier</key><string>$IDENTIFIER</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Lattice</string>
  <key>CFBundleIconFile</key><string>lattice</string>
</dict>
</plist>
PLIST

# --- Icon (best-effort; the generated blue mark) ----------------------------
[ -f "$REPO/desktop/lattice.icns" ] && cp "$REPO/desktop/lattice.icns" "$APP/Contents/Resources/lattice.icns" || true

# --- The PORTABLE launcher --------------------------------------------------
# No baked paths: probe the common install dirs, then fall back to a LOGIN shell
# (which sources the user's profile) to recover their real PATH. Runs as the user.
cat > "$APP/Contents/MacOS/Lattice" <<'LAUNCH'
#!/bin/sh
# Lattice launcher — portable (resolves node/npm/lattice at runtime; no baked paths).
find_bin() {
  for d in "$HOME/.npm-global/bin" /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.volta/bin" $HOME/.nvm/versions/node/*/bin; do
    [ -x "$d/$1" ] && { printf '%s\n' "$d/$1"; return 0; }
  done
  # Last resort: a login shell sees the user's full PATH (npm global, fnm, asdf, …).
  /bin/sh -lc "command -v $1" 2>/dev/null
}
dialog() { osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"Lattice\"" >/dev/null 2>&1; }

NODE="$(find_bin node)"
NPM="$(find_bin npm)"
if [ -z "$NODE" ] || [ -z "$NPM" ]; then
  dialog "Lattice needs Node.js 18+. Install it from https://nodejs.org and open Lattice again."
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"

# Already serving? Just reopen the tab (handles "lost my window").
if command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:4317/ >/dev/null 2>&1; then
  open "http://127.0.0.1:4317/"
  exit 0
fi

# Always update to the latest published Lattice before launching; never block if offline.
"$NPM" install -g latticesql@latest --prefer-online >/dev/null 2>&1 || true

LATTICE="$(find_bin lattice)"
if [ -z "$LATTICE" ]; then
  dialog "Lattice installed but its command was not found. Open Terminal and run: npm install -g latticesql"
  exit 1
fi
"$NODE" "$LATTICE" gui >/dev/null 2>&1 &
LAUNCH
chmod +x "$APP/Contents/MacOS/Lattice"

# --- Sign LAST (after all content is written) so the seal is valid ----------
# Ad-hoc (no Developer ID yet). The bundle is fixed/portable, so this seal stays
# valid for every user — unlike the old flow that wrote paths after signing.
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "warn: codesign unavailable (continuing unsigned)"
codesign --verify --deep --strict "$APP" 2>/dev/null && echo "ok: launcher seal valid" || echo "warn: seal not verified"

# --- Build the UNSIGNED .pkg (installs Lattice.app into /Applications) -------
pkgbuild \
  --root "$WORK/root" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  "$OUT/Lattice.pkg"

echo "built: $OUT/Lattice.pkg (unsigned, v$VERSION)"
