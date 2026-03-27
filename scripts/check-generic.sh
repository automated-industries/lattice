#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-generic.sh — Prevent domain-specific terms from leaking into latticesql
#
# latticesql is a generic open-source library. Source code and user-facing
# documentation must never reference internal systems of any particular
# consumer. This script enforces that boundary.
#
# Scanned paths:  src/  README.md
# Excluded paths: docs/plans/ (design documents may reference inspirations)
#                 tests/ (test fixtures may use illustrative names)
#                 scripts/check-generic.sh (this file — contains the term list)
# ---------------------------------------------------------------------------

set -euo pipefail

BANNED_TERMS=(
  "secondbrain"
  "second.brain"
  "second brain"
  "toonie"
  "lattice-sync"
  "SESSION-FORMAT.md"
  "agents/shared"
  "com\.mflat"
  "/Users/secondbrain"
)

EXIT_CODE=0
SCAN_PATHS=("src/" "README.md")

for term in "${BANNED_TERMS[@]}"; do
  # Case-insensitive grep; exclude this script itself
  matches=$(grep -rniE "$term" "${SCAN_PATHS[@]}" --include='*.ts' --include='*.md' --include='*.json' 2>/dev/null \
    | grep -v 'scripts/check-generic.sh' \
    | grep -v 'node_modules/' \
    || true)

  if [ -n "$matches" ]; then
    echo "ERROR: Found domain-specific term '${term}' in source/docs:"
    echo "$matches"
    echo ""
    EXIT_CODE=1
  fi
done

if [ $EXIT_CODE -eq 0 ]; then
  echo "check-generic: OK — no domain-specific terms found in src/ or README.md"
fi

exit $EXIT_CODE
