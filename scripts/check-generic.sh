#!/usr/bin/env bash
# Pre-publish guard: scan code, docs, and tests for terms that should not
# appear in a public OSS package. The published npm tarball ships the
# `dist/` directory only — but anything that lands in the GitHub repo is
# also publicly readable, so we lint the wider source tree too.
#
# Exit 1 on the first match. Add new banned terms as needed.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Files / dirs that are part of the public package surface or are
# user-visible in the source repo. We deliberately include docs/ even
# though it is gitignored from the npm tarball — leaks here would still
# be public on GitHub.
TARGETS=(src tests README.md CHANGELOG.md docs)

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

echo "✓ check:generic passed (no banned terms or forbidden files found)."
