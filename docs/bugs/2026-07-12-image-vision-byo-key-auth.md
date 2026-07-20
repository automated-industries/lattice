# Image descriptions never generate with a bring-your-own Claude API key

- **Date:** 2026-07-12
- **Area:** Ingest — image/PDF vision credential resolution
- **Severity:** High for BYO-key users (image files ingest with no description; the file view shows "No source text.")

## Symptom

Opening an image file record shows a body of exactly "No source text." instead of the
expected AI-generated description of the image. Chat and text enrichment work fine for the
same user — only image (and scanned-PDF) descriptions are missing.

## Root cause

It is an ingest-side credential gap, not a render bug. Image vision (`extractImage`) and the
scanned-PDF fallback resolve their Anthropic auth via `resolveClaudeAuth`, which is **narrower**
than the resolver chat + text enrichment use (`resolveLlmProvider`): `resolveClaudeAuth` returns
auth only for a managed env key or a connected Claude **subscription (OAuth)**, and never
consults the **bring-your-own Claude API key** configured as an API provider pointed at an
Anthropic host (`readOpenAiCompatConfig` + `isAnthropicEndpoint`).

So for a BYO-key user: `resolveClaudeAuth` returns null → `extractImage` returns null → the file
is written with `extracted_text=''` and `extraction_status='skipped'` (and, because the row is
`skip`ped, LLM enrichment — the only writer of a `description` — never runs either). The record
view faithfully reads `extracted_text` and, finding it empty, renders "No source text.".

The render side was correct throughout; there was never an AI description sitting in a field the
view ignored — the description was simply never generated.

## Fix

Add `resolveVisionAuth(db)` in `src/gui/ai/provider.ts` and use it at the two vision call sites
(`ingest-routes.ts` `extractImage` + the PDF fallback) instead of `resolveClaudeAuth`. It unifies
vision's credentials with the rest of the assistant — managed env key, connected subscription,
**and** a BYO Claude API key on an Anthropic host — following the same managed → active-provider
ordering as `resolveLlmProvider`. Living in `provider.ts` (which already imports
`resolveClaudeAuth` + the config helpers) avoids an import cycle with `assistant-routes.ts`.

Known limitation: `ClaudeAuth` carries no `baseURL`, so a BYO key against a **non-default**
Anthropic host (a gateway) is not honored for vision — the common `api.anthropic.com` key works;
a custom-host key falls through to a connected subscription, else no vision.

## Lessons learned

- Two credential resolvers for "the same" thing (chat vs. vision) drift. When a feature needs
  Anthropic auth, it should resolve it through one shared path, not a hand-rolled narrower check.
- "A key is present" is a trap: the key was present for chat and invisible to vision. Test the
  credential resolver directly at the exact configuration state that reproduces the gap.

## Regression tests

- `tests/unit/llm-provider.test.ts` — with only a BYO Claude API key on an Anthropic endpoint
  (no OAuth, not managed): `resolveClaudeAuth` returns null (the root cause) while
  `resolveVisionAuth` returns the usable `{ apiKey }`. Plus: a non-Anthropic OpenAI-compatible
  endpoint yields no vision auth, and nothing-configured stays null.
