#!/usr/bin/env bash
# Pre-publish guard: scan code, docs, and tests for terms that should not
# appear in a public OSS package. The published npm tarball ships the
# `dist/` directory only — but anything that lands in the GitHub repo is
# also publicly readable, so we lint the wider source tree too.
#
# Exit 1 if anything is found, and also if the scan could not read what it was
# asked to read. Add new banned terms as needed.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Files / dirs that are part of the public package surface or are
# user-visible in the source repo. We deliberately include docs/ even
# though it is gitignored from the npm tarball — leaks here would still
# be public on GitHub.
#
# Positional arguments override the list so the guard can be pointed at a
# fixture tree and checked that it still catches things. A guard nobody can
# run against a known-bad input is a guard nobody knows works.
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=(src tests README.md CHANGELOG.md docs)
fi

# A target the scan cannot reach reads as clean: `grep -r` and `find` both send
# "No such file or directory" to stderr, which is discarded below, and then
# contribute no matches. Nothing further in this script can tell that apart from
# a tree that was read and had nothing in it. So the targets are checked for
# existence first, and a target that is not there is named and refused.
unreadable=0
for t in "${TARGETS[@]}"; do
  if [ ! -e "$t" ]; then
    echo "✗ scan target '$t' does not exist — nothing under it was read."
    unreadable=$((unreadable + 1))
  fi
done
if [ "$unreadable" -gt 0 ]; then
  echo ""
  echo "check:generic failed: $unreadable scan target(s) could not be read. A scan that read nothing is not a pass."
  exit 1
fi

# Terms that should never appear in a public repo. Keep generic; do NOT
# add any internal name to a public file just to ban it elsewhere.
BANNED=(
  "Anthropic Confidential"
  "INTERNAL ONLY"
  "DO NOT DISTRIBUTE"
)

violations=0
for term in "${BANNED[@]}"; do
  if hits="$(grep -rIn --color=never -F "$term" "${TARGETS[@]}" 2>/dev/null)"; then
    if [ -n "$hits" ]; then
      echo "✗ banned term '$term' found:"
      echo "$hits" | sed 's/^/    /'
      violations=$((violations + 1))
    fi
  fi
done

# ---------------------------------------------------------------------------
# The scan above only sees what is written as text. Two things in a source tree
# are not, and both make it report "clean" about content it never read:
#
#   1. A file grep classifies as binary. `grep -rI` skips it without a word.
#   2. An encoded payload — a long base64 run inside an otherwise ordinary
#      source file. It IS text, so grep reads it and finds nothing, because the
#      words are not spelled there. A vendored library embedded this way is
#      ~200KB of source that no term scan and no reviewer can read.
#
# Both are handled below rather than trusted: unreadable files are named, and
# encoded payloads are decoded and put through the same term scan as everything
# else. Silence from a scanner has to mean "I read it and it was clean".
# ---------------------------------------------------------------------------

# 1. Files inside the scanned tree that a text scan cannot read at all. The same
#    pass counts the files, because the count is what separates "read it, it was
#    clean" from "there was nothing to read" — an empty or vanished tree
#    produces exactly the same silence as a clean one.
files_scanned=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  files_scanned=$((files_scanned + 1))
  if ! grep -qI . "$f" 2>/dev/null; then
    echo "✗ '$f' is not readable as text — every term scan silently skips it."
    echo "    Keep binaries out of the scanned tree, or the scan is reporting on a file it never read."
    violations=$((violations + 1))
  fi
done < <(find "${TARGETS[@]}" -type f 2>/dev/null)

if [ "$files_scanned" -eq 0 ]; then
  echo "✗ the scan examined 0 files under: ${TARGETS[*]}"
  echo "    There is nothing here to have been clean. Refusing to report a pass."
  exit 1
fi

# 2. Encoded payloads. A run this long in the base64 alphabet is not prose; it
#    is an embedded artifact. Decode it and scan the plain text underneath.
#
#    A run that does NOT decode is left alone on purpose: it is literal text in
#    the file, so the pass above already read it. Only a run that decodes is
#    hiding something, and only that case needs this.
encoded_tmp="$(mktemp)"
trap 'rm -f "$encoded_tmp"' EXIT
payloads=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  file="${line%%:*}"
  blob="${line#*:}"
  printf '%s' "$blob" | base64 -d > "$encoded_tmp" 2>/dev/null || continue
  [ -s "$encoded_tmp" ] || continue
  payloads=$((payloads + 1))
  if ! grep -qI . "$encoded_tmp" 2>/dev/null; then
    echo "✗ '$file' embeds an encoded payload that decodes to binary — the scan cannot read it."
    echo "    Nothing here can tell you what is inside it. Do not ship an opaque blob in source."
    violations=$((violations + 1))
    continue
  fi
  for term in "${BANNED[@]}"; do
    if grep -qF "$term" "$encoded_tmp" 2>/dev/null; then
      echo "✗ banned term '$term' found inside the encoded payload in '$file'."
      echo "    It is invisible to a plain text scan of that file — decode before believing it is clean."
      violations=$((violations + 1))
    fi
  done
done < <(grep -rIoE '[A-Za-z0-9+/]{200,}={0,2}' "${TARGETS[@]}" 2>/dev/null)
echo "  scanned $payloads encoded payload(s) by decoding them first."

# Files that should never ship inside the npm tarball — verified by
# package.json's `files` array. The tarball ships only `dist/`, so the
# blocklist below catches stray copies in dist itself.
DIST_GUARD=(
  ".env"
  "credentials.json"
  "service-account.json"
)
if [ -d dist ]; then
  for fn in "${DIST_GUARD[@]}"; do
    if find dist -type f -name "$fn" -print -quit | grep -q .; then
      echo "✗ forbidden file '$fn' present in dist/ — would ship to npm"
      violations=$((violations + 1))
    fi
  done
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "check:generic failed with $violations violation(s)."
  exit 1
fi

echo "✓ check:generic passed ($files_scanned file(s) read; no banned terms or forbidden files found)."
