# The AI assistant & Context Constructor (2.0+)

`lattice gui` ships an optional assistant rail. It is **GUI-only** and inert
until you configure a credential — the `latticesql` library API is unchanged.

## Connect Claude

Open **Settings → User → Assistant** and paste an Anthropic API key, or set
`ANTHROPIC_API_KEY` in the environment. Keys are stored encrypted in the native
`secrets` entity; the env var is a fallback. That's all the chat and the
Context Constructor need.

A **"Connect your Claude subscription"** link (Authorization-Code + PKCE) appears
only when all four `ANTHROPIC_OAUTH_*` values are configured (see
[`.env.example`](../.env.example)); otherwise the panel shows a dormant hint.
Use a fixed GUI port so the redirect URI is stable: `lattice gui --port 4317`.

## Chat

The rail runs a Claude tool-calling loop streamed over SSE. The model can list,
read, create, update, link, and revert rows in the active database. **Every edit
goes through the same audited, undoable mutation path as a manual edit** — it
appears in the activity feed and the version history and can be reverted.

Conversations persist in the native `chat_threads` / `chat_messages` entities;
use the thread switcher to revisit them.

## The Context Constructor (file & text ingest)

Drag files onto the rail, click the paperclip, or paste text. For each source:

1. **Referenced, not copied.** The source becomes a native `files` row that
   points at the original; bytes are not moved into Lattice.
2. **Extracted.** Plain text/markdown/code is read directly; PDFs and Office
   docs go through the optional [`markitdown`](https://github.com/microsoft/markitdown)
   CLI (`MARKITDOWN_BIN`, or on `PATH`). Without it, the file is still referenced
   and marked `extraction_status='skipped'`.
3. **Summarized** with Claude Haiku (the description fills in).
4. **Linked.** The text is classified against your existing records, and for each
   match the file is linked — **auto-creating the `files_<entity>` junction table
   when none exists yet**. New objects, enrichment, and links are all reversible
   via the version history.

A transient **"Analyzing…"** row shows while ingest runs; the add/enrich/link
events stream into the feed as the server materializes them.

## Inference Aggressiveness

A single **Conservative ↔ Aggressive** slider (Settings → Assistant) tunes how
much the assistant extrapolates. It maps to the model sampling temperature, how
liberally the ingest classifier proposes links, and whether ingest auto-creates a
missing junction (gated at ≥ 0.25) versus only suggesting it. Default: balanced
(0.5). Settable via `PUT /api/assistant/aggressiveness { "value": 0..1 }`.

## Voice (optional)

Set `OPENAI_API_KEY` (Whisper) or `ELEVENLABS_API_KEY` to enable the composer
mic; choose the provider in the Assistant settings.

## Cloud

The assistant runs against local SQLite and a direct `postgres://` connection.
It is not yet mounted in hosted multiplayer team-cloud mode.
