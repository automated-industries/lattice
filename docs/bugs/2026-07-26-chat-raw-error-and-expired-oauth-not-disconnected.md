# Chat shows a raw provider error, and an expired Claude OAuth stays "connected"

- **Date:** 2026-07-26
- **Area:** Assistant chat — turn-failure surfacing + Claude subscription (OAuth) expiry
- **Severity:** Medium (confusing raw-JSON error in chat; user stuck re-hitting a dead token with no path to reconnect)

## Symptom

Two related failures when a Claude subscription's OAuth token had expired while Lattice
still showed it as connected:

1. Sending a chat message surfaced a **raw error** in the assistant bubble — the provider's
   JSON error body (`{"type":"error","error":{"type":"authentication_error",…}}`), not a
   human sentence.
2. Lattice **stayed "connected"** to Claude. The assistant kept accepting messages and
   failing the same way every turn; nothing prompted the user to reconnect.

## Root cause

Two server-side gaps (the render/reconnect machinery on the client was already correct):

1. **Raw error passthrough.** On a turn failure the chat stream published
   `(e as Error).message` verbatim (`chat-routes.ts`). For an Anthropic 401 that message
   embeds the raw JSON error body, so the client — which shows `⚠ ` + the message — displayed
   the JSON.
2. **Expired OAuth was never disconnected.** `resolveClaudeAuth` deliberately keeps the stored
   token when a _refresh_ fails (a transient network blip must not eject a valid subscription),
   relying on "the 401 tells the user to re-connect." But nothing acted on that 401: the OAuth
   credential stayed in the store, so `isClaudeConnected` — and therefore `config.connected` —
   stayed `true`. The client already re-checks `/api/assistant/config` at turn-end and calls
   `reonboardOnAiFailure()` **only when `connected === false`** (a transient hiccup must not
   eject mid-conversation), so with `connected` stuck at `true` the reconnect flow never fired.

The confirmed signal that an OAuth token is actually dead (vs. a transient blip) is a **401/403
from a real model call** — not a refresh failure — so the disconnect belongs on the turn-error
path, keyed on the response status.

## Fix

- **Humanize every turn error** (`ai/error-humanize.ts`, new): `humanizeAssistantError` maps the
  failure to a short, blameless sentence by HTTP status (401/403 → reconnect, 429 → busy, 5xx →
  server error, network → couldn't reach), never echoing the raw body. The **one** deliberate
  pass-through is an insufficient-credit error, whose structured message the chat renders as an
  "Add more tokens" top-up card (`insufficientCreditInfo`) — flattening it would drop the link.
- **Disconnect a confirmed-expired subscription** (`assistant-routes.ts`):
  `maybeDisconnectExpiredClaude` deletes the OAuth credential on a 401/403 **only** when the
  active backend is the OAuth subscription — never a managed operator credential, never a
  bring-your-own API key (also provider kind `anthropic`, but the user's to manage), never a
  Lattice Cloud account (which re-mints its own credential). Deleting the token flips
  `config.connected` to `false`, so the client's existing turn-end re-check re-onboards the user
  to reconnect.
- The chat error path now calls both: disconnect if applicable, then publish the human message
  (a reconnect-specific one when it disconnected).

## Lessons learned

- A user-facing error string must never be a provider's raw payload. Classify and translate at
  the boundary; keep exactly the structured cases the UI renders specially (here, the top-up card).
- "Keep the credential on refresh failure" (avoid ejecting on a blip) and "disconnect on a
  confirmed 401" are different events — the reconnect UX needs the second, and the second only
  exists on the actual call path, not the refresh path.
- The reconnect flow already existed and was gated on `config.connected === false`; the bug was
  that the server never let `connected` go false. Fixing the state, not the client, was the root
  cause.

## Regression tests

- `tests/unit/error-humanize.test.ts` — 401 never leaks JSON and asks to reconnect; 429/5xx/4xx
  classification; OpenAI-compatible naming; network detection; blameless generic fallback; and the
  insufficient-credit pass-through preserved verbatim (+ the `errorStatus` / `isAuthError` /
  `isInsufficientCredit` classifiers).
- `tests/unit/llm-provider.test.ts` — `maybeDisconnectExpiredClaude`: disconnects the OAuth
  subscription on a 401; does NOT disconnect on a 500, for a BYO key (active `openai_compat`), for
  a non-anthropic provider kind, under a managed deployment, or when no OAuth is stored.
