# HTML/dashboard authoring fails for connected Claude subscriptions (hardcoded model not entitled)

**Date:** 2026-06-24
**Area:** GUI assistant — delegated HTML authoring (`src/gui/ai/html-author.ts`)
**Severity:** broken feature (every `create_html_file` / `edit_html_file` failed for subscription auth)

## Symptom

Asking the assistant to build a dashboard ("Build me a dashboard that shows
contract value by client") never produced a file. The chat would gather the data,
say "Now I'll create the dashboard," then retry and stall. It failed on **both
local (SQLite) and cloud (Postgres) workspaces**, which ruled out the database.
On the cloud it was mislabeled as a "rate limit"; on local it just looped.

## Root cause

The chat assistant runs on `DEFAULT_MODEL` (`claude-haiku-4-5`). The HTML author
**hardcoded a different model**, `claude-sonnet-4-6`, for the delegated authoring
sub-call — using the **same resolved Claude auth** as the chat.

When the user is connected via a Claude **subscription** ("Connect with Claude" /
OAuth), the auth is entitled only to the models on that plan. This subscription
had `claude-haiku-4-5` but **not** `claude-sonnet-4-6`. Anthropic surfaces a
non-entitled model as a `429 rate_limit_error` on **every** call — even a
one-token one — not as a 403/404. So every authoring sub-call 429'd instantly and
no HTML file was ever produced. Because it's auth/model-based, it failed
identically on local and cloud.

Verified live over the real subscription auth:

```
haiku-4-5  : OK
sonnet-4-6 : 429 rate_limit_error   (even max_tokens=16)
```

Backoff/retry could never fix this — the 429 is permanent for a non-entitled
model, not transient.

(Separately, the cloud data-gathering step hit Supabase session-pooler exhaustion
— `EMAXCONNSESSION`, pool_size 15 — which is a distinct issue tracked on its own.)

## Fix

The author model must be one the resolved auth can actually call, and ideally the
strongest such model. `htmlAuthorModelForAuth(auth)` picks by **auth kind**: a
stronger model (`claude-sonnet-4-6`) for an Anthropic **API key** (entitled to all
GA models — restoring the strong authoring the feature was designed around), and
the **chat model** (`DEFAULT_MODEL`, proven entitled in-session) for an OAuth
**subscription** (whose entitlements vary; a non-entitled model 429s every call).
The authoring is still a focused, delegated sub-call (its own system prompt + a
larger `maxTokens`) — it just never assumes a model the auth can't run.

**Caveat — Haiku-only subscriptions.** Some "Connect with Claude" subscriptions
entitle _only_ `claude-haiku-4-5` (verified: every Opus/Sonnet model 429s). On
those, authoring uses Haiku and works, but Haiku is the weakest model and is not
reliable for multi-step agentic editing (it returns valid HTML but may not honor
the change, and may narrate an action without calling the tool). For dependable
authoring/editing, use an Anthropic **API key** (Settings → Assistant → Advanced),
which entitles the stronger model.

## Lessons

- Never hardcode a model for a sub-call that differs from the model the active
  auth has already demonstrated it can use. A connected subscription's entitlement
  is narrower than an API key's, and a non-entitled model returns `429
rate_limit_error` (looks like a transient rate limit but is permanent).
- A 429 that reproduces on a one-token request is an entitlement/permission
  signal, not a load signal — do not back off; pick a usable model.

## Regression tests

- `tests/unit/gui-ai-html-author.test.ts` — asserts the authoring sub-call uses
  `DEFAULT_MODEL` (the chat model) and explicitly **not** a hardcoded
  `claude-sonnet-4-6`. (The prior test asserted the sonnet model — it encoded the
  bug; it now guards against re-introducing a divergent, possibly-unentitled
  model.) Verified live end-to-end: with the fix, `generateHtmlFile` returns a
  valid HTML document over the same subscription that 429'd before.
