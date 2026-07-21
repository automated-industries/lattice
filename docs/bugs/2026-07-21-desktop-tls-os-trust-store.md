# Desktop runtime ignores the OS certificate store; HTTPS fails behind a TLS-inspecting proxy

- **Date:** 2026-07-21
- **Area:** Desktop app (Deno-compiled runtime) — TLS trust
- **Severity:** High on managed/enterprise devices (a hard blocker for "Connect with Claude" and model calls behind a corporate proxy)

## Symptom

On a managed device behind a TLS-inspecting proxy (Zscaler, Netskope, Palo Alto, a Secure Web
Gateway…), the desktop app fails to reach Anthropic — "Connect with Claude" and model calls die with
a TLS error — even though `curl`/Node on the same machine work fine.

## Root cause

The desktop app runs on a Deno-compiled runtime whose default TLS trust store is its **bundled
Mozilla CA set only** — it does **not** consult the macOS keychain / Windows cert store. On a
TLS-inspecting device, HTTPS to Anthropic is transparently re-signed by a **corporate root CA** that
IS installed in (and trusted by) the OS store, but is invisible to the bundled runtime. Every
outbound TLS handshake from the app therefore fails validation. The GUI server does the outbound
fetch (OAuth token exchange, model calls) in the Deno process, so this affects both the native-window
(macOS) and system-browser (Windows) launch paths.

## Fix

Default `DENO_TLS_CA_STORE` to `system,mozilla` so the OS-trusted roots (where the corporate proxy CA
lives) are honored, keeping the Mozilla bundle as a fallback. Set in two places for reliability:

- `desktop/main.ts` — sets it (when unset) at the very top, before any TLS connection is made (the
  GUI server binds loopback; the first outbound TLS is a user action or the deferred auto-update
  check). Portable (covers Windows and a terminal-launched app).
- `scripts/build-mac-pkg.sh` — sets it in the signed app's `Info.plist` `LSEnvironment`, so on a
  double-clicked macOS `.pkg` it is present in the process environment **before** the runtime starts
  (strictly earlier than the `main.ts` fallback).

An explicit operator `DENO_TLS_CA_STORE` always wins, and a private/self-signed CA that is **not** in
the OS store can still be pointed at with `DENO_CERT=/path/to/root.pem`. A first-class Settings field
for a custom CA bundle (and per-workspace SSL config) is a follow-up.

The companion error-message fix (`OAuthExchangeError` classification) already turns the previously
opaque "fetch failed" into an actionable "you may be behind a TLS-inspecting proxy — add your root CA
or contact IT" when a handshake still fails.

## Verification

Not unit-testable (a Deno-runtime env default in a `--no-check` desktop build). Smoke-test on a
compiled build behind a TLS-intercepting proxy whose root is trusted by the OS but not by Deno's
bundle: "Connect with Claude" should now complete where it previously failed. Confirm the value is
present via the app's process environment.

## Lessons learned

- A bundled-CA runtime silently diverges from the OS trust store exactly where enterprises need it
  (proxy roots live in the OS store). Default to the system store for a desktop app.
- Setting the env in the app bundle (`LSEnvironment`) is strictly more reliable than setting it in
  app code, because it lands before the runtime initializes TLS.
