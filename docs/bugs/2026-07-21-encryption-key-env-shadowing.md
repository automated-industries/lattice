# A stale `LATTICE_ENCRYPTION_KEY` silently shadows `master.key`, breaking all secret decryption

- **Date:** 2026-07-21
- **Area:** Machine-local encryption — master-key resolution
- **Severity:** High (total, silent loss of secret access in a GUI/desktop app; extremely hard to diagnose)

## Symptom

A GUI/desktop app shows a connected state, but the Assistant panel (and any secret read) fails
with the opaque `Could not load: Unsupported state or unable to authenticate data` — an AES-GCM
auth-tag failure decrypting the app's own stored credentials. The **CLI on the same machine, same
version, same workspace, works fine.**

## Root cause

Two compounding problems in `getOrCreateMasterKey()`:

1. **`LATTICE_ENCRYPTION_KEY` was used verbatim whenever set**, with no validation and no fallback —
   `if (envKey && envKey.length > 0) return envKey`. A stale (or even blank/whitespace) value
   therefore shadowed a perfectly good `~/.lattice/.config/master.key`, and every value encrypted
   with the file key then failed to decrypt.

2. **GUI-launched apps inherit a different environment than the shell.** The desktop app (launched
   from Finder/Dock) picked up a long-lived, stale `LATTICE_ENCRYPTION_KEY` from login processes,
   while the CLI (run from a shell where the var was unset) fell back to `master.key`. Same machine —
   CLI fine, desktop broken — which is exactly what made this look like a desktop-only bug and cost
   hours to trace. The failure surfaced as a raw crypto-library string, giving the user no way to
   self-diagnose.

The encrypted data lives across several machine-local stores — `assistant-credentials.enc`,
`db-credentials.enc`, `s3-config.enc` — plus the workspace DB, **all** keyed off
`deriveKey(getOrCreateMasterKey())`. A naive "just fall back to `master.key`" is a footgun of its
own: if reads used one key but writes another, new secrets would be written under a key that can't
read the old ones — split-key corruption.

## Fix

Resolution is folded into `getOrCreateMasterKey()` so **every** caller (the GUI boot, the CLI, and
each machine-local store) gets one consistent key — no split. New behavior:

- **Blank/whitespace env key → treated as unset** (with a one-time warning), falling back to the file.
- **Non-blank env key + a differing `master.key` → validated.** We read one raw ciphertext from a
  machine-local store (`readMachineLocalCiphertext`) — a faithful witness of which key this
  machine's data was written with — and return the candidate that actually decrypts it. So a stale
  env var can't shadow the working file, and the chosen key is used for reads **and** writes. The
  (expensive) decision is cached per `(configDir, envKey, fileKey)`. It never throws (this is on hot
  paths); if neither key validates, it keeps the documented priority and warns.
- **Diagnosability:** the resolved key **source** (env / file / generated) + a short, non-reversible
  fingerprint are logged once at startup, and a genuine decrypt mismatch now raises `DecryptionKeyError`
  naming `LATTICE_ENCRYPTION_KEY` and the fix, instead of the raw OpenSSL string.

## Lessons learned

- An env var that overrides an on-disk key must be **validated**, not trusted blindly — "a value is
  present" is not "the value is correct."
- When a secret is read on one surface and written on another, the key must be resolved **once** and
  shared; two independent resolvers are a split-brain waiting to happen.
- A crypto-library error string is never a user-facing message.

## Regression tests

- `tests/unit/user-config.test.ts` (`stale LATTICE_ENCRYPTION_KEY validation`): the file key wins
  when the env key can't decrypt the machine-local sample; the env key is kept when it can; env
  priority holds when there's nothing to validate against; and a WRITE→READ round-trips under the
  resolved key (the single-key/no-split guard). Plus the blank/whitespace-ignored and fingerprint
  tests.
- `tests/unit/encryption-key-mismatch.test.ts`: a wrong key yields the actionable `DecryptionKeyError`,
  not the raw crypto string; the right key round-trips; plaintext passes through.
