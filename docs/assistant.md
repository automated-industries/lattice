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

### Use an OpenAI-compatible model instead

The assistant is not tied to Anthropic. On the first-run connect screen, choose
**or connect an OpenAI-compatible model** to point it at any OpenAI-compatible
`chat/completions` endpoint — OpenAI, Azure, OpenRouter, a local vLLM / Ollama /
LM Studio server, your own gateway, or GitHub Copilot if you point it there. You
supply three things: a **base URL** (up to `/v1`), an **API key** (sent as a
Bearer token — leave blank for a keyless local server), and a **model** id
(e.g. `gpt-4o`). Lattice ships **no** provider-specific auth or header
impersonation; if your endpoint needs extra headers (an Azure `api-key`, a
gateway token) they can be supplied alongside the config.

Once connected it becomes the active backend and **every** assistant feature —
chat, auto-linking / ingestion, computed-table fills, as-of detection, HTML
authoring — runs on it. Switching backends and disconnecting are available via
the API (`PUT /api/assistant/provider`, `DELETE
/api/assistant/provider/openai-compat`); with nothing configured the assistant
resolves a connected Claude subscription exactly as before. Image / PDF vision
still uses a connected Claude subscription when one is available. Credentials are
stored encrypted in the machine-local assistant credential store, never returned
by any endpoint.

### Connect a Lattice Cloud account (5.4+)

The third option on the first-run connect screen is **Lattice Cloud account**.
Sign in through your browser and Lattice runs on **pay-as-you-go included
tokens** billed to your account balance — nothing to configure and no API key to
paste or rotate. Under the hood, signing in mints a **short-lived, scoped model
credential** that the assistant uses as the model key; it is re-minted
automatically when it nears expiry, and **signing the device out immediately
revokes it** (so the account's model access follows the session). The client
refuses a model-proxy URL that isn't HTTPS (or loopback), so the credential is
never sent over cleartext.

When a Lattice Cloud account is active, **Settings → User → Assistant** shows the
account's **prepaid balance** with an "Add tokens" link and a matching
**Disconnect** (`POST` / `DELETE /api/assistant/provider/lattice-cloud`) — the
same one-place model management the Claude and OpenAI-compatible backends have.
Not available in a managed deployment, where the operator supplies the model
credential.

## Chat

The rail runs a Claude tool-calling loop. Sending a message returns immediately
(the request is acknowledged, not held open); the turn runs in the background and
its text streams to the browser over the multiplexed event WebSocket, so closing
the panel, navigating away, or reloading never cancels an in-flight answer. The
model can list, read, **full-text search**, create, update, link, delete tables,
and revert in the active database. **Every edit goes through the same audited, undoable
mutation path as a manual edit** — it appears in the activity feed and the
version history and can be reverted.

The **top search box hands your query to the assistant**: type and press Enter
and the query is submitted as a chat turn, which the assistant answers using its
`search` (and read) tools rather than a plain text match. The assistant never
sees the conversation-storage or `secrets` tables (search and `list_entities`
both exclude them).

### Data provenance / traceback (`get_provenance`) (5.4+)

Ask the assistant where a piece of data came from — "where did this record come
from?", "is this value calculated or sourced?", "trace this back to its origin" —
and it calls the read-only **`get_provenance`** tool. That returns the recorded
lineage for a whole table, or a single row: the **source files, connectors, and
databases** it was synced or extracted from; the **imports and computed/derived
tables** it was materialized or calculated from; and any **AI/learning-loop
edits** — each with _how_ it feeds the data (the relation), so a multi-step
traceback (a row materialized from an import that was extracted from a file) is
preserved. It is the same lineage the **provenance graph** on an object's page
draws (`GET /api/provenance`), surfaced to the model as context so it can explain
sources in plain language. The reads are RLS-scoped (a cloud member only sees
lineage for rows they may see), and the tool reports only what's recorded — a
value entered directly with no external source is described as such, never given
an invented origin.

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
built-in tables, computed views (remove the definition instead), a table still
mirrored by a connected source (disconnect the connector instead), a table a
computed table reads from, and tables you don't own. An **empty** table is
soft-deleted immediately; a **non-empty** one is **not** deleted until you decide
what happens to the data — the tool reports the row count and the assistant asks,
then you choose one of three resolutions:

- `delete_data` — soft-delete this table's own rows, then the table.
- `delete_cascade` — the same, **plus** the rows in other tables that point at
  this one. This is the path when something still links here: the tool names
  those tables with their live row counts first, and the assistant repeats that
  inventory to you before taking it.
- `move_to: <table>` — merge the rows into another existing table (carrying the
  inbound links across) and remove the emptied source.

`delete_data` is refused while a first-class table still links here, and says so
with the same inventory — the choice is between cascading and merging, never a
dead end. **A link table created on a relationship's behalf does not block the
delete of the thing it belongs to**: a strict link table (exactly two foreign
keys and no payload of its own — for example the `files_<table>` table created
the first time you attach a file to a record) is part of the relationship rather
than an object in its own right, so it is removed together with the table and
never needs a decision of its own.

Auto-deletion is capped (1000 rows, shared between the table's own rows and the
cascade) — anything larger is refused up front, with nothing written, rather than
half-applied. The physical table + rows are kept (no hard drop), so the whole
thing is revertible from version history.

**Adding a field to an existing table.** The `add_column` tool lets the assistant
add a single column to an existing table on request ("add a priority field to
projects", "add an email column"). The column is registered live, persisted,
audited, and revertible. On a cloud, the per-column masking view is rebuilt so
members see the new field immediately.

Conversations persist in the native `chat_threads` / `chat_messages` entities;
use the thread switcher to revisit them. A new thread is **named from a short AI
summary** of its first exchange (e.g. "Adding New Notes About Cheese").

**The conversation carries messages and answers, nothing else (5.5).** The rail
holds what you sent and what the assistant replied — there are no per-turn
data-change cards inside it, live or on replay. Everything else reports in **one**
place: the **activity menu** in the header (the pill next to the version-history
clock). A running turn drives a single **background task** there, re-labelled in
plain language as each tool starts ("Reading your data…", "Updating your data
model…") and settled the moment the answer begins streaming — the same tracker
ingestion, imports and renders use, so concurrent work is one list rather than
several competing indicators. The data changes themselves stream into that menu's
activity feed as they happen, alongside your own edits. Reopening an older thread
replays its text; any activity events a previous version of Lattice persisted with
the turn are ignored rather than re-rendered, so nothing is missing and nothing is
duplicated.

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

Drag files onto the rail, click the upload button, paste text (or a URL), or add
a file or whole folder from the **Files** section in the left sidebar — the single
place your sources live. That section is a lazy, nestable tree of the folders you
have pointed Lattice at plus any loose files you added; expanding a folder lists
one level at a time, clicking a file opens its record, and the ✕ on a row stops
Lattice tracking it (your file stays on disk). For each source:

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
   table when none exists yet**. When a source fits **nothing** it simply stays a
   file: it keeps its summary, stays searchable, and stays listed under **Files**,
   rather than becoming a row in a generic bucket table. (The library-level
   `organizeSource()` API still supports a fallback object table for callers that
   want one; the app does not use it, and the legacy native `notes` table is no
   longer shown in the GUI — existing rows are untouched and still queryable.) New
   objects, enrichment, links, and junctions are all reversible via the version
   history.

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

### Structured-source import (drop a JSON / `.xlsx`) (4.2)

The Context Constructor above turns _unstructured_ sources (documents, images,
web pages) into a summarized, linked `files` row. **Dropping a structured source
— a JSON object or an Excel `.xlsx` workbook — takes a different path:** Lattice
infers a schema from it (entities, dimensions, junctions) and materializes it into
real tables. Excel sheets become records (header + data-region detection);
per-slice tabs that mirror a master become read-only **views** (no duplicated
rows). An **as-of date** is detected (file contents → name → Excel preamble → a
Claude fallback, or per-row from a date column), so re-importing a newer period
keeps a **dated snapshot** beside the prior one; a re-upload is fingerprinted and
matched to the tables already in the workspace, so it lands as a new snapshot
rather than duplicate tables.

A **brand-new dataset imports silently** (base tables + rows + any detected
computed views, shown as a live-progress card), as does a **recognized dataset with
a confident date** (a dated snapshot, reported in the activity feed). Only a
recognized dataset with **no confident date** surfaces an **inline confirm card** —
importing undated would overwrite the prior snapshot — proposing the as-of date
(and any per-row date column) before it is written; genuinely uncertain links in a
silent import become questions in the assistant panel instead of being guessed at.
Applied via `POST /api/import/apply`. The same inference +
materialization functions (`inferSchema`, `materializeImport`, `detectAsOf*`,
`excelToRecords`, `dedupeAndDetectViews`, …) are exported from `latticesql` for
library use. See [importing.md](importing.md) for the full walkthrough.

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

## Simplifying the data model (5.5+)

Ask the assistant to **simplify, clean up, tidy, consolidate, or reorganize** your
data model and it calls the read-only **`propose_model_simplification`** tool,
which runs the same deterministic **data-model planner** the Data Model panel
uses. You get back a reviewable plan: tables that hold the same thing
(merge), duplicate records (deduplicate), a repeated category that deserves its
own object (extract), missing links, undocumented objects, awkward names, and
columns stored as text that are really numbers or dates — each with a
plain-language reason and **how many records it would affect**.

Two properties make this safe:

- **The tool changes nothing.** It only reports. Applying a proposal stays a
  deliberate, owner-gated click in the Data Model panel, where every applier runs
  through the audited, revertible schema primitives.
- **A broad "simplify" request is asked about, not guessed at.** "Simplify the
  model" has at least three readings — tidy the presentation, fold duplicate
  objects together, or remove objects outright — and only the last is
  irreversible. Any request whose plausible executions include destroying data
  gets a clarifying question first, regardless of how confident the intake step
  is. Simplifying never means deleting your tables or records on your behalf.

## De-duplication

Uploading a **byte-identical** file is de-duplicated automatically: the copy is
merged onto the original (its many-to-many links re-pointed to the survivor, then
soft-deleted — recoverable from Trash / Undo), attributed to "Lattice" in the
feed. No modal, no prompt. The assistant can also de-duplicate any table on
request with the **`dedup`** tool (`{ table, fuzzy? }`); fuzzy-merge liberalness
follows the [aggressiveness slider](#inference-aggressiveness).

## Confirming a removal (5.5+)

Removing a lot of data, or several objects at once, needs your say-so. When the
assistant proposes one, the service works out what the call would actually do —
which objects, which kind of removal, and how many records — records that, and
**writes the question you see itself**. The assistant's own wording is not used.

Your answer is matched against that record, and it covers exactly what it names:

- **that object**, not one whose name resembles it;
- **that kind of removal** — approving "remove the object but keep its data" does
  not approve a cascade;
- **at most the number of records you were shown**; if the table has grown since,
  you are asked again;
- **once**. Approval covers an act, not a standing permission, so a retry needs a
  fresh question.

Small, single-object removals are not gated — the threshold is about scale.
`dedup` and `merge_rows` count as removals, bounded by how many rows they could
remove.

On a **shared cloud workspace**, a removal of this size is confirmed by the
workspace owner. A member who asks for one is told so plainly rather than
silently getting nothing.

> This replaced a mechanism that inferred consent by re-reading the conversation.
> Both halves of that evidence — the question and the answer — were text the
> assistant wrote or could steer, so agreement could be manufactured. Authority
> now comes from a record the service wrote, which the assistant cannot author.

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

The composer's 🎙 mic dictates **on-device** — speech is transcribed in your
browser by Whisper (WASM), so it needs no API key or setup and audio never leaves
your machine. There is no voice-provider choice in the GUI; the mic is always
shown when a microphone is available, and shown disabled with a tooltip when none
is. **While a note is recording or transcribing, the composer is read-only** — it
shows a "Listening… / Transcribing…" placeholder and the Send button is disabled —
and the transcript is inserted when you stop.

Keyed cloud transcription (`OPENAI_API_KEY` / Whisper or `ELEVENLABS_API_KEY`)
remains available to **API** callers via `POST /api/assistant/transcribe` for
backward compatibility; the GUI itself always dictates on-device.

## Cloud

The assistant runs against local SQLite and any `postgres://` connection, including
a Lattice cloud. On a cloud it connects as your own scoped role, so its reads and
writes are confined by Postgres Row-Level Security to the rows you may see — see
[cloud.md](cloud.md).
