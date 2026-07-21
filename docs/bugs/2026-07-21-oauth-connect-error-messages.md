# "Connect with Claude" surfaces opaque, misleading errors on failure

- **Date:** 2026-07-21
- **Area:** GUI — Claude subscription OAuth (manual code-paste connect flow)
- **Severity:** Medium–High (every connect failure looked the same; a TLS-proxy blocker read as "fetch failed", a lost flow read as "paste the full code")

## Symptom

On the "Connect with Claude" screen, different underlying failures all surfaced as terse or
misleading messages, giving the user no way to self-diagnose:

- Pasting a **complete, valid** `code#state` returned **"Paste the full code from the Claude
  authorization page."** — implying a malformed/partial paste, when the real cause was a missing
  PKCE verifier (the flow was never started here, expired, or the app restarted between
  authorizing and pasting).
- A network/TLS failure during the token exchange surfaced only as **"Connect failed: fetch
  failed"** — useless on a managed device behind an HTTPS-inspecting proxy, which is exactly where
  it happens.

## Root cause

Two separate gaps in the manual code-paste flow:

1. **`POST /api/assistant/oauth/exchange` conflated two failure modes.** The guard was
   `if (!code || !verifier)` with a single message about the _code_. But the verifier is a 10-minute
   cookie (`lat_oauth_verifier`) set at `/oauth/start`; when it is absent the problem is the _flow_
   (never started here / expired / lost on an app restart), which re-pasting the same code cannot
   fix. Reporting it as a code problem sent users down the wrong path.

2. **`exchangeCodeForTokens` did a bare `fetch()` with no failure classification.** A rejected
   fetch (TLS validation failure, connection refused, DNS) propagated as the runtime's raw
   `fetch failed` / `TypeError`, and a non-OK response propagated as a generic string. Nothing
   distinguished an untrusted-certificate failure (the corporate-proxy blocker) from a plain
   network error or a single-use code that had already been redeemed.

## Fix

- **Classify token-endpoint failures** (`src/gui/ai/oauth.ts`). New `OAuthExchangeError` with a
  `kind: 'tls' | 'network' | 'invalid_grant' | 'http'`. `exchangeCodeForTokens` /
  `refreshAccessToken` wrap `fetch` and route a thrown error through `classifyFetchFailure`, which
  walks the error's `cause` chain (Node nests an OpenSSL-style `code`; Deno throws an "invalid peer
  certificate" string) and emits an actionable message — for TLS: _"…you may be behind a
  TLS-inspecting proxy whose root certificate this app doesn't trust yet. Add your corporate root
  CA (Settings → Network) or contact IT."_ A `400` whose body names `invalid_grant`/expired is
  reported as a single-use code that must be re-requested.
- **Distinguish the two paste failures** (`src/gui/assistant-routes.ts`). A missing verifier now
  says the _attempt_ expired/was interrupted — click Connect again for a fresh code; a genuinely
  empty paste keeps the "paste the full code" message. The `exchange` catch already surfaces the
  thrown error's message, so the classified `OAuthExchangeError` text reaches the UI unchanged.

The related durable fix — the desktop runtime honoring the OS keychain so the corporate root is
trusted in the first place — is tracked separately; this change makes the failure _legible_ when
trust is missing.

## Lessons learned

- A single error branch for two distinct causes will always mislead on at least one of them; split
  the guard and name each cause.
- The network layer's raw error string (`fetch failed`) is never a user-facing message. Classify at
  the boundary — especially TLS, whose remedy (add a root CA) is nothing like a retry.

## Regression tests

- `tests/unit/gui-ai-oauth.test.ts` — `exchangeCodeForTokens` classifies a Node-nested cert error
  and a Deno "invalid peer certificate" string as `kind: 'tls'` with a proxy/root-CA hint; a
  non-TLS `ECONNREFUSED` as `kind: 'network'`; a `400 invalid_grant` as `kind: 'invalid_grant'`
  with a "get a fresh code" message; and a generic non-OK response still reports its status
  (`kind: 'http'`, unchanged contract).
