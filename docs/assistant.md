# The AI assistant & Context Constructor (2.0+)

`lattice gui` ships an optional assistant rail. It is **GUI-only** and inert
until you configure a credential — the `latticesql` library API is unchanged.

## Connect Claude

Open **Settings → User → Assistant**. The primary action is **Connect with
Claude** — an Authorization-Code + PKCE flow that links your Claude
Pro / Max / Enterprise **subscription**, so the assistant runs on your own
account with no API key to paste or rotate. It works out of the box (the public
OAuth client is built in); the panel shows **Connected with Claude** once linked,
with a **Disconnect** button. The redirect is a loopback callback derived from
the GUI's own origin — only a loopback `Host` is trusted, so a forged/proxied
host can't redirect the authorization code elsewhere.

Prefer a raw key? Expand **Advanced — use an API key instead** and paste an
Anthropic API key (or set `ANTHROPIC_API_KEY` in the environment). Keys are
stored encrypted in the native `secrets` entity; the env var is a fallback.

Every `ANTHROPIC_OAUTH_*` value (authorize/token URL, client id, scopes,
redirect) can be overridden via the environment for a non-default deployment —
see [`.env.example`](../.env.example).

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

**The assistant reads your organized context.** A new `get_row_context` tool lets
the assistant pull a record's full rendered context — its own fields, related
records, and combined summary — in a single call. It leverages the context tree
Lattice maintains rather than re-stitching together raw reads, so the model can
answer follow-ups like "summarize this record" or "what are the related items?" in
one tool call. It falls back to direct row tools when a record hasn't been rendered
yet.

**Deleting a table is guarded + reversible.** The `delete_entity` tool refuses
built-in tables, tables another table links to, and tables you don't own. An
**empty** table is soft-deleted immediately; a **non-empty** one is **not**
deleted until you decide what happens to the data — the tool reports the row
count and the assistant asks, then you choose `delete_data` (soft-delete the rows
too) or `move_to` another table. The physical table + rows are kept (no hard
drop), so the whole thing is revertible from version history.

**Adding a field to an existing table.** The `add_column` tool lets the assistant
add a single column to an existing table on request ("add a priority field to
projects", "add an email column"). The column is registered live, persisted,
audited, and revertible. On a cloud, the per-column masking view is rebuilt so
members see the new field immediately.

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

**Pasted GUI links resolve to the actual record.** When you paste a local GUI link
(the address bar's `…/#/fs/<table>/<id>`) into the chat, the assistant resolves it
deterministically to its real data in the database (via the same permission-gated
read as any other access), so it can answer queries about that record without
needing to fetch or guess. Resolution happens in code; the resolved data appears in
context alongside the viewed record.

The assistant can also **answer questions about Lattice itself.** Ask "what is
private mode?" or "how do I invite a member?" and it calls the `lattice_help` tool,
which searches Lattice's own documentation (these `docs/*.md` files — the single
canonical source, shipped in the npm package) and answers from it rather than
guessing or searching your data.

## The Context Constructor (file & text ingest)

Drag files onto the rail, click the upload button, or paste text (or a URL). For
each source:

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

### Reading a web link (`ingest_url`)

You can also just **ask** the assistant to read a link: "summarize https://… for me",
"save this article", "read that page". The model calls the **`ingest_url`** tool,
which fetches the page, saves it as a `files` web reference (`ref_kind='cloud_ref'`,
`ref_provider='web'`), summarizes it, and reports back. The saved reference follows
the same sharing rules as any file (private mode → private).

It is deliberately **not** a general fetch primitive — that would be an SSRF + prompt-
injection hazard for an LLM-driven tool. Guardrails:

- **User-provided URLs only.** The tool fetches only a URL that appears verbatim in
  your own message; it refuses a URL discovered inside a file, a row, or model output.
- **SSRF + policy + rate limits.** Every fetch passes the SSRF guard (no private /
  loopback / metadata addresses), a deployment on/off + allow/block-list policy, a
  per-turn fetch budget, a process-wide concurrency cap, and a per-host throttle —
  all tunable via the `LATTICE_URL_*` env vars (see [`.env.example`](../.env.example)).
- **Untrusted content.** A fetched page is treated as untrusted data end-to-end: the
  row is flagged `source_json.untrusted=true`, the enrichment prompts wrap its text in
  explicit "data, not instructions" markers, and `get_row`/`list_rows` re-wrap it when
  the assistant reads it back. The compact tool result never includes the raw page text.
- **Optional JS rendering.** SPA pages render with headless Chromium when the optional
  `playwright` dependency is installed; otherwise the crawler degrades to the static
  extraction (one warning, no failure). Posts on x.com / twitter.com are read via their
  public oEmbed endpoint.

This shares one `ingestUrlAsFile` path with the `/api/ingest/text` URL branch, so a
pasted URL and an assistant-requested URL behave identically.

### Library API

The same intelligence is a first-class, GUI-independent API (inert without an LLM
client): `organizeSource`, `describeImage`, `crawlUrl`, `enrichKnowledge`, and the
`summarizeText` / `classifyLinks` primitives — all importable from `latticesql`.
`sharp` + `file-type` are optional, lazily-loaded deps; the crawler uses `jsdom` +
`@mozilla/readability`.

A transient **"Analyzing…"** row shows while ingest runs; the add/enrich/link
events stream into the feed as the server materializes them.

## Artifacts

Ask the assistant to "write a doc / note / summary / write-up" and it calls the
`create_artifact` tool: the Markdown is saved as a native `files` row (flagged
`artifact_type='markdown'`, content inline in `extracted_text`), auto-opens in the
viewer rendered as formatted Markdown, and shows an **✦ Artifact** badge. An
artifact is an ordinary file, so it follows the **same sharing rules** — created
in private mode it's owner-only; otherwise it follows the files-table default —
enforced by cloud Row-Level Security.

## Schema definitions

New columns and tables get a concise one-line **definition** generated
automatically by a cheap, non-blocking, fail-silent model pass at creation time
(it never blocks the write and never overwrites an authored value). Definitions
show as hover tooltips on table headers, field labels, the sidebar, and dashboard
cards; built-ins ship for the native entities. They're injected into the
assistant's schema context (so a good definition improves categorization), and the
assistant can author or correct one with the **`set_definition`** tool
(`{ table, column?, description }` — column present ⇒ column definition, absent ⇒
table definition).

## De-duplication

Uploading a **byte-identical** file is de-duplicated automatically: the copy is
merged onto the original (its many-to-many links re-pointed to the survivor, then
soft-deleted — recoverable from Trash / Undo), attributed to "Lattice" in the
feed. No modal, no prompt. The assistant can also de-duplicate any table on
request with the **`dedup`** tool (`{ table, fuzzy? }`); fuzzy-merge liberalness
follows the [aggressiveness slider](#inference-aggressiveness).

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
