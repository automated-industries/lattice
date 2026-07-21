# Desktop config-dir resolution is cwd-dependent; GUI launches read the wrong (legacy) credential store

- **Date:** 2026-07-21
- **Area:** Machine-local config resolution (`configDir`) — desktop vs CLI divergence
- **Severity:** High (cloud workspaces fail to open in the desktop app while the CLI works; misleading "no credential saved" error)

## Symptom

Switching to a cloud workspace in the desktop app fails with `no credential is saved for "<label>"`,
even though the credential IS saved and is actively used by the npm/browser Lattice on the same
machine, same version.

## Root cause

`configDir()` discovers the Lattice root by walking **up** from `process.cwd()` (`findLatticeRoot`).
A GUI app launched from the Dock/Finder has **cwd = `/`**, so the upward walk never reaches
`~/.lattice`, `findLatticeRoot()` returns null, and `configDir()` fell through to the **legacy
top-level `~/.lattice/`** — a different, stale store than the `~/.lattice/.config/` the CLI resolves
to (its cwd is near the workspace, so the walk finds the root). The desktop then read
`~/.lattice/db-credentials.enc` (a stale legacy subset, in the older `lattice:enc:` envelope the
current `decrypt()` can't even parse) instead of `~/.lattice/.config/db-credentials.enc` (the current
store with all credentials). `loadCredentials()` caught the parse failure and returned `{}`, so every
credential read as "missing."

## Fix

- **Anchor the fallback to the per-user `~/.lattice/.config`, not the legacy top-level.** When no
  root is discoverable from the cwd, `configDir()` now prefers `~/.lattice/.config` (the
  current-format store) so the desktop and CLI resolve to the SAME place — falling back to the
  legacy top-level dir only when it alone holds a `master.key` (don't orphan an existing legacy
  install). `LATTICE_CONFIG_DIR` / `LATTICE_ROOT` overrides still win. Backward-compatible:
  legacy-only installs are unchanged.
- **The `LATTICE_DB_<label>` hint is now functional.** The missing-credential error told users to
  "set `LATTICE_DB_<label>`", but no code read it. `getDbCredential()` now falls back to a
  `LATTICE_DB_<label>` env var (the exact label, then an uppercased/underscored shell-safe form) — a
  credential-injection escape hatch for CI/IT that needs no GUI.
- **Empty vs. unreadable is already differentiated** (from the encryption-key hardening): the
  machine-local loaders now warn on a present-but-undecryptable store instead of silently returning
  `{}`, so a wrong dir / key / format is visible rather than masquerading as "no credential."

## Lessons learned

- A GUI process's cwd is not the user's project directory — never derive a per-user config path from
  `process.cwd()`. Anchor to the home directory (with explicit overrides).
- A silent `catch → {}` on a credential store turns "unreadable" into "empty," which is exactly what
  made a wrong-directory bug look like a missing-credential bug.

## Regression tests

- `tests/unit/user-config.test.ts` — `getDbCredential` falls back to `LATTICE_DB_<label>` (exact +
  shell-safe form), and a saved credential still wins over the env var. (The `configDir` fallback is
  environment-dependent — homedir + cwd — and is covered by code review + this report.)
