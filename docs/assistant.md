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
read, **full-text search**, create, update, link, delete tables, and revert in
the active database. **Every edit goes through the same audited, undoable
mutation path as a manual edit** — it appears in the activity feed and the
version history and can be reverted.

The **top search box hands your query to the assistant**: type and press Enter
and the query is submitted as a chat turn, which the assistant answers using its
`search` (and read) tools rather than a plain text match. The assistant never
sees the conversation-storage or `secrets` tables (search and `list_entities`
both exclude them).

When the assistant points you at a specific record — ask it to "link me to" or
"open" one — it renders a **clickable object pill** inline in its answer
(emitted as `[label](lattice://<table>/<id>)`). Clicking the pill opens that row
in the GUI via the same mode-aware navigator the activity feed uses; it links the
user-facing record (the contract/person/etc.) rather than an internal `files` id,
and only ids it actually retrieved.

**Deleting a table is guarded + reversible.** The `delete_entity` tool refuses
built-in tables, tables another table links to, and tables you don't own. An
**empty** table is soft-deleted immediately; a **non-empty** one is **not**
deleted until you decide what happens to the data — the tool reports the row
count and the assistant asks, then you choose `delete_data` (soft-delete the rows
too) or `move_to` another table. The physical table + rows are kept (no hard
drop), so the whole thing is revertible from version history.

Conversations persist in the native `chat_threads` / `chat_messages` entities;
use the thread switcher to revisit them. A new thread is **named from a short AI
summary** of its first exchange (e.g. "Adding New Notes About Cheese"). The
assistant's **data changes are saved with each turn and replayed as activity
cards** when you reopen the conversation — collapsed by type (e.g. "Deleted 19
tables", "Removed 49 rows across 9 tables"), with the operation's icon. Reads
(list / get / search) change nothing, so they produce no card; only data changes
appear. The activity feed is scoped to the open conversation rather than a global
workspace log.

The assistant **remembers what it read across turns.** Earlier tool calls and
their results (including row ids) are replayed into the model's context, so a
follow-up like "now update that row" reuses the id it just listed instead of
guessing one. Replay is bounded to the recent turns within a size budget and is
secret-redacted; set `LATTICE_CHAT_REHYDRATE=false` to disable it. Reads are also
deterministically ordered, so listing the same table twice returns the same rows.

The assistant **knows the record you're looking at.** When a file or row detail is
open, the chat passes that record (table + id) as context, so "delete this file",
"summarize this", or "share this row" act on it directly instead of asking which
one. It's a hint only — every action still goes through the same permission-gated
tools, so it can't reach a record you couldn't otherwise touch.

The assistant can also **answer questions about Lattice itself.** Ask "what is
private mode?" or "how do I invite a member?" and it calls the `lattice_help` tool,
which searches Lattice's own documentation (these `docs/*.md` files — the single
canonical source, shipped in the npm package) and answers from it rather than
guessing or searching your data.

## The Context Constructor (file & text ingest)

Drag files onto the rail, click the paperclip, or paste text (or a URL). For each
source:

1. **Referenced, not copied.** The source becomes a native `files` row that
   points at the original; bytes are not moved into Lattice.
2. **Extracted.** Plain text/markdown/code is read directly; documents
   (PDF, Word `.docx`/`.doc`, PowerPoint `.pptx`, Excel `.xlsx`, OpenDocument
   `.odt`/`.ods`/`.odp`, EPUB, RTF) are parsed **natively in-process** — no
   external CLI; **images are described by Claude vision**; **scanned/image-only
   PDFs** with no text layer fall back to Claude's native PDF read; a pasted
   **bare URL is crawled** for readable text (and the URL preserved on the row as
   a `cloud_ref`). Legacy binary `.xls`/`.ppt` (pre-2007) and any other binary
   are still referenced and marked `extraction_status='skipped'`. The parsers
   ship as optional dependencies, so a document just skips (rather than failing)
   if its parser isn't installed.
3. **Summarized** with Claude Haiku (the description fills in).
4. **Organized.** The text is classified against your existing records, and for
   each match the file is **linked** — **auto-creating the `files_<entity>` junction
   table when none exists yet**. When a source fits **nothing** (and aggressiveness
   is high), a new native `notes` object is **created** for it, linked back via
   `source_file_id`. New objects, enrichment, links, and junctions are all
   reversible via the version history.

### Library API

The same intelligence is a first-class, GUI-independent API (inert without an LLM
client): `organizeSource`, `describeImage`, `crawlUrl`, `enrichKnowledge`, and the
`summarizeText` / `classifyLinks` primitives — all importable from `latticesql`.
`sharp` + `file-type` are optional, lazily-loaded deps; the crawler uses `jsdom` +
`@mozilla/readability`.

A transient **"Analyzing…"** row shows while ingest runs; the add/enrich/link
events stream into the feed as the server materializes them.

## Inference Aggressiveness

A single **Conservative ↔ Aggressive** slider (Settings → Assistant) tunes how
much the assistant extrapolates. It maps to the model sampling temperature, how
liberally the ingest classifier proposes links, and whether ingest auto-creates a
missing junction (gated at ≥ 0.25) versus only suggesting it. Default: balanced
(0.5). Settable via `PUT /api/assistant/aggressiveness { "value": 0..1 }`. This
is a **user preference** (machine-local `~/.lattice/preferences.json`), not a
workspace secret — it persists across workspaces and never appears in a
workspace's Secrets object.

## Voice (optional)

Set `OPENAI_API_KEY` (Whisper) or `ELEVENLABS_API_KEY` to enable the composer
mic; choose the provider in the Assistant settings (also a machine-local user
preference, not a workspace secret). When no microphone is available the mic
button is shown disabled with a tooltip rather than erroring. **While a note is
recording or transcribing, the composer is read-only** — it shows a
"Listening… / Transcribing…" placeholder and the Send button is disabled — and
the transcript is inserted when you stop.

## Cloud

The assistant runs against local SQLite and any `postgres://` connection, including
a Lattice cloud. On a cloud it connects as your own scoped role, so its reads and
writes are confined by Postgres Row-Level Security to the rows you may see — see
[cloud.md](cloud.md).
