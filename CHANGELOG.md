# Changelog

All notable changes to `latticesql` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

---

## [Unreleased]

## [3.2.0] - 2026-06-14

### Added — ask the assistant about Lattice itself (3.2)

- **`lattice_help` tool.** The chat assistant can now answer questions about
  Lattice's own features ("what is private mode?", "how do I invite a member?")
  by searching Lattice's documentation, instead of guessing or searching your
  data. It reads the SINGLE canonical docs source — the repo's `docs/*.md`, which
  are the GitHub docs and now ship in the npm package (`files` includes `docs`) —
  so there's no separate, drift-prone copy.

### Added — chat knows the record you're viewing (3.2)

- **The assistant resolves "this".** The chat now sends the record currently open
  in the GUI (table + id) as context, so "delete this file", "summarize this", or
  "share this row" act on it directly instead of asking which one. The hint is
  validated server-side (table must exist) and every action still flows through
  the permission-gated tools, so it can't widen access.

### Fixed — chat rail follows the active workspace (3.2)

- **Switching workspaces now resets the chat rail.** `chat_threads`/`chat_messages`
  live in the workspace DB, but a workspace switch/create left the previous
  workspace's conversation on screen. The rail now clears and reloads the new
  workspace's threads on every switch.

### Fixed — file view: inline image + Open/Download buttons (3.2)

- **Uploaded images preview inline again.** The preview only rendered when the
  stored `mime` started `image/`; an upload that didn't record a mime showed no
  image. It now also detects images by filename extension.
- **Open in Finder / Download are mutually exclusive + correctly gated.** A file
  with bytes on this machine shows **Open in Finder** (when `LATTICE_LOCAL_OPEN`
  is enabled — now the **default**; set `=0` to disable, which hides the button
  rather than offering a dead one); a cloud (S3) file with no local copy shows
  **Download**. Never both.

### Fixed — GUI activity feed + data-model sharing (3.2)

- **No feed pills for internal plumbing tables.** Writes to the assistant's own
  `chat_threads`/`chat_messages` storage (and any `_lattice*` bookkeeping) no
  longer surface as activity-feed pills — only real user-data activity does.
- **"Added column(s)" events group instead of duplicating.** The auto-create
  emitter produces "Added columns a, b to X", which the feed's grouping regex
  didn't match (`/^Added a column/`), so a bulk ingest spammed an identical pill
  per file. They now collapse into one counted pill.
- **No "Share with workspace" button on never-share tables.** A never-share table
  (e.g. `secrets`) is a hard-private floor, so its data-model panel shows a static
  "never shared" note instead of a share toggle.

### Fixed — members panel + kick (3.2)

- **Kicking a member works on managed Postgres.** `revokeMemberRole` did
  `REASSIGN OWNED` / `DROP OWNED` unconditionally, which a restricted-superuser
  owner (e.g. Supabase's `postgres`) can't do for a role it isn't a member of —
  it raised "permission denied to reassign objects" and the kick failed. A scoped
  member owns no objects, so that insufficient-privilege error is now tolerated
  (logged) and the role is still dropped; any other error — and a failed DROP ROLE
  — still surfaces.
- **Members list shows people, not roles, with the right status.** A pending
  (un-redeemed) invite now shows the invitee email + an **Invited** status instead
  of the raw Postgres role labeled "Member"; redeemed members show as **Member**.

### Fixed — member reads of masked tables + row-access enrichment (3.2)

- **Members can read audience-masked tables again.** A secured cloud REVOKEs base
  `SELECT` from members for any table with a column audience and grants only the
  `<table>_v` masking view, but the read path still queried the base table — so a
  member got `permission denied` (and column masking gave the read path zero
  protection). Member SELECTs now route to the masking view (writes still target
  the base under RLS); the view is never exposed as a separate sidebar object.
- **Per-row `_access` no longer 500s for members.** The sharing-affordance
  enrichment read `__lattice_owners` directly, which members have no grant on, so
  every member row fetch failed. It now goes through `SECURITY DEFINER`
  `lattice_rows_access` / `lattice_row_grantees`, which return only the rows the
  caller can see (and grantees only for rows the caller owns).

### Fixed — realtime, egress + misc cloud hardening (3.2)

- **Realtime actually delivers other clients' changes.** The change feed's op
  domain is `upsert`/`delete`, but the SSE merge matched `INSERT`/`UPDATE`/`DELETE`
  — so every remote change mapped to null and was dropped. And the payload parser
  read `team_id`/`owner_user_id`/`client_ts` (never emitted) while dropping
  `owner_role` (the editor), so "last edited by" never resolved. Both now mirror
  the NOTIFY trigger exactly.
- **Realtime fan-out is filtered per recipient.** The NOTIFY stream is global; a
  member's stream now forwards only changes for rows it may actually read (probed
  through the same RLS visibility function), so the pk / existence / editor of an
  unreadable row no longer leaks. Deletes (unprobeable post-trigger) are still
  forwarded so a shown row drops, but with the editor stripped.
- **Realtime catches up after a gap.** A broker that drops its `LISTEN` (sleep,
  network blip) replays the changes it missed on reconnect, via a bounded
  `SECURITY DEFINER lattice_changes_since(seq, limit)` that returns only the
  caller-visible upserts — so a brief disconnect no longer silently loses updates.
- **Offline edits that can't replay are surfaced, not retried forever.** A write
  that can never apply (row gone / RLS-invisible) now returns 409, and the client
  marks the queued edit failed + surfaces it (dead-letter) instead of looping on
  it. Any 4xx during replay is treated as terminal; only 5xx/network retries.
- **Edit time is honored.** A row write may carry `x-lattice-client-ts`; the
  audit/history timestamp now records when the edit was MADE (so an offline edit
  replayed later isn't stamped at sync time). A future timestamp is rejected.
- **Bounded row pages.** `GET /api/tables/:table/rows` validates `limit`/`offset`
  (400 on non-numeric, was `LIMIT NaN`) and clamps `limit` to ≤ 1000 — an
  unbounded page was a full-table egress on a cloud hot path.
- **Salted invite-audit email hash.** The invitee-email hash in the audit table is
  peppered with a per-cloud salt instead of a bare SHA-256.
- **Generic 500s are logged.** The shared request wrapper now logs the failing
  error (message + stack) server-side before returning a 500, so a swallowed
  cloud-op failure is no longer invisible.

### Fixed — cloud role lifecycle + offline integrity (3.2)

- **Offline edits replay idempotently.** The GUI stamps every row write with a
  stable `x-lattice-edit-id` and replays queued writes after a reconnect (or when
  the original response was lost after the row committed), but the server ignored
  the header — so a replayed `POST` created a duplicate row. The row-create path
  now derives a deterministic id from the edit-id and treats a replay whose row
  already exists as a no-op (HTTP 200, same id), never a duplicate. Scoped to the
  edit-id path; the assistant/ingest create paths are unchanged.
- **Invites are one-time-use, with revocation + expiry enforced.** A leaked or
  replayed invite token was redeemable until expiry, and a revoked invite was
  never checked on redeem. The member now atomically CLAIMS its invite on join via
  a `SECURITY DEFINER` `lattice_claim_invite()` (keyed on `session_user`, so a
  member can only burn its own invite): a second redeem, a revoked invite, or an
  expired one is rejected before any workspace is created.
- **Re-inviting an email no longer orphans the prior role.** Each re-invite mints
  a fresh suffixed role; the prior pending invite's role is now revoked + dropped
  (and expired-but-unredeemed invite roles are swept) at invite time, so scoped
  roles don't pile up and a superseded token goes dead. `revokeMemberRole` is now
  idempotent on an already-gone role.

### Fixed — data-model sharing controls restored (3.2)

- **Per-object sharing is back in the Data Model panel.** The 3.0 RLS rewrite
  stopped setting the `ownedByMe` / `shared` fields the client gates the sharing
  controls and the red/amber/green node border on, so they vanished entirely. The
  server now sets them for a cloud owner — `ownedByMe = true`, and `shared` maps to
  the table's rows defaulting to everyone-visible (the 3.1 RLS semantic). The
  "Share with workspace / Make private" toggle is repointed to the existing
  default-row-visibility endpoint (the old `/share` endpoint was removed in the
  rewrite, so the button had been 404ing).

### Fixed — cloud members + invites (3.2)

- **Members can connect again on Supabase pooler hosts (was breaking).** The
  minted member username now derives the pooler tenant ref from the owner's
  connection-string username (`postgres.<ref>`), not `session_user` (which is the
  bare role on the pooler) — so the member username keeps its `.<ref>` suffix.
- **Re-inviting an existing member no longer errors on Supabase.** The role-exists
  ALTER branch sets only `LOGIN PASSWORD`, not the `NOSUPERUSER`-class attributes
  (restating them tripped supautils 42501 since the owner isn't a true superuser).
- **Members list shows real people, not the Postgres role.** It now lists each
  member's name + email (owner from the workspace identity; members from the
  stored invitee email) with an Owner/Member status, and no longer double-counts
  the owner. A new owner-only `POST /api/cloud/remove-member` + a "Kick" control
  wire the previously-unreachable `revokeMemberRole`; revocation reassigns/drops
  the member's objects and surfaces failures (Rule 16) instead of swallowing them.

### Fixed — cloud RLS hardening (3.2)

- **Runtime-created cloud tables are now secured.** A table made from the
  data-model panel / assistant / ingest on a secured cloud is RLS-enabled +
  ownership-stamped + member-granted (via a `secureNewCloudTable` helper factored
  from `secureCloud`), instead of being left wide open.
- **Changelog visibility fails closed on an empty source set.** A derived
  observation with an empty `source_ref` was visible to every member (the
  `NOT EXISTS` over an empty array was vacuously true); it now requires a
  non-empty source array (mirrors `fold.ts`). The changelog policy runs directly
  (converges on owner open) like the rest of the bootstrap.

### Fixed — cloud join creates a new workspace + resilient member open (3.2)

- **Joining a cloud now CREATES a new workspace (and switches to it)** instead of
  repointing — hijacking — the currently-open one (which overwrote the user's
  existing local workspace: wrong name, orphaned data, no switcher entry). The new
  workspace is named after the cloud (the owner stamps `workspace_name` into the
  invite), and the join is **atomic**: if the cloud can't be opened, the
  half-created workspace + saved credential are rolled back.
- **Member open is resilient.** Owner-side maintenance that needs schema write
  grants (native-entity reconcile, legacy-secret cleanup, the identity-mirror
  upsert) is skipped / best-effort on a cloud-MEMBER open, so a member no longer
  fails to connect with "permission denied for schema public / \_\_lattice_user_identity".
- New end-to-end Postgres test boots a real owner GUI + member GUI and asserts the
  member lands on a new, correctly-named, active cloud workspace (local untouched).

### Fixed — cloud join path + schema detection (3.2)

- **Join no longer silently lands a member on an empty local DB.** A
  `${LATTICE_DB:<label>}` reference whose label was malformed (e.g. the default
  join label "Cloud workspace", which has a space) used to fall through to
  filesystem-path resolution — creating a literal `${LATTICE_DB:…}` file (0-byte
  on Windows) and a silent empty SQLite DB. `resolveDbPath` now THROWS on a
  shaped-but-invalid reference (new shared `parseDbRef`/`isDbRefShaped` helpers),
  and the join flow sanitizes the credential key / `${LATTICE_DB:…}` reference
  (via `slugify`) while keeping the human display name — so the credential
  actually resolves.
- **`cloudRlsInstalled` resolves via the search_path**, not a hardcoded `public.`,
  so a cloud installed into a non-public schema is detected correctly.

### Fixed — cloud bootstrap converges on owner open (3.2)

- **The cloud object bootstrap now converges.** `installCloudRls` /
  `installCloudSettings` run their idempotent DDL directly (serialized by the
  shared `pg_advisory_xact_lock`) instead of behind a one-shot version gate, and
  run on every cloud-OWNER open. So an object added to the bootstrap in a later
  release (e.g. `__lattice_member_invites`) now reaches clouds already stamped at
  an earlier version, and "secure this cloud" no longer no-ops. The expensive
  per-table ownership/RLS backfill stays version/secure-gated (Rule 28 — no
  whole-table scans on open).

### Changed — concurrent background render (3.2)

- **Entity-context tables now render concurrently** (bounded fan-out) instead of
  strictly one-after-another, so several render at once and each card's progress
  advances at its own rate. The cap keeps in-flight whole-table reads small.
- **`ProgressThrottle` is now per-table keyed**, so a fast table can't consume the
  shared throttle window and starve a slow table's progress updates.
- `mapWithConcurrency` moved to a package-root module (re-exported from its old
  path) so the render engine can share it without inverting layering.

### Fixed — assistant never overflows the context window (3.2)

- **Big reads no longer blow the prompt.** Each tool result is now budget-capped
  before it enters the turn's prompt (which is re-sent on every tool-loop step), so
  a few wide 200-row reads can't recompound past the model's context window.
- **Invisible auto-recovery.** If the provider still rejects a turn as too long,
  the assistant trims the oldest bulky tool result and retries automatically — the
  user never sees a "prompt is too long" error.
- **Friendly fallback, never the raw 400.** If recovery is exhausted, the user gets
  a short actionable message instead of the raw provider error JSON (the real error
  is logged for ops).
- **`list_rows` pagination.** `list_rows` accepts `limit` + `offset` so the
  assistant pages through large tables deliberately; the system prompt now tells it
  to batch large work instead of loading whole tables.

### Fixed — ingest auto-link surfaces failures (3.2)

- **No more silent auto-link failures (Rule 16).** When ingest auto-linking can't
  run or a link/junction write fails (e.g. a cloud permission/RLS error), the
  reason is now logged loudly AND surfaced in the activity feed, instead of a bare
  `catch { return []; }` that left "nothing linked" with no explanation. The
  LLM-client-init failure path, the classify failure, and per-match junction/link
  failures all surface now.

### Fixed — activity feed grouping (3.2)

- **Relationship-link activity now collapses.** Junction-materialization events
  ("Linked files ↔ project", "Linked authors ↔ books") arrived as schema ops that
  matched no grouping rule, so each spammed its own pill in the assistant feed.
  A run now collapses into one counted "Linked N relationships" bubble.

### Added — opt-in Google Analytics (3.2)

- **Anonymous, opt-in product analytics (GA4).** Gated on the existing "Send
  anonymous analytics" preference (and `DO_NOT_TRACK` / `SCARF_ANALYTICS` env):
  gtag.js is loaded lazily only after consent, so there is zero network contact
  while opted out. Configured with `send_page_view:false`, `allow_google_signals:
false`, `allow_ad_personalization_signals:false`, `anonymize_ip:true`.
- **Strict anonymization.** Event params are whitelisted to booleans / finite
  numbers / short enum tokens — table and column names, row ids/content, file
  names, queries, chat text, display name, email, paths, and the port are never
  sent. `page_view` reports a synthetic route-type location, never the real hash.
- Wired events: `app_open`, `page_view`, `row_create`/`row_update`/`row_delete`,
  `file_ingest`, `assistant_message`, `assistant_thread_new`, `history_action`
  (undo/redo/revert), `member_invite`, `table_create`/`table_delete`,
  `data_model_share`, `workspace_create`/`workspace_switch`, `search`,
  `setting_change`, `analytics_opt_in`/`analytics_opt_out`. All params are coarse
  enums/counts only. The preference reports `analytics_effective`.

### Changed — settings layout (3.2)

- **Chat system prompt moved into Settings → Workspace.** The standalone "Chat"
  settings tab is gone; the cloud system-prompt editor is now a "System Prompt"
  subsection directly beneath "Database connection", shown only to the workspace
  owner (it's absent for members and local workspaces). Endpoint unchanged.

### Fixed — GUI polish (3.2)

- **Render progress label.** The per-card background-render indicator reads
  "Rendering NN%..." instead of a bare "NN%".
- **Top-bar dropdown stacking.** The top bar now establishes an explicit stacking
  context, so its `backdrop-filter` no longer traps the workspace-switcher / search
  dropdowns beneath the dashboard cards.
- **Objects ordered alphabetically.** The sidebar object list (and the history and
  add-link pickers) are sorted by display label.

### Added — GUI polish (3.2)

- **Auto-emoji for objects.** An object with no custom icon and no built-in mapping
  is given an apt emoji derived from its name (falling back to the default icon when
  nothing fits).
- **Private-mode indicator on local workspaces.** On a single-user local workspace
  the assistant "Private mode" toggle renders checked + disabled (local data is
  always private); it stays interactive on a cloud workspace.

## [3.1.0] - 2026-06-14

### Added — email-bound cloud invites + members list (3.1)

- **Email-bound invite tokens.** `POST /api/cloud/invite` takes an invitee email,
  provisions a fresh scoped `lm_*` role (asserted non-privileged — never a
  superuser / `CREATEROLE` / `BYPASSRLS` / owner role), and returns ONE opaque,
  email-bound token. AES-256-GCM; the key is `HKDF(random token secret)` salted by
  `scrypt(email)` with the email as AAD, so a token decrypts only with the matching
  email. The member redeems it with their email in "Join a cloud"
  (`POST /api/cloud/redeem-invite`) — the member UI never handles a `postgres://`
  string. The pooler-correct user is baked in for Supabase hosts. Owner-only audit
  in `__lattice_member_invites` (email hashed; password never stored). New
  `src/cloud/invite.ts`; threat model documented in `docs/cloud.md`.
- **Members list.** `GET /api/cloud/members` lists the owner plus every role in the
  member group; the owner Database-Connection panel renders it.
- **`__lattice_user_identity` granted to the member group** in `secureCloud`, so a
  member can drive the GUI (previously hit `permission denied`, blocking every
  member on connect).
- **Chat system prompt** now edits inline in its own "Chat" settings section
  (replacing the modal).

### Fixed (3.1)

- **Cloud sharing UI restored.** Row reads re-attach the per-row `_access` summary
  (`rowAccessSummaries` over `__lattice_owners` + `__lattice_row_grants`) that the
  3.0 RLS rewrite dropped without a replacement, so the per-row sharing affordance
  renders again. Bounded to one query per page; no-op off a secured cloud.
- **Assistant writes are no longer silently dropped.** The GUI mutation layer
  auto-creates columns the table lacks (instead of filtering them away while
  reporting success), persists the value, regenerates the cloud audience view, and
  records the schema change to the activity feed. `update()` also no-ops a
  fully-filtered `SET` instead of emitting invalid SQL.
- **GUI settings.** The Advanced View toggle moved from the sidebar into
  Settings → Lattice; the active workspace row is highlighted and clicking another
  switches it AND closes the drawer; the voice provider gains a "No Voice" option
  that disables voice; error toasts render above modal overlays instead of behind.

### Added — all cloud config stored + enforced in Postgres (3.1)

- **Per-table policy (`__lattice_table_policy`).** A table now carries an
  owner-controlled `default_row_visibility` (`private` | `everyone`) and a
  `never_share` flag, both **enforced in Postgres** (the per-table insert trigger
  stamps new rows with the table default; `never_share` forces them private). So a
  raw `psql` insert obeys the same defaults as the app. Owner-only setters
  `setTableDefaultVisibility` / `setTableNeverShare` (SQL: `lattice_set_table_*`,
  gated on `rolcreaterole`); `getTablePolicy` / `getAllTablePolicies` to read.
- **Never-share exclusions.** `lattice_set_row_visibility` / `lattice_grant_row` /
  `lattice_grant_cell` now RAISE for a `never_share` table — Secrets/Messages-class
  tables can never be shared, at the data-model level (`secrets` is seeded
  never-share by `secureCloud`). Closes the gap where any table could be elevated.
- **Column-audience spec moved into Postgres (`__lattice_column_policy`).** The
  per-column `audience:` spec is now stored canonically in the DB (was on-disk YAML
  compiled once at init); `setColumnAudience` writes it and **regenerates the mask
  view from the DB**, so masking is identical across members and re-masks on change
  without a re-init. YAML specs are seeded into the DB on upgrade.
- **DB-enforced secret columns (`owner` audience).** New `lattice_is_owner`
  predicate + an `owner` column audience: a secret column is masked to everyone but
  the row owner in Postgres (the `<table>_v` view). Marking a column secret in the
  GUI now also sets this; the assistant-side redaction is rescoped to model-context
  safety, not the privacy boundary.
- **Chat "private mode".** A composer toggle that forces rows the assistant creates
  to stay private regardless of the table default. The row is stamped private
  **atomically at insert** (`Lattice.insertForcingVisibility` sets a transaction-local
  GUC the insert trigger reads), so it is never momentarily visible at the table
  default and the change-feed `NOTIFY` (deferred to COMMIT) fires only once it is
  already private — no create-then-demote window.

### Security — cloud-config review hardening (3.1)

- **Pinned `search_path` on every cloud `SECURITY DEFINER` function.** A definer
  function with an unpinned `search_path` resolves unqualified relation names via
  the caller's `pg_temp` first, so a member could `CREATE TEMP TABLE
__lattice_owners(...)` to shadow the ownership bookkeeping and bypass row RLS.
  All cloud definer helpers (bootstrap, per-table trigger, workspace settings) now
  pin `search_path = "<schema>", pg_temp` (pg_temp **last**), and the installer
  revokes schema `CREATE` from `PUBLIC` as defense-in-depth. Bootstrap, per-table,
  and settings install versions bumped so existing clouds re-install on upgrade.
- **Change-log history is owner-only.** A `__lattice_changelog` ground-truth/audit
  entry carries every column in cleartext, including ones the `<table>_v` mask hides
  from a non-owner. The read policy now requires `lattice_is_owner` for those
  entries (was "row is visible"), so a member who can see a shared row can no longer
  read its full history and unmask columns. Per-viewer **derived** observations are
  unaffected (still source-visibility gated).
- **`never_share` is retroactive.** Turning on a table's never-share flag now resets
  any already-shared row to private and drops every row/cell grant on the table, so
  flagging an existing table never-share doesn't leave previously-shared rows
  visible.
- **One-time column-policy seed.** The YAML→DB audience seed runs exactly once per
  table (marker-gated), so a later `secureCloud` can't silently re-mask a column the
  owner has since cleared.
- **Render abort is checked per file**, not only per row, so a workspace switch tears
  down an in-flight render promptly instead of finishing the current entity's files.

### Added — async background render (3.1)

- **Non-blocking workspace open.** `lattice gui` no longer blocks on a full
  `db.render()` when opening/switching a workspace — it serves immediately and
  renders in the background, so a cloud workspace with large junction tables opens
  instantly. Progress-bearing render API (`RenderOptions { onProgress, signal }`,
  `RenderProgress`, `ProgressThrottle`), `Lattice.renderInBackground` with a shared
  single-flight guard, `RenderProgressBus`, and `GET /api/render/progress` (SSE) +
  `GET /api/render/status`. The GUI shows live per-table render progress (bottom bar
  - pill) on each card; switching aborts the prior render. The `--no-render` flag is
    removed (fast-open + background render is the single default path).
- **Workspace-switch spinner restored** on the stable header button (regressed in
  the 3.0 GUI rewrite).

## [3.0.0] - 2026-06-11

### Breaking — clouds are now a shared Postgres DB secured by row-level security

A "cloud" is now a **shared Postgres database that every user connects to
directly as their own scoped, non-superuser role**, with real Postgres
Row-Level Security as the only security boundary. The server/replica model is
**deleted**. A cloud and a "team" are the same thing — one concept.

**Removed (breaking):**

- **`lattice serve` and the entire HTTP/bearer server.** There is no Lattice
  server process in front of Postgres anymore — no `serve --team-cloud`, no
  bearer-token auth, no `__lattice_api_tokens`, no team-server routes.
- **The replica / sync client** (`TeamsClient`, the outbox/DLQ, and the
  `__lattice_team_*` tables: `_identity`, `_connections`, `_outbox`, `_dlq`,
  `_members`). Members read and write the shared database live over their own
  scoped connection.
- **App-layer row ACLs as the security boundary.** Row visibility is enforced by
  Postgres RLS policies, not by application `WHERE`-injection.
- **The direct-cloud reconnect banner** and the "hosted Lattice Teams URL"
  affordance.

**Added:**

- **RLS installer (plain idempotent SQL).** `installCloudRls` + `enableRlsForTable`
  install `FORCE ROW LEVEL SECURITY` and per-table policies keyed on
  `session_user`, plus ownership/grant bookkeeping (`__lattice_owners`,
  `__lattice_row_grants`) and a `__lattice_changes` change feed (drives realtime
  via `pg_notify`). Rows are **private by default**; the owner shares a row with
  `lattice_set_row_visibility(table, pk, 'everyone' | 'private')` or grants a
  specific member with `lattice_grant_row` (owner-only `SECURITY DEFINER`
  functions). SQLite is a no-op — it stays a single-user local store.
- **Scoped member provisioning.** `provisionMemberRole` creates a `NOSUPERUSER
NOCREATEROLE` LOGIN role in the `lattice_members` group; `generateMemberPassword`
  / `memberRoleName` / `revokeMemberRole` / `setRowVisibility` round it out. The
  credential a member holds is a dead end for privilege escalation.
- **`Lattice.init({ introspectOnly })`** — open an already-provisioned database
  issuing NO DDL. This is how a scoped member (no CREATE/ALTER privilege) opens a
  cloud: the GUI discovers the member's privileged tables from `information_schema`
  and registers them, then opens introspect-only.
- **`probeCloud(url)`** now reports `{ reachable, dialect, isCloud }` — `isCloud`
  detects an established cloud (Postgres with `__lattice_owners` installed) via
  `to_regclass`, so even a member denied SELECT on the bookkeeping gets a truthful
  answer. `canManageRoles` / `cloudRlsInstalled` are exported helpers.
- **Three GUI flows on the new model:** migrate a local Lattice into a cloud
  (you become the owner, RLS installed, you own the migrated rows), join an
  existing cloud with the scoped credentials the owner issued (the invite IS the
  credentials — there is no token redemption), and invite a member (an owner with
  `CREATEROLE` provisions a scoped role and hands over the connection blob).
- **Offline editing is preserved** as the client-side local edit queue, decoupled
  from any server.

**Per-column audiences & per-viewer values (experimental, off by default).** Two
primitives take RLS from whole-row to the cell and to per-viewer values; a column
with no `audience` behaves exactly as before:

- **Per-column masking** — declare `audience:` on a column and Lattice generates a
  cell-masking view (`<table>_v`): the column compiles to a `CASE` mask over
  `session_user`-keyed `SECURITY DEFINER` helpers (`lattice_has_role` /
  `lattice_is_subject` / `lattice_source_visible`), members read the view (base
  `SELECT` revoked), and a masked cell reads `NULL`. Owner-managed app roles
  (`__lattice_member_roles` + `lattice_assign_role`); members can't self-promote.
  (`enableAudienceView`, `audiencePredicate`.)
- **Per-viewer values** — an enrichment is recorded as a per-viewer OBSERVATION,
  not written into the shared row: `Lattice.observe()` appends a derived
  observation (no canonical mutation, so the row's `updated_at` doesn't move and a
  viewer who can't see the source can't even tell an enrichment exists), and
  `Lattice.foldForViewer()` folds the observations a viewer may reach onto the
  ground-truth row (latest-visible-per-attribute wins). A value derived from a
  source a member can't reach never appears for them; un-sharing the source reverts
  it with no residue. On a cloud the substrate is sealed by RLS
  (`enableChangelogRls`) so a member only ever reads observations whose sources it
  can see. Deterministic; cache with `FoldCache`.
- **Crypto-shred** — `sealUnderSource` / `shredSource` cryptographically erase a
  sensitive source's derived values (destroy the per-source key → unrecoverable,
  backups included); `observe()` seals sensitive observations and `foldForViewer()`
  reverts them once the key is gone.
- **Per-card overrides** — a row owner can grant one member one masked cell with
  `grantCell()` / `POST /api/cloud/cell-share`, without changing the column's
  schema-level audience; the generated mask view ORs it in.
- **Cutover in place** — `secureCloud()` / `POST /api/cloud/secure` turns an
  already-populated Postgres into a secured cloud (install RLS + own the existing
  rows), not only migrate-from-SQLite.
- The change-log is reconciled to one table (`__lattice_changelog`, Postgres-valid
  with a monotonic `seq`) and gains provenance columns (`source_ref`,
  `change_kind`, …); all of `insert`/`update`/`delete` accept provenance, and an
  AI enrichment stamps the source-set it was derived from instead of discarding it.
  The enrichment pass pins the cheapest model. See `docs/cloud.md`.

**Owner-set chat system prompt per workspace.** A cloud owner can set a chat
system prompt (in workspace settings) that's bundled into every member's assistant
chat for that cloud — injected into each member's system message alongside the live
schema. Owner-only to view and edit: it's stored in `__lattice_cloud_settings`
(reached via `SECURITY DEFINER` `lattice_get_cloud_setting` / `lattice_set_cloud_setting`,
the setter gated on `rolcreaterole`), the member group has no grant on the table, and
`GET /api/cloud/system-prompt` returns the text only to an owner. Secrecy is
**app-mediated** (hidden from the UI + API, not cryptographic — a member's own chat
must inject it, so a member who digs can read it); documented in `docs/cloud.md`. New
exports: `installCloudSettings`, `getCloudSetting`, `setCloudSetting`,
`CLOUD_SETTING_SYSTEM_PROMPT`. Postgres-only; no-op on local SQLite.

**S3-backed file bytes for cloud workspaces (opt-in, off by default).** When a
cloud enables S3, an uploaded file's bytes go to S3 in addition to the uploader's
local disk, so any member who can SELECT the `files` row can pull the bytes down
in the viewer. Previously the metadata row was shared via RLS but the bytes lived
only on the uploader's machine.

- **No new access machinery — it rides the `files`-row RLS.** The serve route's
  `db.get('files', id)` runs as the member's scoped role; a member only ever
  learns an object's (content-addressed) key for a row RLS lets them SELECT. IAM
  is `GetObject`+`PutObject` only — **no `ListBucket`, no `Delete`** — so the key
  is the only handle, and the RLS row is the only place it appears.
- **Per-member, machine-local credentials.** S3 config is stored AES-GCM-encrypted
  on each member's machine (the `db-credentials.enc` store), never in the shared
  DB; env-var fallback (`LATTICE_S3_BUCKET`/`_REGION`/`_PREFIX`/`_ENDPOINT` + the
  standard `AWS_*` chain) for headless/CI. Owner-only `GET`/`POST
/api/cloud/s3-config` (secret redacted on read).
- **Hybrid copy.** The uploader keeps the local blob (instant local preview); every
  other member streams from S3. Content-addressed key `<prefix>/<sha256>`;
  idempotent put. Reuses the existing reference model (`ref_kind='cloud_ref'`,
  `ref_provider='s3'`, `ref_uri='s3://<bucket>/<key>'`, `source_json`) — **no schema
  migration**.
- `@aws-sdk/client-s3` is an **optional dependency, lazy-imported** like `sharp`:
  absent SDK throws a typed `S3UnavailableError` and uploads fall back to local-only
  (never 500). `forcePathStyle` when a custom `endpoint` is set (R2 / MinIO /
  LocalStack). New exports: `createS3Store`, `s3Key`, `S3UnavailableError`,
  `RemoteBlobStore`, `S3StoreConfig`, `resolveActiveS3Config`, `activeWorkspaceLabel`,
  `S3Config`, `mergeS3ConfigForSave`.
- **The local-only fallback is never silent.** A failed S3 PUT on an enabled cloud
  still succeeds locally but the upload response carries `s3: { status: 'failed',
error }` (a clean push returns `status: 'stored'`), so the uploader knows the bytes
  didn't reach the shared bucket and won't share a file other members would 404 on.
- **Serve hardening.** `/api/files/:id/blob` sends `X-Content-Type-Options: nosniff`
  and a no-allowances `Content-Security-Policy: sandbox`, since both the bytes and the
  row's `mime` are member-writable — without them a member could stage `text/html` in
  the shared bucket and have it execute in another member's GUI origin.
- **Security ceiling is documented, not hidden:** byte-access is app-mediated (not
  S3-enforced), revoking row visibility doesn't retract bytes a member already
  fetched, the shared credential is a single point of compromise, and there's no
  per-member S3 audit. See the S3 section + caveats in `docs/cloud.md`.

**Migration:** a direct `postgres://` connection string is no longer a Lattice
cloud connection — each user needs their own scoped role. Stand the cloud up by
migrating a local Lattice into a fresh Postgres (installs RLS + makes you owner),
then invite members; each member connects with their issued credentials. See
`docs/cloud.md`.

## [2.3.0] - 2026-06-11

### Fixed

- **Dropped documents now extract on every install — the parsers are no longer
  optional.** The native document parsers (`mammoth` for `.docx`, `unpdf` for PDF,
  `word-extractor` for legacy `.doc`, `fflate` for the OOXML/ODF/EPUB zip formats),
  the `file-type` sniffer, and the `@anthropic-ai/sdk` used to summarize and
  classify an ingested file were declared as `optionalDependencies`. Any install
  that omits optional dependencies — `npm install --omit=optional`,
  `npm ci --omit=optional`, a Docker layer that prunes them, or an optional native
  build such as `sharp` failing and taking the whole optional group down with it —
  silently shipped **without** them. A dragged `.docx`/PDF/spreadsheet then
  extracted nothing, produced no summary, and linked to nothing, with no error
  surfaced. The parsers and the SDK are now regular `dependencies`, present on
  every install, so document ingest works out of the box. `pg`, `playwright`, and
  `sharp` stay optional — a Postgres backend, browser crawling, and image
  down-scaling are genuinely opt-in and already degrade gracefully when absent.
- **A document parser that fails to load is now logged loudly** instead of
  silently degrading the file to an empty extraction. Because the parsers now ship
  as regular dependencies, an import failure means a broken or partial install and
  is reported on the console (the extractor still returns gracefully and never
  throws).

### Changed

- `@anthropic-ai/sdk`, `mammoth`, `unpdf`, `word-extractor`, `fflate`, and
  `file-type` moved from `optionalDependencies` to `dependencies`.

## [2.2.4] - 2026-06-11

### Fixed

- **Drag-and-drop ingest never fails on a required `files` column.** A `files`
  table that declares a column `NOT NULL` — a legacy schema, a customized table, or
  one synced from a cloud — now ingests cleanly instead of 500-ing (e.g. "NOT NULL
  constraint failed: files.path"). Ingest fills any required **text** column from
  the upload's filename. Detection is by **physical table introspection** (`PRAGMA
table_info` / `information_schema.columns`), so it reflects the actual table, not
  Lattice's declared schema, and fires only for columns the table genuinely
  requires: a nullable native `files.path` is left null, so a byte upload is still
  served from its retained blob rather than shadowed by a filename written into
  `path`. A non-browser/desktop client that knows the dropped file's real OS path
  may send it via an `x-filepath` header, which is then recorded as `path`.

## [2.2.3] - 2026-06-10

### Security / Breaking

- **A cloud is reachable only through a user-authenticated server.** A regular
  GUI pointed straight at a cloud's `postgres://` connection is now **refused**:
  a raw connection string can't tell members apart, so anyone holding it would
  read every table and row regardless of sharing. When the GUI detects a cloud
  (a database that hosts `__lattice_team_identity`) reached over a direct
  `postgres://` connection, it serves **no** team context and **no** tables, and
  prompts the operator to reconnect through a server (sign in as a user). The
  server is the single connection model and the security boundary — it holds the
  database connection and filters every member's sync so they only ever receive
  rows they're allowed to see; members never hold the connection string. The
  server process itself (`lattice serve --team-cloud`) is the sole legitimate
  direct holder of the connection. **Migration:** stand up a server in front of
  the cloud Postgres and have members reconnect via invite; the direct
  connection string is retired.
- Using Postgres as your **own**, single-user storage backend — a workspace with
  no team — is unaffected and keeps connecting directly.
- The GUI surfaces a `cloudReconnectRequired` state on `GET /api/dbconfig` and a
  notice in the UI when a workspace is on the refused direct path.

### Changed

- **Documents parse natively, with no external CLI.** Ingest no longer shells out
  to the optional `markitdown` Python CLI (a dragged document silently extracted
  nothing on any machine without it installed). Text is now extracted in-process
  for **PDF** (`unpdf` — a serverless pdf.js build, no native/canvas deps),
  **Word** (`.docx` via `mammoth`, legacy `.doc` via `word-extractor`),
  **PowerPoint** (`.pptx`), **Excel** (`.xlsx`), **OpenDocument**
  (`.odt`/`.ods`/`.odp`), **EPUB**, and **RTF** (the OOXML/ODF/EPUB formats via the
  tiny `fflate` zip reader; RTF via a built-in de-RTF). Scanned/image-only PDFs
  with no text layer still fall back to Claude's native PDF read. Every parser is
  a lazily-loaded **optional dependency**, so a format whose parser isn't
  installed degrades to a `skip` rather than failing, and core latticesql users
  who never ingest documents pull none of them.
  - Legacy **binary** `.xls` and `.ppt` (pre-2007 BIFF/PPT) have no clean,
    non-vulnerable pure-JS parser and are referenced + marked
    `extraction_status='skipped'`.
  - The `MARKITDOWN_BIN` env var is no longer read (removed from `.env.example`).
  - **Hardened against hostile documents.** All XML tag scanning is linear (no
    global lazy-quantifier regex, which is O(n²) on an unclosed-tag flood); the
    unzip step caps per-entry and aggregate decompressed size (zip-bomb guard);
    each extractor stops accumulating at the text cap; the PDF read has a timeout;
    and `/api/ingest/file` now enforces the same byte cap as the upload route.
  - **Extraction-quality fixes** in the native parsers: RTF strips `\*`
    destinations (hyperlink/bookmark/field metadata no longer leaks into text)
    and decodes `\'xx` as Windows-1252 (smart quotes, em dashes — not invisible
    C1 controls); PowerPoint/Word runs join within a paragraph without inserting
    spurious mid-word spaces; EPUB resolves percent-encoded spine hrefs (no more
    silently dropped chapters); XLSX preserves shared-string slots across a
    self-closing `<si/>` and strips CJK phonetic guides; ODS reads numeric cells
    stored only in `office:value`.

### Fixed

- **Drag-and-drop ingest no longer fails on a `files` table with a `NOT NULL`
  `name` (or `title`).** Ingest now fills `name` and `title` from the upload's
  filename on every new `files` row — the same auto-population already done for
  `slug`. They're written only where the table physically carries those columns
  (e.g. a cloud whose `files` table declares `name NOT NULL`) and harmlessly
  dropped for the native `files` entity, so an uploaded file never trips a
  `not null constraint failed: files.name` again.

## [2.2.2] - 2026-06-10

Team-cloud GUI hotfixes.

### Security

- **Unowned tables no longer leak to other members.** On a team cloud a table
  with no ownership record (created via raw SQL, or when a reconcile was
  skipped because the creator's identity didn't resolve) was visible to every
  member — `isVisibleInTeam` returned `true` for an undefined owner — while the
  Workspace Settings / Data Model graph labelled it "private" (it's not in the
  shared set). The visibility gate and the label now agree: an unowned, unshared
  table is visible only to the **cloud creator**, never to other members, so the
  "private" label is truthful. The creator's own data is not hidden, and
  explicitly-shared tables are unaffected.

### Fixed

- **Drag-and-drop ingest no longer fails on a `files` table with a `NOT NULL`
  slug.** Ingest now auto-derives a `slug` (from the filename, with a short
  unique suffix) on every new `files` row. It's populated only where the table
  physically carries a `slug` column — e.g. a cloud whose `files` table declares
  `slug NOT NULL` — and harmlessly dropped for the native `files` entity, fixing
  `not null constraint failed: files.slug` on Postgres-backed clouds without
  changing SQLite behaviour.
- **The Data Model share indicator recolours immediately.** Toggling a table's
  share status now rebuilds the schema graph, so the node's shared/private
  colour updates without a manual refresh.
- **The assistant knows who it's assisting.** The operator's display name (from
  `~/.lattice/identity.json`) is now included in the assistant's system prompt,
  so it addresses the user and resolves "me"/"my" instead of asking for a name.

### Changed

- **Breaking: the direct `postgres://` deprecation is now silent.** The GUI
  banner (and the connect-time console warning) shown for a grandfathered direct
  `postgres://` team connection have been removed, along with the `directCloud`
  field on `GET /api/dbconfig`. The deprecation itself is unchanged — **new**
  direct connections are still rejected at the register/redeem boundary; existing
  ones keep working without row-level security (network-isolate the cloud
  Postgres until you migrate). Documented here rather than surfaced at runtime.

## [2.2.1] - 2026-06-10

Hotfix for two regressions in the 2.2.0 row-level-permission work on team clouds.

### Security

- **Assistant chats are now isolated per member on a team cloud.** Chat threads
  and messages are stored in the shared cloud database, but the chat read routes
  queried them with no per-user filter — so a member could list and replay
  another member's assistant conversations (and the assistant's responses).
  `chat_threads` / `chat_messages` gain a nullable `owner_user_id` column
  (additively reconciled onto existing clouds, no migration needed); new chats
  are stamped with the creating member's cloud id; and every chat read
  (`GET /api/chat/threads`, `GET /api/chat/threads/:id/messages`, and the
  cross-turn history rehydration) filters by the operator's id when a team
  context is present. A thread can only be reused/replayed by its owner, so a
  guessed thread id can't be hijacked. Local single-user databases (no team
  context) are unaffected — chats with a NULL owner stay fully visible.

### Fixed

- **Composite (and `id`-less) primary keys no longer break row permissions.**
  The 2.2.0 row-permission read path keyed every row on the first primary-key
  column, defaulting to `id`. A table with no single `id` column — a
  composite-key junction table, or any table reached via raw SQL — hit the `id`
  fallback and the query emitted `CAST(t."id" AS TEXT)`, throwing
  `column "id" does not exist` and taking down `queryVisible`,
  `countVisibleMany`, and the dashboard with it; a registered composite table
  keyed only its first column, so rows sharing that column collided. The
  change-log + row-ACL key now encodes the **full** primary key (a single
  canonical serialization shared by the write and read paths), and a table with
  no Lattice-addressable key is treated as unkeyable (no per-row ACL; its rows
  follow the table default and never reference a missing column). Single-column
  keys are unchanged — existing data and behaviour are preserved.

## [2.2.0] - 2026-06-09

**Row-level permissions for Teams.** Sharing a table no longer means every
member sees every row. Each shared row now has an **owner** (its creator) and a
**visibility** — `private` (owner only), `everyone` (all members), or `custom`
(an explicit grant list) — enforced for the REST API, the AI assistant, and the
cloud sync itself, so a member never receives the bytes of a row they can't
read. Existing shared tables default to `everyone` on upgrade, so nothing
changes until an owner opts a table (or a row) into `private`.

**Security note.** Enforcement is **application-layer**, performed by the
hosted Teams server (and by each Lattice process for its own reads) — there
are no Postgres `CREATE POLICY` rules on the cloud database. Anyone holding a
SQL connection string to the cloud Postgres can read and write every row;
treat the database as the hosted server's private backend and network-isolate
it. Grandfathered direct `postgres://` team connections (see _Deprecated_)
bypass row-level security entirely.

### Added

- **Row visibility model.** New cloud-internal tables `__lattice_row_acl`
  (per-row owner + visibility) and `__lattice_row_grants` (custom grant list),
  plus `__lattice_shared_objects.default_row_visibility` (the visibility new
  rows are born with, table-owner-set). Installed + backfilled idempotently on
  both SQLite and Postgres via `installRowPermsSchema`.
- **`Lattice.queryVisible(table, opts)`** — an indexed, in-SQL, decrypt-reusing
  read that returns only the rows a given member may see in a team.
- **`Lattice.listChangesForRecipient(...)`** — the hosted change-log pull,
  filtered per recipient so the Teams server is a hard enforcement point.
- **`src/teams/row-access.ts`** — `resolveRowAcl` / `canAccessRow` /
  `isRowOwner` / `tableDefaultVisibility` / `listVisibleRows` and owner-gated
  `setRowVisibility` / `addRowGrant` / `removeRowGrant` /
  `setTableDefaultVisibility`, with typed `RowAccessError` (→ HTTP 404, hide
  existence) / `RowOwnerOnlyError` (→ HTTP 403).
- **GUI** — a per-row visibility eye on the table view (owner toggles
  everyone↔private; non-owner sees a faded status), a detail-view control, and
  a Data Model "new rows default to" select. New endpoints:
  `POST /api/tables/:t/rows/:id/visibility`, `POST`/`DELETE`
  `/api/tables/:t/rows/:id/grants`, and
  `POST /api/schema/entities/:name/default-row-visibility`.
- **GUI: grants checklist.** The detail view's visibility line grows a
  "Specific people…" / "Manage access" control — an owner-only member
  checklist wired to the grant endpoints, so `custom` visibility is fully
  manageable from the GUI. Switching a `custom` row to everyone/private now
  asks for confirmation first (the grant list is kept server-side and
  reapplies if the row returns to specific people).
- **GUI: direct-connection deprecation banner.** A workspace holding a
  grandfathered direct `postgres://` team connection shows a dismissible
  amber banner ("Direct database cloud connections are deprecated and don't
  support row-level security. Migrate to a hosted workspace."), driven by a
  new `directCloud` field on `GET /api/dbconfig`.

### Security

- **`GET /api/search` now applies the row ACL.** The REST search route
  returned full-text hits without the per-row post-filter the assistant's
  search tool already applied, so a member could read snippets of rows shared
  privately or with other members. Both paths now share one batched filter
  (`filterVisiblePks` — one ACL query + at most one grants query per table).
- **Dashboard counts no longer reveal invisible rows.** Entity tiles counted
  physical rows (`pg_class.reltuples` / exact COUNTs), telling a member that
  hidden rows exist and how many. In team mode the tiles now run the same
  visibility predicate as `Lattice.queryVisible`, aggregated into a single
  round-trip (`Lattice.countVisibleMany`, capped at 50 tables per pass), so
  counts always match what the rows view lists.

### Changed

- **Enforcement is wired into every path.** The REST row routes, the row
  mutation primitives, and the AI assistant's `list_rows` / `get_row` /
  `search` tools all honour the row ACL (the assistant previously bypassed it
  entirely). Denied reads return 404.
- **Hosted sync is per-recipient.** Linked rows record an ACL; the change-log
  pull is filtered per member; delete / unlink / member-kick now fan out a
  targeted `unlink` to each member who can see the row before tearing the ACL
  down (a broadcast unlink would be dropped by the new filter).
- **Dashboard counts (Postgres).** For the suspicious subset of tables whose
  approximate `pg_class.reltuples` reads 0 or is absent (under autovacuum's
  ANALYZE threshold), the dashboard now issues one aggregated exact-count
  round-trip — correcting the "tile shows 0 while drill-in shows rows" case
  without reintroducing a per-table fan-out. Capped at 50 tables (logged +
  skipped on overflow).
- **A cloud IS a workspace with members — no "convert to team" concept.**
  `TeamsClient.upgradeToTeamCloud(...)` is renamed to
  `TeamsClient.registerCloudOwner(...)` (same signature + behaviour: bootstraps
  the first member as owner, rejects direct `postgres://` per the deprecation
  below). The "upgrade/convert a cloud into a team" framing is gone from the API,
  the `--team-cloud` CLI help, and the docs — opening a cloud yourself connects
  you directly (eye-icon row permissions active); `lattice serve --team-cloud`
  is just the deployment role that hosts the cloud as a shared, auth-gated server
  for _remote_ members. **Breaking:** external callers of the old method name
  must update to `registerCloudOwner`.

### Deprecated

- **Direct `postgres://` team-cloud connections.** They can't enforce
  row-level security, so new direct connections are rejected with guidance to a
  hosted Teams server; existing direct connections keep working but warn on
  connect. Unrelated to using Postgres as a Lattice's own storage backend.

## [2.1.1] - 2026-06-09

**The assistant rail speaks in activity cards — and links to what it found.**
What the assistant did now shows as the same full-width activity cards as the
live feed — one card per action type, collapsed, and scoped to the conversation —
instead of inline tool-call pills. And when it points you at a specific record it
now renders a **clickable object pill** inline in its answer. The library API is
unchanged (GUI-only).

### Added

- **Inline object-link pills.** When the assistant references a specific row —
  e.g. you ask it to "link me to" or "open" a record — it emits an inline link
  (`[label](lattice://<table>/<id>)`) that renders as a clickable 🔗 pill and
  opens that object (mode-aware, the same navigator the activity feed uses). It's
  instructed to prefer the user-facing record over an internal `files` id and to
  only link ids it actually retrieved.

### Changed

- **One unified activity-card style across the rail.** The assistant's actions
  render as the activity-feed card (operation icon + human summary), not the
  separate inline pill chips. Cards **collapse by type even across different
  objects** — a bulk run shows a single card ("Deleted 19 tables", "Removed 49
  rows across 9 tables") instead of dozens of near-identical rows. Read-only tool
  calls (list / get / search) change no data, so they produce no card.
- **The activity feed is per-conversation.** Each assistant turn persists the
  data-change events it produced; reopening a conversation replays them as the
  same collapsed cards. The global last-20 audit backfill on stream connect is
  removed — the feed SSE now carries new events only, and history comes from the
  conversation it belongs to.

### Fixed

- **Persisted / reloaded schema events now collapse and show the 🛠 icon.** The
  live feed publishes `op: 'schema'` while the audit-sourced replay used the
  fine-grained `op: 'schema.delete_entity'`; the rail matched only the former, so
  reloaded schema deletes neither grouped nor picked an icon (they showed a bare
  "•"). Both forms are normalized now.
- **The typing indicator stays pinned to the bottom.** Activity cards that stream
  in mid-turn now insert above the assistant's "typing…" bubble instead of below
  it, so the dots no longer appear in the middle of a reply.
- **Activity cards show the task DURATION, not a relative "ago".** Each card now
  reads how long its work took ("4s", "4m 2s") — start-to-finish for a single
  action, first-start to last-finish for a grouped run — anchored to the turn's
  start (persisted per-event timestamps + turn start, so a reloaded conversation
  shows the same durations as the live stream).
- **A long bulk run no longer splits into several cards.** Live grouping is now
  scoped to the assistant turn (no fixed time window) instead of a 15s rolling
  window, so deleting many tables against a remote DB collapses into one
  "Deleted N tables" card even when the run takes longer than the old window —
  the lone leftover delete that escaped the group is gone.
- **Switching to a cloud workspace shows the spinner until it's done.** The
  switch menu used to close right after the (fast) switch POST and run the slow
  cloud connect/reload with no visible feedback (it looked frozen); the menu now
  stays open with the item's spinner through the whole reload, matching the local
  switch.
- **The settings of a cloud workspace you're connected to no longer ask for an
  invite token.** Workspace settings could show a "not a member yet — paste an
  invite token" state for a cloud workspace you'd already joined (or created).
  That state is impossible — you can't reach a team cloud without an invite, so a
  live connection always implies membership — and it has been removed. Joining via
  invite lives only in the Join Workspace flow; settings always shows the
  connection details and members.
- **Encrypted secret values render as the mask, not raw ciphertext.** A value
  stored encrypted-at-rest (the native `secrets` table, etc., carrying the `enc:`
  sentinel prefix) showed its raw `enc:…` ciphertext in table and detail views.
  It now renders as •••••••• like any other masked secret, everywhere a cell value
  is shown.

### Changed (settings)

- **Assistant settings are decluttered.** The voice section now shows a single
  **Use for voice** provider dropdown ("Select provider…", "OpenAI",
  "ElevenLabs") and reveals only the chosen provider's key field, instead of
  listing every provider's key box at once. Removed the redundant
  "keys are stored encrypted… also work" helper paragraph and the
  "set the `ANTHROPIC_OAUTH_*` env vars to enable" hint (the subscription link
  only appears when OAuth is actually configured).

## [2.1.0] - 2026-06-08

**Assistant search + a guarded, reversible table delete — and a batch of GUI
fixes.** The `lattice gui` search box now hands your query to the assistant
(which answers using its search/read tools) instead of running a plain text
match, the assistant gains a safe `delete_entity` tool, and the activity feed,
voice notes, uploads, and live counts get a round of polish. The library API is
additive and backwards-compatible.

### Added

- **The search box asks the assistant.** Typing a query and pressing Enter sends
  it to the assistant rail, which answers conversationally using a re-added
  full-text `search` tool (it never sees the conversation-storage or secret
  tables). The old as-you-type dropdown is retired.
- **Reversible, guarded table delete via the assistant (`delete_entity`).** The
  assistant can delete a table on request, with safeguards so a careless prompt
  can't destroy data: built-in tables are refused, tables another table links to
  are refused, an **empty** table is soft-deleted immediately, and a **non-empty**
  table is **not** deleted until you decide what to do with the data — the tool
  reports the row count and asks, then you choose to delete the rows too
  (soft, reversible) or move them into another table first. Every step is audited
  and revertible from history; the physical table + rows are kept (no hard drop).
- **AI-generated chat thread titles.** A new conversation is named from a short
  AI summary of its first exchange (e.g. "Adding New Notes About Cheese") instead
  of a truncated copy of your first message.
- **`Lattice.unregisterTable(name)`** — the inverse of `defineLate()`. Removes a
  runtime-registered table from the live schema registry without a reopen (and
  without touching the physical table), so the GUI's soft delete no longer has to
  dispose + rebuild the connection. Library-additive.

### Fixed

- **The ingest pipeline no longer swallows server-side errors (Rule: no silent
  failures).** A failed file enrichment used to bubble to a generic 500 with
  nothing logged — the real cause flashed in a toast and vanished. Failures are
  now logged to stderr with their stack, recorded durably on the file row
  (`extraction_status='enrichment_failed'`), and surfaced to the client; the
  top-level GUI request handler logs any unhandled error before responding.
- **The data-model graph no longer shows internal conversation tables.** The
  `chat_threads` / `chat_messages` storage was already hidden from the Objects
  list and sidebar but still drawn in the Data Model visualization; it's now
  filtered there too (single source of truth: `isInternalNativeEntity`).
- **Conversation tables are browsable under "System".** `chat_messages` /
  `chat_threads` now appear in the Advanced → System list and open read-only,
  instead of routing to "Unknown entity".
- **Search no longer returns conversation messages or secrets.** The full-text
  search endpoint excludes the assistant's own storage + the secrets table.
- **Voice notes don't desync the composer.** While recording/transcribing, the
  text box is read-only with a "Listening… / Transcribing…" placeholder and the
  Send button is disabled; the transcript drops in when you stop.
- **File-upload progress shows real elapsed time** instead of a stuck "0s".
- **The activity feed groups identical events even when interleaved.** A burst of
  the same op on the same table collapses into one counted bubble within a short
  window, not just for strictly consecutive events.
- **Home counts and the open entity view update live.** Any insert/update/delete
  now refreshes the dashboard counts and the current table without a manual page
  reload (previously only schema changes did, and only on the cloud path).
- **More spacing above the sidebar "SYSTEM" heading.**

### Changed

- **Voice-provider preference and inference aggressiveness are user settings, not
  workspace secrets.** They moved out of the workspace `secrets` table into
  machine-local `preferences.json`, so they persist across workspaces, stop
  appearing in the Secrets object, and aren't visible on a shared cloud database.
  Legacy rows are retired automatically on the next open.

## [2.0.0] - 2026-06-04

**The AI assistant arrives.** `lattice gui` gains a built-in assistant rail — a
**Context Constructor** that turns dropped files and pasted text into linked
Lattice objects. The library API is unchanged and fully backwards-compatible:
the assistant is GUI-only and completely inert until credentials are configured,
so a bare `new Lattice(path)` / Postgres-URL consumer and the headless
`render`/`generate`/`reconcile`/`watch` commands are unaffected. The major
version marks the new product surface (and the workspace-architecture line that
shipped across 1.16.x), not a breaking change.

### Added

- **The assistant remembers what it read across turns.** Prior tool calls and
  their results (row ids included) are replayed into the model's context, so a
  follow-up like "now update that row" reuses the id it just listed instead of
  guessing one. Replay is bounded to the recent turns within a size budget and is
  secret-redacted; set `LATTICE_CHAT_REHYDRATE=false` to disable it. The
  assistant's `list_rows` is now deterministically ordered (by `created_at`, else
  the primary key), so listing the same table twice returns the same rows instead
  of conflicting values.
- **AI library surface (`import { … } from 'latticesql'`).** A first-class,
  GUI-independent AI API — inert without an LLM client: `organizeSource` (sort a
  source into your own schema: summarize + classify + link, creating a new
  object only when nothing fits), `describeImage` (image vision), `crawlUrl`
  (SSRF-guarded URL fetch + readable-text extraction), `enrichKnowledge`, plus
  the `summarizeText`/`classifyLinks` primitives and `LlmClient` types. New
  optional deps: `sharp` + `file-type` (lazy-loaded); `jsdom` + `@mozilla/readability`.
- **Assistant rail (chat + activity feed).** A resizable sidebar (mobile
  bottom-drawer) with a Claude tool-calling chat loop streamed over SSE
  (`POST /api/chat`) and a live activity feed (`GET /api/feed/stream`). Every
  assistant edit flows through the same audited, undoable mutation chokepoint as
  a manual edit — so it lands in the version history and can be reverted.
- **Context Constructor — drag-drop / click-upload / paste ingest.** Drop files
  on the rail (or use the paperclip) and they're referenced as native `files`
  rows (not copied), **extracted** (text via optional `markitdown` for PDFs/Office;
  **images via Claude vision**; a pasted **URL is crawled** for readable text and
  the source URL preserved), summarized with **Claude Haiku**, and classified
  against your existing records. Then, all reversible: **add** the source object,
  **enrich** its description, **link** it to related records —
  **auto-creating the junction table when none exists yet** — and, when a source
  fits nothing and aggressiveness is high, **auto-create a new object** for it.
- **"Connect Claude" + subscription OAuth.** Encrypted API-key storage in the
  native `secrets` entity (env-var fallback: `ANTHROPIC_API_KEY`). A standard
  Authorization-Code + PKCE flow for connecting a Claude subscription is built
  and unit-tested; it stays hidden until the `ANTHROPIC_OAUTH_*` env vars are
  configured.
- **Inference Aggressiveness control.** A single behaviour slider
  (Conservative ↔ Aggressive, `PUT /api/assistant/aggressiveness`) that drives
  the model sampling temperature, how liberally the classifier proposes links,
  and whether ingest auto-creates a missing junction (gated ≥ 0.25) vs. suggests it.
- **Native chat entities.** `chat_threads` + `chat_messages` persist conversations
  across sessions; the rail has a thread switcher.
- **Voice input.** Optional speech-to-text via OpenAI Whisper or ElevenLabs
  (`OPENAI_API_KEY` / `ELEVENLABS_API_KEY`), with an explicit provider choice.
- **Processing feedback.** A transient "Analyzing…" spinner row appears while a
  dropped file ingests; the real add/enrich/link events stream in over SSE.

### Notes

- **Cloud:** the assistant runs against local SQLite and a direct
  `postgres://` connection (single-user). The full parity loop — ingest →
  auto-junction → link — is covered by a Postgres-gated integration test. The
  assistant rail is **not** mounted in hosted multiplayer team-cloud mode yet
  (gated behind `!teamCloud`); that lands in a follow-up.
- `markitdown` is an **optional external CLI** (`MARKITDOWN_BIN`); without it,
  PDFs/Office files are referenced and marked `extraction_status='skipped'`.

### Security

- **The chat assistant can no longer read decrypted column secrets.** Its
  `list_rows` / `get_row` tools now redact any column marked secret (via
  `set_column_secret`, recorded in `_lattice_gui_column_meta`) before the row
  reaches the model — mirroring the redaction the HTTP row-context endpoint
  already did. Previously a `password`/`api_key` column on a user table would be
  returned in cleartext (the `secrets` table itself was already hidden).
- **The assistant can no longer touch its own conversation storage.**
  `chat_threads` / `chat_messages` join `secrets` in the assistant's hidden-table
  set, so the model can't `list`/`read`/`update`/`delete` them — closing a
  prompt-injection path to erasing or rewriting chat history. (`files`/`notes`
  stay editable — they're audited + reversible.)

### Internal

- **The data-model editor's create-table / create-relationship endpoints now
  use the same no-reopen primitives as the chat and ingest paths**
  (`createUserEntity` / `materializeJunction`). One creation path instead of
  two: the REST handlers no longer reopen the whole database, and table DDL +
  canonical-context registration + audit live in one place. The editor's typed
  name is preserved (a `normalize:false` opt-out), and team-owner recording
  moves to a post-create step (no reopen ⇒ no reconcile race to beat).
- **Consolidated duplicated GUI internals** (no behaviour change): one
  `feedSummary` now serves both the live feed and the audit-log backfill (was
  two copies); `createFileJunction` / `createUserJunction` share a single
  `materializeJunction` core; the GUI `summarize` module re-exports the
  library's `parseObjects`/`parseMatches` + shared types instead of duplicating
  them; the config-document + DDL IO helpers (`execSql` / `loadConfigDoc` /
  `saveConfigDoc`) moved out of the request dispatcher into `gui/config-io.ts`;
  and a parity test pins the `rowLabel` ↔ `fsDisplayName` contract so the server
  and client label logic can't silently drift.
- **Schema-op primitives extracted into `gui/schema-ops.ts`** (pure mechanical
  move, no behaviour change): physical-table introspection
  (`physicalTableExists` / `physicalColumnExists`), the audited + revertible
  `recordSchemaOp` (+ cloud `emitDdlEnvelope`), canonical-context (re)derivation,
  and the entity/junction creators (`createUserEntity` / `createUserJunction` /
  `createFileJunction` / `materializeJunction`) now live in one module that
  `server.ts` re-imports. The creation path is no longer interleaved with HTTP
  routing and is independently testable; `server.ts` shrank ~350 lines. `ActiveDb`
  is a type-only import in the new module (the runtime edge is server → schema-ops
  only, so there is no import cycle).

### Performance

- **The workspace config is no longer re-parsed on every `/api/entities`
  call.** A small mtime+size-keyed cache in `loadGuiData` means a bulk operation
  and its activity-feed refetches parse the YAML once, not dozens of times; a
  config write (which bumps the mtime/size) or a workspace switch invalidates it
  automatically.

### Fixed

- **GUI assistant + workspace polish.** Repeated tool pills collapse into one
  counted pill ("Listed N rows"); the composer textarea wraps + auto-grows and
  tracks the rail width, and assistant replies render Markdown. The activity
  cards show relative timestamps ("3 days ago") with no "stale" flag. Internal
  conversation tables (`chat_threads` / `chat_messages`) are hidden from the
  Objects list (still queryable). Workspace display names accept special
  characters (the on-disk slug is derived from them). The microphone button is
  disabled with a tooltip when no input device is present; all blocking `alert()`
  dialogs are now inline toasts; and token / secret inputs opt out of
  password-manager popups. The header workspace switcher no longer desyncs from
  the served database — it tracks the open workspace and reconciles the registry
  at boot. A missing-row `update` / `delete` now fails loudly instead of
  recording a phantom-success audit entry.
- **A bulk chat task that hits the tool-step limit now says so.** When the
  assistant reaches its per-message tool-call cap with work outstanding (e.g.
  "create one row per line of a 150-row CSV"), it emits a warning ("…the task
  may be incomplete. Send 'continue' and I'll finish the rest.") instead of
  ending with a clean "done" that looked complete (no silent
  truncation).
- **Adding a relationship now updates the linked tables' context immediately.**
  A new junction's rollup now appears on the EXISTING tables it links without a
  reopen — `syncCanonicalContexts` re-derives every canonical context (via a new
  overwrite-capable `redefineEntityContext`), not only the brand-new table.
- **Chat-rail robustness:** a `loadThread` response is discarded if a newer load
  superseded it (no more clobbered conversation on a fast refresh + switch), and
  the bubble-text setter guards against a finalized/detached bubble.
- **Activity cards no longer vanish when a conversation loads.** The chat and
  the activity feed share the rail, and loading a conversation reset the whole
  rail — so auto-loading the most recent thread on refresh wiped the backfilled
  activity cards. Clearing a conversation now removes only its chat bubbles; the
  workspace-global activity cards persist (and a workspace switch explicitly
  resets them + reconnects the feed to the new workspace).
- **The activity rail collapses repeated events.** A run of identical mutations
  (same op + table) — e.g. linking 20 rows during a bulk operation — now folds
  into a single bubble with a count ("Linked 20 rows in people_projects")
  instead of 20 near-identical rows. The run breaks when a different event or a
  chat message lands, so distinct actions stay separate.
- **Assistant chat rail polish.** Four fixes to the conversation experience:
  (1) an animated **typing indicator** now shows in the assistant bubble while a
  turn is generating (and a turn that ends with only tool calls no longer leaves
  a dangling empty bubble); (2) **conversations reload with their rich
  structure** — the per-turn text bubbles + tool pills are persisted and
  replayed, instead of collapsing to one wall of concatenated text; (3) the
  **most recent conversation auto-loads** on page refresh, so history isn't lost;
  (4) the **conversation dropdown is tied to the active workspace** — switching
  workspaces now resets and reloads the thread list (conversations live in the
  workspace DB).
- **Runtime-created tables now render their context automatically — creation and
  "make it renderable" are one step.** When the chat assistant or the Context
  Constructor creates a table at runtime (no DB reopen), it now registers the
  table's canonical entity context inline — on both the Lattice schema (so
  auto-render writes the markdown) and the GUI's row-context snapshot (so the
  view can find it). Previously only the data-model editor (which fully reopens
  the DB) re-derived contexts, so a chat/ingest-created entity showed "No
  rendered context for this row" until a manual page reload. The context
  registration is best-effort and never fails the creation itself. Also:
  `create_entity` now normalizes a natural name ("People" → `people`) instead of
  silently rejecting it.
- **Assistant API keys are now machine-level, not per-workspace.** The Claude /
  OpenAI / ElevenLabs keys (and the Claude subscription OAuth token) moved out of
  each workspace's database into a machine-local encrypted store
  (`<config>/assistant-credentials.enc`, AES-GCM under the master key, the same
  scheme as `db-credentials.enc`). Creating or switching a workspace no longer
  "de-attaches" the key — a key is a property of the user + machine, not of one
  database. A key saved in a workspace before this change is read back (and
  promoted to the machine store) for backward compatibility — but that
  back-compat read + promotion runs ONLY for a local SQLite workspace, never for
  a shared team-cloud / direct-Postgres `secrets` table (which may hold another
  member's credential row), so it can't harvest someone else's key. The OAuth
  callback that first connects a Claude subscription also writes machine-level,
  matching the refresh + API-key paths.
- **The assistant chat can now create tables and relationships on request.** It
  previously refused ("there is no projects table… I cannot create it") because
  schema mutations were excluded from its toolset. It now has `create_entity`
  and `create_relationship` (a many-to-many junction between two tables), wired
  to the same audited, **no-reopen, reversible** primitives the Context
  Constructor uses — so "create projects from tickets and link them" works end
  to end. `list_entities` also no longer reveals the `secrets` table.
- **The assistant chat now knows your schema, so it stops guessing.** Each turn
  the system prompt is built with the live table list (names, columns, row
  counts) plus guidance that an attached file's content lives in its `files`
  row's `extracted_text` column. Previously the model received no schema context
  and blindly guessed table names — producing "Unknown table" → "Could not fetch
  row" / "Could not list rows" errors — and, because persisted history is
  text-only, lost that context every turn. The prompt now also tells the model
  not to claim success after a failed tool call. The tool-loop + output budget
  (`MAX_TOOL_LOOPS` 8→16, `MAX_TOKENS` 2048→4096) were raised so multi-step bulk
  work (e.g. "create one row per line of an attached CSV") isn't truncated.
  _(Capacity tuning, not a workaround.)_ The
  credential-bearing `secrets` table is now hidden from the assistant entirely —
  excluded from its callable tables and from the schema context — so a request
  (or instructions injected via an attached file) can't induce it to read and
  spill decrypted API keys / OAuth tokens.
- **Auto-created objects now have human-readable names.** The Context
  Constructor gives every inferred entity a leading `name` column and fills it
  with the object's extracted label, so a card reads "Acme Consulting Agreement"
  instead of a bare `#fea4b07f`. Activity-feed bubbles are named to match —
  "Added Acme Consulting Agreement to consulting_agreements" rather than "Added
  a row to …" — both live and when the rail backfills from the audit log on
  reload. Rows with no conventional label column fall back to their first
  meaningful cell value (the same logic drives the card title and the bubble).
- **New objects from the Context Constructor now appear in the sidebar live.**
  When ingest inferred a brand-new entity, the nav list stayed stale until a
  manual page reload — and routing to the new object showed "Unknown entity".
  The activity-feed stream now triggers a live entity-list refresh on a `schema`
  event, so an inferred table shows up in the sidebar the moment it's created.
- **The activity feed no longer goes silent after a data-model edit.** Creating
  an entity, adding/renaming a column, or sharing a table re-opens the workspace
  to pick up the new definitions; that reopen used to swap out the in-process
  feed bus and orphan every connected `/api/feed/stream` subscriber, killing the
  rail (and the live sidebar refresh) for the rest of the session. The feed bus
  is now preserved across a same-config reopen.

## [1.16.5] - 2026-06-08

### Added

- **`renderSkipsEmpty` option** (`LatticeOptions`, default `false`). When enabled,
  `render()` skips both the full-table read **and** the file write for tables
  registered without a `render` spec — those compile to a no-op that would only
  emit an empty `.schema-only/<table>.md`. Previously `render()` read every
  registered table off the wire (a full `SELECT *`) before discovering the
  render produced nothing, which is wasteful for databases with large tables.
  Default-off preserves the original behavior exactly (the table is still
  scanned and an empty schema-only file written); tables with an explicit
  `render`/`outputFile` are unaffected either way. Internally, spec-less tables
  now share a single `NOOP_RENDER` sentinel so the render engine can
  identity-detect them.

### Fixed

- Corrected the legal entity name punctuation in `NOTICE`.

## [1.16.4] - 2026-06-02

GUI patch. **One model: a workspace _is_ a Lattice DB.** Removes the
"database mode" duality — there is no longer a separate config-file switcher
that appears only when the GUI is opened outside a `.lattice` root. Every
install the GUI opens now has a `.lattice` root, and every database (local or
cloud, created or joined) is a single switchable **workspace**. No library API
changes — a bare `new Lattice(path)` / Postgres-URL consumer and the headless
`render`/`generate`/`reconcile`/`watch` commands are unaffected (they keep
working with no root).

### Changed

- **Single workspace switcher.** The header now shows exactly one switcher,
  backed by the workspace registry (`/api/workspaces`). The legacy second
  "database" switcher and the no-root "database mode" fallback are gone.
- **The "+ New workspace…" button always opens the create/join wizard**
  (New local / New cloud / Join existing cloud), replacing the old inline
  local-only name form.
- **The GUI ensures a `.lattice` root on launch** (`ensureRootForGui`): when
  opened against a bare config with no root, it creates a root in place and
  **adopts the existing config + database non-destructively** (referenced where
  they already live — no files moved), then opens it as the active workspace.
- **Settings → Lattice lists the workspace registry** — the exact same list as
  the header switcher (previously a divergent filesystem scan).
- **Terminology:** "workspace" is the user-facing term everywhere; "database" is
  reserved for a specific DB's connection details (the connection panel in
  Workspace Settings).
- **Two cloud operations only: migrate to a cloud, or join a team via invite.**
  The standalone "Connect to existing cloud" (join-a-cloud-on-its-own) path is
  removed — its modal/UI is deleted. The create wizard's third option is renamed
  from "Join existing cloud (invite)" to **"Join a team (invite)"** and the
  "join an existing cloud / join via cloud invite" wording is gone. Joining via
  invite is unchanged.

### Added

- **Cloud workspaces are registered in the workspace registry**, so they appear
  in the header switcher and are switchable: on **join** (invite), on **create
  cloud** (wizard), and on **migrate-to-cloud / connect-existing** (the active
  local workspace flips to cloud in place, same id).
- **Boot-time reconciliation** imports stray sibling configs — including
  previously-joined team configs written by an older binary — into the registry
  so already-joined cloud workspaces become visible/switchable.
- **`POST /api/workspaces/delete`** — registry-aware deletion (switches away if
  active; removes the scaffolded folder for a local workspace; for a cloud
  workspace forgets only the local pointer + unused credential, never the shared
  remote DB).
- **Share tables when inviting a member.** The "Invite member" modal again lists
  the workspace's tables with checkboxes, **all checked by default** — generating
  the invite shares the checked tables with the new member in one step. Uncheck
  any to keep them private.

### Fixed

- **Shared tables were invisible to members.** On a direct-Postgres team every
  member shares the same physical Postgres, so a shared table always physically
  exists for the member — but `applySchemaSpec` only registered (`defineLate`) a
  table when it did NOT physically exist, so the member's Lattice never learned
  about the shared table and `/api/entities` returned empty ("ask the owner to
  share a table with you") even after the owner shared it. Now an existing shared
  table is registered too (idempotent, non-destructive), and `openConfig`
  re-captures the live registered set after the team schema auto-sync so the
  table reaches `validTables`/the dashboard. Regression test added.

- **Joined cloud workspaces were invisible in the header switcher** and could
  not be switched to: `handleJoin` saved a credential + sibling config but never
  registered a workspace, so the header (registry-backed) and Settings
  (scan-backed) showed different lists. Both now read the one registry; joining
  registers a workspace and auto-switches to it. Leaving/kicking removes the
  registry record.
- **Renaming a workspace now updates the header switcher** — the rename is
  mirrored into the registry's display name (previously only the YAML/team name
  changed, which the registry-backed switcher didn't read).
- **"New cloud (Postgres)" works for Postgres URLs.** Creating a cloud workspace
  in the wizard previously errored (`Request cannot be constructed from a URL
that includes credentials`) because it used the HTTP `/api/auth/register`
  path. It now initializes the cloud directly via Postgres
  (`registerDirectViaPostgres`), and the wizard switches into the new cloud
  workspace so starter entities land there.
- **Deleting a cloud workspace is owner-only** (via `/api/workspaces/delete`) —
  only the team owner may delete a cloud Lattice DB workspace; a member who
  wants to drop their local copy uses "Leave workspace" instead.

### Notes

- The dead `renderDatabasesPanel` + `showConnectExistingModal` (the removed
  connect-to-raw-cloud UI) were deleted. One now-unused GUI helper
  (`showCreateTeamModal`) and the now-unused
  `POST /api/databases/{switch,create,delete}` server endpoints remain in place
  (dead, not reachable from the UI) and are slated for removal in a follow-up
  cleanup.

## [1.16.3] - 2026-06-02

GUI patch (live cloud-sharing demo + UI review). No library API changes — a bare
`new Lattice(path)` consumer is unaffected. The headline change is conceptual: a
**cloud database is simply a cloud workspace with members** — the separate "team"
concept is retired from the user experience (the underlying member/share plumbing
is unchanged and now initializes automatically).

### Added

- **Data Model graph shows share status.** On a cloud workspace, each entity node is
  outlined by visibility — **yellow = shared with the workspace, red = private (owner-only),
  green = selected** — with a legend. Local (single-user) databases are uncolored (share
  status is N/A). The owner can toggle a table's sharing from the entity editor; non-owners
  see read-only status.
- **Pending invitations in the member list.** Cloud-workspace settings now list people who
  were invited but haven't joined yet (with an "invited"/"expired" tag), below the active
  members. Backed by a new member-only `GET /api/teams/:id/invitations` (and its GUI proxy).

### Fixed

- **Inline editor no longer corrupts long-form fields.** Clicking into and back out of a
  multi-line field (e.g. `bio`, `description`, `notes`) used to silently rewrite it and
  re-render it as oversized text. Root cause: the inline editor returned a single-line
  `<input>` for long-form columns outside a small hardcoded set; focusing it stripped the
  newlines, so a no-op click+blur looked like an edit and fired a spurious `PATCH`. Every
  long-form field (and any value containing a newline) now opens a `<textarea>`, so an
  unedited field is never written and edits round-trip losslessly.
- **Cloud sharing now persists.** Migrating to / connecting to a cloud database left it
  without the member/share machinery, so "share this table" had nowhere to record the share
  and invitees saw nothing. Cloud databases now initialize that machinery automatically
  (see _Changed_), so per-table sharing writes and propagates to every member as intended.
- **Settings re-render after deleting the active database.** Deleting the active workspace
  from its Danger Zone now re-renders settings to the new active workspace (or closes the
  drawer) instead of leaving a stale view of the deleted one.

### Changed

- **A cloud database is a cloud workspace — the "team" step is gone.** The separate
  "Upgrade to team cloud" action has been removed; a database becomes a shareable cloud
  workspace the moment you migrate or connect it to Postgres, and its member/share
  machinery is created automatically (the workspace name is used as the identity; an
  existing un-initialized cloud initializes on open, with the opener as owner). All
  user-facing "team" wording is now "cloud workspace" / "member". The `cloud-connected`
  intermediate state was collapsed, and `POST /api/dbconfig/upgrade-to-team` was removed.
- **Create new objects on a dedicated page, not a modal.** The simple-view "New" tile now
  navigates to an inline create view (`#/fs/<table>/new`) styled like the object page,
  rather than opening a modal.
- **"Database" → "Workspace" in the UI.** New Workspace, Workspace Settings, Delete
  Workspace. The inner **Database connection** box keeps its name (it is literally the DB
  connection).
- **Generic empty-state copy.** An empty database now reads "This workspace is empty" with
  guidance to create an entity (or, on a cloud workspace, ask the owner to share one),
  instead of advice to edit a config file that a joined member can't act on.
- **New databases start empty.** A freshly created workspace no longer ships a starter
  `items` entity; its `entities:` map is empty.

### Removed

- **The per-row Delete button + "Action" column** from the Lattice/Workspaces settings
  list. Rows remain click-to-switch; deleting a workspace lives in that workspace's
  Settings → Danger Zone.

## [1.16.2] - 2026-06-02

GUI bug-fix + cloud-settings patch (1.16.1 demo follow-up). No library API changes —
a bare `new Lattice(path)` consumer is unaffected.

### Fixed

- **Version History no longer shows "Invalid Date".** The `_lattice_gui_audit.ts` column relied on a SQLite-only `strftime(...)` DEFAULT, so on the Postgres/cloud path it wasn't a parseable ISO string. `appendAudit` + `recordSchemaAudit` now set `ts` explicitly to `new Date().toISOString()` at insert (mirroring `client_ts`), and the client `formatTs` guards against an invalid value. Works on both adapters.
- **An already-joined member of a team cloud is no longer shown the "paste invite token" panel.** `resolveTeamContext` left `myUserId` empty when neither the mirrored identity email nor a saved connection resolved the cloud user-id, so membership read as false (→ `team-cloud-needs-invite`). It now falls back to resolving membership directly — matching a live `__lattice_team_members` row to the local identity email, or treating a saved redeemed connection as proof of membership — so a member correctly renders as `team-cloud-member`.

### Changed

- **Cloud Database settings — members + Danger Zone.** The owner's invite flow now also shows the cloud **connection string with the password redacted** (`postgres://user:****@host:port/db`) alongside the one-time token, so an invitee gets everything they need. Membership-exit actions moved out of the member-row list into a dedicated **Danger Zone**: **Disconnect** (owner — disconnects the database from the cloud, kicking all members) and **Leave** (member — removes only you; the cloud DB keeps running). The members list keeps per-row **Kick** for the owner.
- **Simple (file-system) view: create new objects in place.** A "**New**" tile (folder box with a +) opens a create form styled like the object page — blank fields for intrinsic + foreign-key columns, plus a select-menu + "+ Add another" for each many-to-many link. Reuses the existing field renderer and the row-create + `/link` endpoints (no new backend).
- **Lattice/Databases settings: click a row to switch.** The whole (inactive) database row is now clickable to switch; the per-row "Switch" button was removed. Delete stays (and no longer triggers a switch).

### Removed

- **The "Recent Activity" section on the dashboard homepage** — redundant with Version History. The `/api/dashboard` payload no longer computes or returns `recent`.

## [1.16.1] - 2026-06-02

GUI bug-fix + polish patch from the 1.16.0 demo. No library API changes — a bare
`new Lattice(path)` consumer is unaffected.

### Fixed

- **Redo no longer reports "Nothing to redo" after an undo.** Undo/redo _actions_ are session-scoped (they replay only your own edits, not other clients'/processes'), but `GET /api/history` computed the toolbar's `canUndo`/`canRedo` over _all_ sessions — so undone entries left by a previous server process lit up ↷ for a fresh session that had nothing of its own to redo. The gate counts are now session-scoped to match the actions; the history _list_ and per-entry **Revert** stay global.
- **Editing a column on a built-in entity (`notes` / `files` / `secrets`) no longer corrupts the schema.** These framework entities aren't in the YAML `entities:` map, so rename/add-column ran `ALTER TABLE` and then threw on the config write ("expected YAML collection …"), leaving the physical schema ahead of the config. Rename-column, add-column, and rename-table now **refuse built-in entities** (clear 400), **validate the config edit before touching SQL** (no physical/config drift, per Rules 15/16), and **reject duplicate target column names** with a friendly error instead of a raw adapter failure. The rename rebuilds the fields map by key rather than a deep `deleteIn`/`setIn`.
- **Inline cell edits that don't persist now fail loudly.** `updateRow` throws when a requested change leaves the row byte-identical (the signature of a read-only/blocked write), surfacing "Save failed" instead of a phantom "Updated". No false positives: genuine no-op edits and type-coerced values are recognized as unchanged.
- **"+ New workspace…" in the header switcher now opens the name input** instead of silently closing the menu. Clicking it replaced the menu's inner HTML, detaching the button, so the document click-outside closer (whose `contains(target)` test then failed) closed the menu. The handler now stops propagation, and the outside-click listener is attached once (it was re-added on every render).

### Changed

- **One-to-many links are labeled "→ one-to-many (legacy)"** in the Data Model editor (many-to-many junctions remain "↔ many-to-many"). New links are still created as M2M junctions; existing foreign-key (`belongsTo`) links keep working and rendering. Parsing a `ref:` field now emits a one-time deprecation warning — one-to-many `ref:` is slated for removal in 2.0 in favor of junctions.

### Removed

- **The standalone Activity rail** (right-hand live feed) — redundant with the Version History panel, which shows the same audited mutations with diffs and Revert. Multiplayer realtime convergence is unaffected (it runs on a separate realtime channel, not the activity feed); the server-side `/api/feed/stream` endpoint is retained.

## [1.16.0] - 2026-06-01

The stable 1.x line gains the domain-agnostic 2.0 features — the `.lattice`
workspace model + auto-render, full-text search, changelog history,
sources/references, a workspace dashboard, and a multiplayer cloud-editing
experience — with **no AI dependency**. (The AI assistant, chat, and ingest
summarization remain exclusive to the 2.0 line; 2.0 is this release plus that
AI layer.) A bare `new Lattice(path)` library consumer keeps a zero-overhead
`^1.x` contract: workspaces, FTS indexes, native entities, the changelog, and
all collaboration surface are opt-in or GUI-cloud-gated.

### Changed — GUI: Data Model, dashboard, auto-render, analytics copy

- **Data Model is an interactive force-directed schema graph** (vanilla SVG, no external lib): one node per table sized by row count, foreign-key (`belongsTo`) and many-to-many edges (junctions collapse into a single m2m edge rather than their own node). Drag to reposition, scroll to zoom (clamped so you can't zoom past the entities), drag the background to pan, click a node to open the entity editor.
- **Columns and links are edited separately, with no way to drop a table by accident.** The entity editor splits a table's fields into **Columns** (scalar data) and **Links** (foreign-key relationships):
  - **Columns:** system columns (`id` / `created_at` / `updated_at` / `deleted_at`) render read-only (name + type fixed). Editable scalar columns expose an inline name + a `secret` flag, staged behind **one "Save changes"** button. **Add column** offers only the scalar types `text` / `integer` / `real` / `boolean` (`uuid` is reserved for keys). Types display canonically (`text`, `uuid`, `datetime`) rather than the raw SQL column spec.
  - **Links:** read-only (`name → target`). Created via **"Add link"** (the FK column is named `<target>_id`); can't be edited once created, only **deleted individually** — and deleting a link drops _only_ that foreign-key column (`ALTER TABLE … DROP COLUMN`), never a table.
  - **Whole-table deletion is a separate, deliberate action.** A table is dropped only via a **"Delete table"** danger-zone button that requires typing the table name to confirm, and the server **refuses while any other table still links to it** (so a delete can't leave dangling references). This replaces the old per-table "Delete relationship" control.
  - **Backend-enforced** so a bad data model can't be created by hand: `POST …/entities/:t/columns` rejects system names, non-scalar types, and any `ref`; `…/columns/:c/rename` rejects system + FK columns; `POST/DELETE …/entities/:t/links` (create + delete only) and `DELETE …/entities/:t/links/:col` (drops the column only) are owner-gated; `DELETE …/entities/:t` (the sole table-drop path) is owner-gated, refuses inbound-FK references, refuses built-in entities, and surfaces any adapter error as a 400 (never a silent 500); the secret-toggle route rejects system + link columns. Canonical field types are surfaced on `/api/entities`.
  - **Fixed (data loss):** a first-class entity that happened to have exactly two foreign keys (e.g. `tasks` with `assignee_id` + `articles_id` + ordinary columns) was previously mis-classified as a junction table — the editor then showed a "Delete relationship" button wired to a `DROP TABLE`, so one click dropped the whole table. Junction detection (`isJunctionTable`, server + client, in lockstep) is now columns-aware: a table is a junction only if it carries nothing but its two FK columns and system columns. Such an entity now renders as a normal node/sidebar item and is fully editable; the wholesale junction-drop route was removed entirely. Regression tests cover both SQLite and Postgres.
  - **Saving updates the editor in place** — adding/renaming columns, adding/deleting links, sharing, and renaming no longer re-render the whole settings drawer (which reset scroll); only the editor panel + sidebar refresh, preserving scroll position.
- **Workspace GUI keeps rendered context synced at all times.** `lattice gui` on a `.lattice` workspace now derives canonical entity contexts for tables without one and enables auto-render, so every row has up-to-date context and the row view never shows "No rendered context for this row." A plain `lattice gui --config x.yml` is unchanged (serves only externally-rendered context). Fixes context going stale after edits.
- **Dashboard home** no longer shows the "entities" / "rows" count tiles (the per-entity cards already show counts); only the stale-data warning remains, and only when something is stale.
- **Analytics consent** is now a single **"Send anonymous analytics"** toggle covering the install ping and any Scarf pixel, with a one-line description ("Anonymous analytics will be shared with Lattice using Scarf"). Default on (opt-out), unchanged.

### Added — schema/data-model changes are tracked + reversible (soft-delete model)

- **Every schema change is now in Version History + the Activity rail, alongside row edits.** Creating/renaming/deleting a table, adding/renaming/deleting a column, and adding/deleting a link/relationship each append an entry to the same `_lattice_gui_audit` history (new `schema.*` operations; one additive nullable `session_id` column, reconciled automatically) with a one-line description ("Created table tasks", "Deleted table tasks", "Added column status to tasks", …) and a **Revert** button. Schema ops also participate in the header ↶/↷ undo/redo stack.
- **Undo/redo is session-scoped — you step through your OWN recent actions.** The header ↶/↷ stack (for both schema and row ops) is scoped to the current GUI session (one per server process), so in a shared cloud you undo what _you_ just did, not another user's edit. The per-entry **Revert** in Version History stays global — revert any entry, any session, any time.
- **Deletes are soft — data is never destroyed and reverts are exact.** A delete removes the entity/field from the config (hiding it from the GUI) but **never physically `DROP`s** the SQL table/column; the data stays in the database. Revert just re-adds the config entry, and re-opening reconciles idempotently (`CREATE TABLE IF NOT EXISTS` + skip-existing-column), so the table/column comes back with **all its rows/values intact** — no snapshot, no size limit, on both SQLite and Postgres. The only `DROP` the GUI ever performs is the explicit purge below.
- **Guards.** Reverts re-open the live DB so the in-memory schema never drifts, and surface any failure loudly rather than half-applying. Creating a table/column whose name matches a soft-deleted (orphaned) object is refused ("a deleted `<name>` exists — revert it instead"). Reverting a delete whose object was since purged is refused ("permanently purged"). Renames revert via real `ALTER … RENAME`.
- **Purge — API only.** `POST /api/schema/purge` (`{ type: 'table' | 'column', name, column? }`, owner-gated) physically drops an orphaned (soft-deleted) object to reclaim space and is **not surfaced in the GUI**. It's audit-logged as `schema.purge` and is irreversible.
- **Multiplayer.** Schema ops, reverts, and purges append a `ddl` change envelope in team/cloud mode so other clients re-fetch and converge (the broker treats `ddl` as a refresh signal, not a sharing toggle). Local SQLite is a single-writer no-op.

### Added — multiplayer cloud editing

When several people open the GUI against the same shared cloud (Postgres) DB:

- **Live share / de-share, no refresh.** Toggling a table's team visibility updates `teamContext.shared` + the visible table set in place (the share route for the initiating client, a realtime broker subscription for everyone else) instead of re-opening the DB and forcing a reload.
- **Realtime change envelopes for GUI edits.** GUI row writes now append a `__lattice_change_log` envelope (post-image payload, owner, `client_ts`), so the Postgres NOTIFY trigger fires and other clients learn of the change. Previously only the local audit log + activity feed saw GUI edits.
- **"Last edited by &lt;user&gt; · &lt;time ago&gt;"** on the row detail view, resolved from the change-log + the team roster (`GET /api/team/users`, `GET /api/tables/:t/last-edited`).
- **Live cues:** a row visible in the current view flashes when another editor changes it (honoring `prefers-reduced-motion`); changes to tables not in view bump a per-table unseen-change badge in the sidebar, cleared when the table is opened.
- **Offline editing.** When the cloud is unreachable, row edits are persisted to IndexedDB and replayed in edit-timestamp order the moment the realtime channel reconnects — no edits lost. A stable client `edit_id` makes replay idempotent (the server no-ops a re-sent edit via `findEnvelopeByEditId`); `client_ts` preserves true edit order without letting clock skew reorder the canonical `seq`. A top-bar pill shows the pending count.
- **Conflict handling.** Row edits are last-write-wins by edit timestamp, with every prior version recoverable from the change-log (`GET /api/tables/:t/rows/:id/history`). A write to a table that was de-shared under you returns a distinct `409 entity_unshared` so the client can refetch + toast. `schemaVersion` is surfaced per shared table on `/api/entities` as the optimistic-concurrency token for data-model edits (see `docs/collaboration.md` for the full policy).

### Changed — GUI: a single Workspaces switcher

- **In workspace mode (a `.lattice` root) the header shows ONE "Workspaces" switcher** instead of two overlapping menus. Previously a "database" switcher and a "workspace" switcher sat side by side, both showing the active workspace's name — confusing, since inside a workspace the database switcher only listed that one workspace's own config. Now, whenever workspaces exist, the database switcher is hidden and the Workspaces menu is the single switcher: it lists every workspace, carries the live cloud/local status dot, and gains a **"+ New workspace…"** action (a new `POST /api/workspaces/create` → `addWorkspace` + open + activate). Without a `.lattice` root (a plain `lattice gui` on a single config) the database switcher remains the fallback.

### Added — full-text search

- **Generic full-text search across entities.** A new `fullTextSearch(adapter, tables, opts)` (`src/search/fts.ts`, exported from the package root) returns hits grouped per entity with snippets, excluding soft-deleted rows, with two tiers:
  - **Indexed (opt-in).** A table opts in via `TableDefinition.fts` (`{ fields?: string[] }`; omit `fields` to auto-detect text columns). On `init`, Lattice builds an inverted index in a separate `__lattice_fts_<table>` table — **SQLite FTS5** / **Postgres `tsvector` + GIN** — kept current automatically by DB triggers (a generated `tsvector` column on Postgres). `fullTextSearch` uses the index when present; FTS5 `snippet()` / Postgres `ts_headline` produce the snippets.
  - **LIKE fallback.** Tables without `fts` are searched with a case-insensitive `OR`-of-`LIKE` over their text columns (`CAST(… AS TEXT)`, valid on both engines).
  - **Guardrail.** Index objects + triggers are created **only** for opt-in tables, so a bare `new Lattice(dbPath)` library consumer with no `fts` config gets no index, no triggers, and zero write-path overhead (a unit test asserts this).
  - **GUI search bar.** A debounced header search input calls `GET /api/search?q=&tables=&limit=` (scoped to the visible tables) and shows grouped results; click or Enter opens the row. Complements — does not replace — the embeddings-based semantic `Lattice.search`.

### Added — GUI: workspace dashboard

- **The GUI home is now a workspace overview, not a bare entity card-grid.** A new read-only `GET /api/dashboard` composes per-entity counts (reusing the pool-safe `entitiesWithCounts`), a freshness timestamp per entity (`MAX(updated_at|created_at|ts)` — one `UNION ALL` query on Postgres, in-process on SQLite), and a recent-activity list (the GUI audit log). The dashboard renders stat tiles (entities / rows / stale), per-card "last updated" with a stale flag (>14 days), and a recent-activity feed. Fully GUI-only + read-only — no core write-path behavior, so a library consumer of `latticesql` is unaffected.

### Security — DDL identifier & schema-spec validation

- **Team object sharing now validates every externally-supplied name, type, default, and constraint before it reaches DDL.** A shared object's `table`, column names, column types, defaults, and table constraints were previously rendered verbatim into `CREATE TABLE` / `ALTER TABLE`; on Postgres (simple-query protocol, empty params) a `;` could stack a second statement. New `assertSafeIdentifier` / `assertExternalIdentifier` (`src/schema/identifier.ts`) enforce a strict identifier grammar as a universal last-line defense inside the schema manager's `_ensureTable`/`addColumn` and `Lattice.addColumn`; `validateExternalSchemaSpec` validates the full spec (identifiers, the five primitive types, default grammar, constraint character-set, reserved `_lattice_` prefixes) at the `applySchemaSpec` trust boundary. Legitimate specs are unaffected. Regression tests in `tests/unit/identifier-safety.test.ts`.
- **Defense-in-depth on the core CRUD surface.** `insert` / `upsert` / `upsertBy` / `update` / `delete` / `query` / `count` and the natural-key methods now validate the `table` (and any dynamic column) identifier via `assertSafeIdentifier` before interpolating it into SQL — every legitimate identifier (including unregistered/dynamic tables) still passes.
- **Team row push/delete now require the object to still be shared.** `handlePushRow` / `handleDeleteRow` gained the `isObjectShared` precondition that `handleLinkRow` already enforced, so a stale row link cannot mutate a cloud table that has since been unshared.
- **SSRF guard:** documented the residual DNS-rebinding TOCTOU in `safeFetch` (each redirect hop is already re-validated); full socket-level IP pinning is noted as a deferred follow-up.

### Fixed — team member-list role drift + team-ops consolidation

- **The cloud member-list endpoint now surfaces the team creator with `role: 'creator'`**, matching the direct-Postgres path. The two implementations had drifted — `listMembersDirect` always surfaced the creator (even with a stale stored role, or no members row at all), while the HTTP `handleListMembers` returned the raw stored role. Both now delegate to a shared, auth-free core.
- **The cloud HTTP server (`routes.ts`) and the direct-Postgres path (`direct-ops.ts`) now share their team-operation cores** via the new `src/teams/team-core.ts`: `listTeamMembers`, `appendChangeEnvelope`, `shareObject`, `listSharedObjects`, and `unshareObject`. The `handle*` functions keep token-auth + role/authorization checks and delegate the DB logic; the `*Direct` functions keep only the cloud-connection lifecycle. This kills the duplication-with-drift bug class on those operations.
- **Change-envelope seq unified to per-team.** The two envelope writers had diverged — the HTTP path derived a _global_ max seq across all teams, the direct path a _per-team_ max. They are now both per-team (the correct cursor semantics; identical under the one-team-per-cloud model, and `handleListChanges` filters per team regardless).
- The row-level operations (`link`/`unlink`/`push`/`delete`) remain path-specific **by design** — the HTTP path mirrors row snapshots into a separate cloud table, while the direct path operates on the shared table in place; these are genuinely different logic, not duplication.

### Maintenance — dead-code removal & simplification

- Removed unreferenced internal symbols (the `src/lifecycle/index.ts` barrel, `RegisteredTable`/`RegisteredMulti`, `getStatusDirect`, `isInviteToken`).
- `reverse-seed` `_insertOrIgnore` now uses the `{ changes }` row count from `tx.run` instead of count-before/count-after SELECTs.
- Internal dedup: a `NOT_DELETED` soft-delete fragment constant (was inlined 5×), a single Postgres polyfill-registration helper, and a one-pass link index in `enrichKnowledge`.
- **`lattice.ts` modularization.** Extracted two cohesive collaborators from the `Lattice` facade — `ChangelogService` (`src/changelog/service.ts`: `history`/`recentChanges`/`rollback`/`snapshot`/`diff` + changelog-row parsing) and `ReportBuilder` (`src/report/builder.ts`: `buildReport` + duration parsing). The public method surface is unchanged: the facade keeps each method, performs the `init()` guard, and delegates to a lazily-constructed collaborator (deps injected, so the collaborators never reach into `Lattice` internals). `lattice.ts` shrank ~280 lines.
- **Shared GUI HTTP helpers (`src/gui/http.ts`).** `sendJson` / `readJson` / `tryHandler` were copy-pasted across the GUI route modules with divergent body-size caps and inconsistent error handling. Now a single source of truth: `readJson(req, { maxBytes })` defaults to 1 MB, with explicit per-endpoint overrides where a larger body is intended. The cloud Team server keeps its own copies (no GUI dependency).
- **`gui/app.ts` split.** The 5,436-line single-template-literal GUI document was split into `src/gui/app/css.ts` (stylesheet) and `src/gui/app/script.ts` (client script), assembled by a 114-line `app.ts` shell (`<style>${css}</style>` … `<script>${appJs}</script>`). The served HTML is **byte-for-byte identical** (verified: same length + SHA-256), and the no-build single-string output is preserved.

### Deprecated — `files.path` / `files.kind`

- **`files.path` is deprecated in favor of the reference model.** GUI local-file ingestion (`/api/ingest/file`) now records a v2.0 `local_ref` (`ref_kind='local_ref'`, `ref_uri`) via `referenceLocalFile()` instead of writing `path`. The blob/open routes and the GUI preview fall back to `ref_uri` (`resolveSource` already did). `files.kind` is an orphaned column (superseded by `mime` + `ref_kind`). Both columns are retained for back-compat — **not dropped** — and carry deprecation notes.
- **License metadata:** the Apache copyright holder now reads `Automated Industries (M-Flat Inc)` consistently across `LICENSE` + `NOTICE`; the `NOTICE` package label was corrected to `latticesql` and the placeholder URL to the project homepage.

### Added — workspace model + auto-render (back end)

- **One `.lattice` root** — a single discoverable folder (via `LATTICE_ROOT` or by walking up from the cwd to a `.lattice/.config`) now holds machine-local config, the workspace registry, each workspace's database + blobs, and the rendered context. `configDir()` consolidates into `<root>/.config` once initialized, with a non-destructive copy migration of any legacy machine-local config (originals preserved) and a homedir fallback.
- **First-class workspaces** — `Lattice.openWorkspace()` opens a workspace under `.lattice/Workspaces/<name>/`, split into `Data/` (database + blobs) and `Context/` (the rendered SQL→markdown bridge). Registry helpers: `addWorkspace`, `listWorkspaces`, `getActiveWorkspace`, `setActiveWorkspace`, `resolveWorkspacePaths`.
- **Canonical `Context/` layout** — zero-config, DB-aligned rendering: table→folder, row→subfolder, `<ENTITY>.md` plus relation rollups (e.g. `PROJECTS.md` inside a file, `FILES.md` inside a project). Derived from the schema via `deriveCanonicalContexts`.
- **Auto-render** — `enableAutoRender(outputDir)` debounces a re-render on every insert/update/delete (coalesced into a single render; unchanged files skipped by the manifest hash-diff). Workspaces enable it by default so context is always current and there is never a "no rendered context" state. A bare `new Lattice(dbPath)` is unaffected unless it opts in.
- **CLI** — `lattice init` scaffolds a root + default workspace and renders the initial tree; `lattice workspace list|create|use` manages workspaces.

### Added — references (a row can index data that lives elsewhere)

- **Reference columns on `files`** — additive, nullable: `ref_kind` (`blob` | `local_ref` | `cloud_ref`; NULL ⇒ owned blob), `ref_uri` (absolute path or URL), `ref_provider` (`fs` | `web` | `gdrive`), `source_json` (provider metadata). Existing inserts are unaffected.
- **Ingestion API** — `referenceLocalFile(path)` records a local file **without copying it** (the file stays where it is); `referenceUrl(url)` records a cloud reference (validated, not fetched at record time). Both set `extraction_status: 'pending'`.
- **Unified resolver** — `resolveSource(row, root)` returns a `SourceHandle` (`readContent` / `getMetadata`) for blob, local-file, and URL sources alike, so one set of utilities works for local and cloud.
- **SSRF guard** — `assertSafeUrl` rejects non-http(s) schemes and private/loopback/link-local/metadata addresses (opt-out via `allowPrivate`).
- **No-copy render mode** — entity contexts can set `attachFileMode: 'reference'` to index an attached file in place (writes a `<name>.ref.md` pointer) instead of duplicating its bytes.

### Added — GUI: workspace switcher

- **Header workspace switcher** — when the GUI is opened inside a `.lattice` root, a header switcher lists the workspaces and switches the active one (`GET /api/workspaces`, `POST /api/workspaces/switch`); switching re-points the GUI at that workspace's config + `Context/`. The switcher is hidden on a plain (non-workspace) GUI, so nothing changes for non-workspace usage. `lattice gui` now opens the active workspace automatically when a root is present. The `Workspaces/` container is never browsed as a folder — switching is header-only.

### Added — analytics consent control

- **Anonymous install analytics is now an explicit opt-out consent setting.** Scarf install analytics ships on by default (`scarfSettings.defaultOptIn`); a new `analytics` user preference + a **Settings → User → "Anonymous install analytics"** GUI toggle let users opt out. `analyticsEnabled()` is the consent gate (env `DO_NOT_TRACK` / `SCARF_ANALYTICS` win, then the preference); `lattice update` / `autoUpdate()` reinstalls pass `SCARF_ANALYTICS=false` when opted out. README + SECURITY.md telemetry docs updated to describe the consent model. The original `npm install` ping remains governed at install time by the env-var opt-outs.

## [2.0.0] - 2026-05-29

Builds on 1.16.0 — it is the 1.16 non-AI feature set plus an AI layer. This is the GUI 2.0 release: `lattice gui` gains an AI assistant sidebar. The library API is unchanged and backwards-compatible; the assistant is GUI-only and inert until credentials are configured.

### Added — AI assistant sidebar

- **Chat with tools** — `POST /api/chat` streams a Claude tool-calling loop over SSE. A function registry mirrors the GUI's mutation primitives (`createRow`/`updateRow`/`deleteRow`/`link`/`undo`/`redo`), so assistant edits are audited, fed to the activity rail, and undoable.
- **Activity feed + realtime** — an in-process feed bus streams every audited mutation (UI, AI, ingest) to the rail via `GET /api/feed/stream`; the Postgres realtime broker is merged in so other clients' changes appear too.
- **Voice input** — `POST /api/assistant/transcribe` routes to Whisper or ElevenLabs Scribe, with an explicit provider choice.
- **File ingest** — reference local files or paste text (`/api/ingest/*`); text/code extracted directly, PDFs/office docs via optional `markitdown`. With a Claude key, an LLM summarizes + classifies relevance and auto-creates junction links; the files detail view renders markdown / office-doc previews safely inline.
- **Native chat entities** — `chat_threads` + `chat_messages` join `files`/`secrets` as first-class native entities; real per-conversation threads with a switcher.
- **Credentials & OAuth** — Claude/OpenAI/ElevenLabs keys stored encrypted in the native `secrets` entity; Claude subscription OAuth (PKCE) scaffolding reads `ANTHROPIC_OAUTH_*` env vars.
- **Responsive rail** — resizable sidebar (persisted) + a mobile bottom-drawer under 720px.
- **Browser e2e coverage** — Playwright specs for the assistant rail, composer key-gating, feed stream, and file-ingest preview (the rail-independent delete-database spec ships in 1.15.0).

### Added — file-system workspace (default view) + settings drawer

- **File-system workspace** — the default GUI is now a desktop-style file manager. The home dashboard is unchanged (a card per object), but clicking an object opens its rows as a grid of **folder/file tiles**, and clicking a tile opens an **item view**: the row rendered as a document built from its columns (long-form fields formatted as markdown), with the row's relationships shown as **sub-folders** you can drill into arbitrarily deep (e.g. _Authors → a person → Books → a book → Reviews_). A clickable breadcrumb tracks the path. New `#/fs/<table>[/<id>/<relation>/<id>…]` routes; resolution is entirely client-side over the existing endpoints (no API change). Relationships are derived from the schema — forward `belongsTo` (`ref:`) renders as a parent link; the reverse side + many-to-many junctions become the drill-in folders.
- **Click-to-edit** — in the item view, click any value to edit it in place; the change saves immediately via `PATCH /api/tables/:t/rows/:id` and is undoable. Identity/system/secret and native-file binary columns stay read-only.
- **Settings drawer** — a **gear** in the header (top-right) opens a slide-over drawer with **Database**, **Lattice**, and **User** tabs (the existing settings panels, relocated from the left nav) plus an **Advanced mode** toggle. Advanced mode switches the object/row views back to the classic editable **table + row** editor (`renderTable`/`renderDetail`, unchanged); the default is the file-system workspace. The legacy `#/settings/*` hashes still resolve and open the drawer.
- **Slim collapsible sidebar** — the left object nav is now collapsible (state persisted); settings links moved into the gear drawer.
- The assistant rail is unchanged in both modes. New Playwright spec `tests/e2e/fs.spec.ts` covers the folder grid, nested drill + breadcrumb, click-to-edit persistence, the Advanced-mode toggle, and the settings drawer.

## [1.15.0] - 2026-05-29

### Added — delete a database from the GUI (destructive, confirmation-gated)

A new `POST /api/databases/delete` endpoint plus a name-gated confirm modal removes a saved database's YAML config and (for local SQLite) its `.db` file and `-wal`/`-shm`/`-journal` sidecars. It switches to a sibling first when the active database is deleted, refuses to delete the only database, rejects unknown paths, leaves remote Postgres data untouched, and surfaces filesystem failures loudly rather than half-deleting.

### Added — Playwright e2e harness + Windows CI matrix

Browser-level e2e tests for the GUI SPA (`tests/e2e/*.spec.ts`, `playwright.config.ts`, `test:e2e` script) — each spec boots its own `startGuiServer({ port: 0 })`, no shared web server. CI splits into three jobs: linux (lint/format/typecheck/coverage/build + Postgres), windows (typecheck/test/build — catches Windows-only path regressions; service containers are Linux-only so PG tests skip there), and e2e (Playwright chromium, cached).

### Fixed — `lattice gui` crashed on Windows for `postgres://` databases

`openConfig()` ran `mkdir` on the `db:` value unconditionally, but a `postgres://…:5432/…` URL contains `:`, an illegal Windows path character — so opening any Postgres database in the GUI hard-crashed on Windows. The mkdir is now skipped for non-file `db:` connection strings. Separately, `lattice --version` crashed on Windows because it read a percent-encoded `import.meta.url` pathname; it now uses `fileURLToPath()`.

### Fixed — GUI `/api/entities` exhausted the connection pool at scale

The GUI listed entity counts with an unbounded `Promise.all` of one `COUNT(*)` per entity, so a ~95-entity cloud database fired ~95 concurrent counts and exhausted a 15-slot Postgres session pooler (`EMAXCONN`). Counts now run with bounded concurrency and a fast estimated-count path on Postgres (`pg_class.reltuples`, with an exact fallback when the estimate is `<= 0`).

### Fixed — Windows non-portable `db:` paths surfaced to the config / browser

The GUI Database panel's SQLite save used `path.relative`, which yields backslash separators on Windows and leaked a non-portable path into the committed YAML; relative `db:` paths are now POSIX-normalized. Logical paths surfaced to the browser/DB are likewise normalized to forward slashes.

### Fixed — `startGuiServer().close()` could hang on an open SSE connection

A browser tab subscribed to the long-lived `/api/realtime/stream` SSE route kept a keep-alive socket open, so `close()` hung waiting for it to drain (blocking programmatic shutdown / tests). `close()` now force-drops lingering connections via `server.closeAllConnections()` (Node 18.2+).

### Changed — de-flaked the parallel-pool Postgres timing test

The concurrent-vs-baseline pool test compared parallel wall-time against an absolute floor that was sensitive to connection-setup jitter on CI. It now warms the whole pool first, then asserts a concurrent batch beats a serialized baseline (a relative comparison that states the actual property under test).

### Fixed — shared-schema sync blanked a joined member's tables

A member on a team DB could refresh and see **none** of the shared tables. Applying a cloud schema that adds a `NOT NULL` column (no default) to an already-existing local table threw `Cannot add a NOT NULL column with default value NULL` (SQLite + Postgres both reject this via `ADD COLUMN`); that non-conflict error aborted the **entire** shared-schema sync, so the member got zero tables. `renderAddColumnType()` now adds such columns nullable on an existing table (the constraint can't be enforced on existing rows anyway, and cloud-synced rows still carry values), and `syncSharedSchemas()` isolates per-table failures — a single unappliable object is recorded as a conflict and skipped, so the rest of the team's shared tables still sync.

### Fixed — native `secrets.name` `NOT NULL` column lacked a `DEFAULT`

`secrets.name` was `NOT NULL` with no default, so merging the native shape onto a pre-existing table via `ALTER TABLE ADD COLUMN` (the adopt + team shared-schema sync paths) failed with `Cannot add a NOT NULL column with default value NULL`. It now carries `DEFAULT ''`; every insert sets `name` explicitly, so the default is never observed in practice. A regression test asserts every `NOT NULL` native column has a `DEFAULT` (or is the PK).

### Fixed — `seed()` silently dropped junction links to unresolved targets

`Lattice.seed()` skipped any `linkTo` link whose target row didn't resolve (`if (!target) continue`) and `link()` swallows non-matching inserts via `INSERT OR IGNORE`, so a record could cite a relationship in its rendered text while having no link in the graph — with no error, log, or signal. `SeedResult` now carries an `unresolvedLinks: UnresolvedLink[]` array surfacing every dropped link (source record, field, target name, junction, resolve table/column). The new `SeedConfig.onUnresolvedLink: 'collect' | 'throw'` option (default `'collect'`, preserving existing behavior) makes `seed()` throw a `SeedReconciliationError` listing all unresolved links for pipelines that must never leave a dangling reference. `SeedReconciliationError` and `UnresolvedLink` are exported from the package root.

### Added — Teams dead-letter queue is now inspectable, retryable, and purgeable

`__lattice_team_dlq` was write-only: failed pull envelopes landed there and could only be counted via `teams status`, never seen or replayed, so an envelope that failed because it arrived before its dependency was effectively lost behind the advancing pull cursor. New `TeamsClient.listDlq()` / `retryDlq(id?)` / `purgeDlq(id?)` and CLI `lattice teams dlq list|retry|purge --team <name> [--id <id>]` make the queue observable and recoverable — `retry` replays through the normal apply path, so a late-arriving dependency lets the envelope apply cleanly. `teams status` now points at `dlq list` when the depth is non-zero.

### Added — non-owner local edits are no longer silently overwritten on pull

A non-owner who edited a mirrored row locally produced no outbox entry (only owners push), so the owner's next update overwrote it with no trace. `__lattice_local_links` gains a `synced_hash` column (additive; backfilled on the next session, populated on each applied upsert). Before a last-write-wins overwrite of a non-owned row, the puller compares the current local row's hash against `synced_hash` and, on a mismatch, records a `divergence` entry in the DLQ capturing both the lost local content and the incoming row. The row still converges to the owner's state; the loss is now visible via `teams dlq list`.

### Changed — `docs/teams.md` documents the real sync semantics

Added a "Conflict resolution & sync semantics" section (last-write-wins, owner-only push, non-owner overwrite behavior, DLQ vs. outbox) and corrected the schema-reference description of `__lattice_team_dlq` (it holds pull-apply failures + divergence notices, not push-attempt failures — push retries live in the outbox).

## [1.14.0] - 2026-05-27

### Fixed — native entities (`files`/`secrets`) showed as cards but failed with "Unknown table"

`registerNativeEntities()` + `init()` create and register the native `files`/`secrets` tables on every GUI-opened database, and `/api/entities` listed them as cards — but the GUI's row endpoint allowlist (`validTables`) was built only from the YAML-declared tables, so clicking a native card returned `400 Unknown table`. `validTables` (and `softDeletable`) are now derived from the live Lattice schema (`getRegisteredTableNames()`, minus internal `__lattice_`/`_lattice_` tables), so any registered non-internal table — native entities, team-shared tables, programmatic `db.define()` — is queryable by the same registry that surfaces it as a card. Internal bookkeeping tables remain non-queryable (security boundary preserved).

### Fixed — rendered-context view bled across databases

The GUI resolved the rendered-context root (`outputDir`, holding `.lattice/manifest.json`) once at launch and reused it for every database switch, so the manifest-sourced "entities/files" view showed the launch directory's rendered content for _every_ database — a database with no rendered context of its own displayed another database's files. The switch/create paths now resolve `outputDir` per config, probing the config's own directory; a database with no co-located manifest correctly shows no manifest-sourced entities.

### Fixed — SQLite `ALTER TABLE ADD COLUMN` rejected parenthesised non-constant defaults

`SQLiteAdapter.addColumn` stripped `DEFAULT datetime('now')` / `CURRENT_TIMESTAMP` / `RANDOM()` before the ALTER (SQLite rejects non-constant defaults on add-column), but only matched the bare form. The native-entity defs use the parenthesised form `DEFAULT (datetime('now'))`, so adopting a legacy table that lacked `created_at`/`updated_at` threw `Cannot add a column with non-constant default`. The strip now tolerates an optional wrapping paren.

### Added — normalized native-entity concept + adopt/label existing tables

- `NATIVE_ENTITY_NAMES` / `isNativeEntity()` — a single source of truth derived from `NATIVE_ENTITY_DEFS`. Adding a key to `NATIVE_ENTITY_DEFS` now flows everywhere (creation, GUI surfacing, recognition) with no hard-coded `'files'`/`'secrets'` literals.
- `adoptNativeEntities(db, { onConflict? })` — post-init reconcile that records, in a new internal `__lattice_native_entities` registry, which physical table is bound to each native entity. A pre-existing `files`/`secrets` table is _adopted_ (its native column superset merged in, non-destructively) and labelled the native object rather than duplicated. Legacy plaintext `secrets.value` stays readable (decrypt passes non-`enc:` values through) and new writes encrypt. `listNativeBindings(db)` reads the bindings. The GUI runs this on every open and exposes `GET /api/native-entities`; `/api/entities` now marks native tables with `native: true`. New databases created through the GUI get the native tables at creation time (additive DDL — no breaking change; library `init()` default behaviour is unchanged).

### Changed — GUI settings consolidation (every config option in one place)

- The header database dropdown and **Lattice Settings → Databases** now read the same `/api/databases` list, so they are 1:1 and both show readable labels rather than raw filenames.
- **Database Settings** shows only the _active_ database (name, connection/state, and — for a team cloud — inline invite-token generation + member list). The separate "Cloud Databases" panel, its Create/Join buttons, and the "Destroy team" button were removed.
- The add-database flow offers a third option, **Join existing cloud (via invite)**, alongside new-local and new-cloud.
- **User Settings** is now identity + preferences only; the "Cloud accounts" section was removed.
- The Data Model graph no longer renders junction tables as nodes (filtered server-side in `buildGuiGraph`); they appear only as the many-to-many edge between the two objects they link, eliminating the brief junction-box flash.
- Database Settings name input is now black-on-white (was white-on-white in the dark theme).

### Added — per-table ownership + opt-in sharing for team cloud databases

Every member of a team cloud connects to the same physical Postgres, so every table physically exists for everyone at the SQL level. Visibility is now enforced at the application layer via a new internal `__lattice_object_owners` table (`team_id`, `table_name`, `owner_user_id`): each user-created table records its creator as owner, and a user sees only the tables they own **plus** tables explicitly shared to the team (present in `__lattice_shared_objects`).

- **Ownership is recorded at creation** (`recordObjectOwner`, first-writer-wins) and **reconciled on open** (`reconcileObjectOwners` assigns any unowned table — including the native `files`/`secrets` objects — to the team creator), so visibility is deterministic.
- **Native objects are private to the creator by default.** `files`/`secrets` are owned by the database creator and are no longer visible (or queryable) to other members unless explicitly shared. The visibility filter gates the queryable `validTables` allowlist, not just the display, so a member can't read another user's secrets.
- **Sharing is an explicit action**, not a side effect of creation. The Data Model entity editor shows a **Share with team / Unshare from team** toggle for tables you own (`POST /api/schema/entities/:name/share`); only the owner may toggle it. The previous default-checked "Share with cloud" checkbox on entity creation was removed — new entities are private until shared.
- The Data Model graph and `/api/entities` list are filtered to the visible set; `/api/entities` rows now carry `shared` / `ownedByMe` flags on team clouds.

### Fixed — Data Model was empty (no native entities or team-shared tables)

The Data Model graph (`/api/graph`) was built from the YAML-declared tables only, so framework-registered native entities (`files`/`secrets`) and team-shared tables never appeared — the page rendered just the legend. `buildGuiGraph` now accepts the runtime-registered tables (and a visibility filter), so native entities and visible team tables show as nodes.

### Fixed — kicking a team member failed with `column "id" does not exist`

The team-cloud internal tables (including `__lattice_team_members`, whose primary key is the composite `(team_id, user_id)`) were only registered on the active Lattice handle in the dedicated `--team-cloud` HTTP server mode, never in the normal direct-Postgres GUI. With the schema unregistered, `delete()` fell back to a non-existent `"id"` primary-key column. `openConfig` now registers the cloud internal tables whenever the active DB is a team-enabled Postgres, so composite-key deletes (kick, leave, destroy) target the right columns.

### Fixed — an already-joined member saw the "paste invite token to join" panel

Database Settings derived the team-cloud state from whether a token key-file happened to be on disk, so a joined member could resolve to `team-cloud-needs-invite` and be shown the join form again. State is now derived from the operator's resolved membership (does their identity map to a cloud member?). The join form only appears for operators pointed at a team cloud they have not joined; joined members get the member/creator view plus a **Leave team** (member) / **Destroy team** (creator) button.

### Changed — additional GUI consolidation + polish

- The header dropdown shows each database's friendly display name and a per-row **Cloud/Local** tag with the correct status color — inactive cloud databases no longer mis-render as Local. Joined-team config files now persist a `name:` key so the label resolves without opening the cloud.
- Renaming a cloud database is restricted to the team owner; members see the name field read-only.
- Joining a team via invite now auto-switches to the joined cloud database and refreshes — no manual page reload needed.
- The Data Model now lives inside **Database Settings** rather than as a separate sidebar item.
- Async action buttons disable and show an inline spinner while their request is in flight, preventing duplicate submissions during slow round-trips.
- Bare text inputs (Database Settings name, Lattice Settings, invite token) now render on the dark surface instead of light-on-white.

### Fixed — team-cloud member administration when the cloud DB is active

When the team cloud was itself the active database (direct-Postgres mode), the SPA's member list, invite, kick, and leave actions all failed with "No local team connection found" — they keyed off the local `__lattice_team_connections` row, which only exists in whichever DB was active when you joined, not in the cloud DB you're now viewing.

- The active team identity (`teamId`, `myUserId`, `isCreator`, `isMember`) is now resolved server-side from the cloud DB and exposed on `/api/dbconfig`; the SPA drives member admin off that instead of a local connection row. Server-side, `getConnection` falls back to a synthetic connection built from the active cloud DB when no local row exists.
- **Membership is authoritative** — `resolveTeamContext` checks for a live `__lattice_team_members` row, so a kicked/left operator correctly resolves to "not a member."
- **Kick is owner-only** — the kick route 403s a non-creator removing another member (the direct-Postgres path had no server in front to authorize it); removing yourself (leave) is always allowed.
- **Members list** marks "you", and your own row carries the **Leave** (member) / **Destroy team** (creator) action; other rows carry **Kick**, shown only to the creator. The separate top-level Leave/Destroy button was removed. The team owner is always shown in the list (resolved from `__lattice_team.created_by_user_id` and labeled `creator`) even when they have no explicit `__lattice_team_members` row.
- **Leaving tears down local access** — leave/destroy now removes the team's local sibling config + saved credential, so the left DB disappears from the dropdown and can't be switched to; the SPA switches to another database and navigates off the (now-gone) DB page. This keeps the API and the UI in lockstep: a database you can no longer see is also no longer reachable.
- The **Join via invite** modal locks the email + display-name fields (read-only, sourced from User Settings) so you always join as yourself and the email matches the invite binding.

### Reverted — restored the `@scarf/scarf` install-analytics postinstall

1.13.10 dropped the `@scarf/scarf` dependency in favor of a passive README pixel. That removal is reverted: `@scarf/scarf` is restored as a dependency with `scarfSettings.defaultOptIn`, the README **Telemetry** section again documents the postinstall ping (what is sent, what is not, and the `SCARF_ANALYTICS=false` / `DO_NOT_TRACK=1` / `--ignore-scripts` opt-outs), the SECURITY **Scope** note again lists the install ping, and the README tracking pixel was removed.

## [1.13.10] - 2026-05-27

### Changed — Replaced `@scarf/scarf` postinstall with a passive README pixel + public npm download stats

v1.13.8 shipped `@scarf/scarf` as a runtime dep to capture install analytics, and v1.13.9 left it in place. In testing against the published tarball we confirmed the postinstall is structurally unable to report direct `npm install latticesql` events — Scarf's `report.js` reads `scarfSettings.allowTopLevel` from the **consumer's** root `package.json`, not the dependency's, so a library author has no way to opt their package in. The hook ran but bailed silently with `"The package depending on Scarf is the root package being installed, but Scarf is not configured to run in this case"` on every direct install, and only emitted reports for the rare transitive-install case. Net effect: the postinstall delivered approximately zero of the install volume to the dashboard.

This release removes the postinstall machinery entirely and replaces it with two passive signals that require no instrumentation in the package itself:

- **`@scarf/scarf` removed from `dependencies`**, `scarfSettings` block removed from `package.json`. Direct installs are now strictly faster (one fewer postinstall script) and quieter (no swallowed error in npm logs). No env-var opt-out is needed because there's nothing to opt out of.
- **A 1×1 Scarf tracking pixel** added at the bottom of `README.md`, fired only when the README is rendered (e.g. on the npmjs.com package page). Standard ad-blockers and privacy-focused npm UIs prevent the request from firing; alt-text is empty so layout is unchanged.
- **Public npm download counts**, queried out-of-band against `api.npmjs.org/downloads/range/...` — same data npmjs.com itself publishes, no per-user info.

README § Telemetry and SECURITY.md § Scope rewritten to reflect the new posture: zero postinstall telemetry, zero runtime telemetry except the explicit caller-invoked `checkForUpdate()` / `autoUpdate()` against `registry.npmjs.org`.

## [1.13.9] - 2026-05-27

### Fixed — `lattice gui` crashed at boot on v1.13.8 because pg got inlined into the CLI bundle

v1.13.8's `src/gui/realtime.ts` used a top-level `import pg from 'pg'`, and `tsup.config.ts` did not list `pg` in the CLI build's `external` array. tsup happily inlined pg's CommonJS internals — including a `require('events')` shim and the native-binding glue — into the ESM CLI bundle (`dist/cli.js`, which ballooned from ~596 KB to ~770 KB). Every `lattice gui` boot then crashed at first module-evaluate with `Dynamic require of 'events' is not supported`, even for SQLite-only configs that never construct a `RealtimeBroker`.

v1.13.9 is a no-API-surface hotfix:

- **`src/gui/realtime.ts`** switches to a type-only `import type pg from 'pg'` plus a runtime `createRequire(import.meta.url)('pg')` lazy-load that runs only when the broker actually opens a Postgres client. Matches the existing pattern in `src/db/postgres.ts`. The error message when pg is missing is consistent with the PostgresAdapter: `RealtimeBroker requires 'pg'. Install with: npm install pg`.
- **`tsup.config.ts`** now lists `pg` in `external` on the CLI build (mirroring the library build), so a future regression that re-adds a static `import pg` still can't pull pg into the bundle. Belt and suspenders.
- **New regression test `tests/unit/cli-pg-bundling.test.ts`** asserts (a) `src/gui/realtime.ts` never statically value-imports `'pg'`, (b) both tsup build entries list `'pg'` in `external`, and (c) when `dist/cli.js` is on disk it contains zero pg-internal markers (`pg-types`, `pg-protocol`, `pg-pool`, `pgpass`, or a bare `require('events')`).

CLI bundle size after fix: ~596 KB (down 174 KB).

## [1.13.8] - 2026-05-27

### Added — Realtime cloud subscriptions

Cloud Postgres-backed lattices now stream changes to every connected GUI in realtime. Mechanism: a Postgres trigger on `__lattice_change_log` emits `pg_notify('lattice_changes', …)` after every insert; the GUI server holds a dedicated `pg.Client` with `LISTEN lattice_changes` and fans payloads out to browsers over a new Server-Sent Events endpoint `GET /api/realtime/stream`. The browser's `EventSource` invalidates the entity cache and refetches the active view; connection state drives a colored status indicator in the topbar (green = cloud live, yellow = local SQLite, red = cloud disconnected). SQLite databases are unchanged — LISTEN/NOTIFY is a Postgres-only feature, and the broker is skipped on those.

New surfaces:

- `GET /api/realtime/stream` — SSE; emits `state` and `change` events.
- `GET /api/realtime/status` — JSON snapshot of `{ mode, state, connected }`.
- `src/teams/internal-tables.ts` exports `installCloudInternalTriggers(db)` and `CLOUD_NOTIFY_CHANGE_LOG_SQL`. The installer runs automatically wherever the cloud-internal table set is registered (team-cloud server boot, `redeemInviteDirect`, `openCloud`).
- `src/gui/realtime.ts` adds `RealtimeBroker` — dedicated pg client, exponential-backoff reconnect, state + payload subscribers.

### Added — Information-architecture refactor: Cloud Database as the first-class concept

Lattice Teams remains the product, but the GUI no longer treats "Team" as a separable entity from the cloud database that hosts it. The mental model is now: one User per machine; many Databases; each Database is Local (single-user SQLite) or Cloud (Postgres, one or more invited team members). A "team" is just the set of members on a cloud database — you don't "Create a team" anymore, you create a cloud database, and a team emerges when you invite people.

- **Three-step Create Database wizard.** A unified modal handles new-DB creation from both the header dropdown and the new Lattice Settings page. Step 1: database name + Local|Cloud radio (with cloud URL + email when cloud). Step 2: starter entities, each with a pre-checked "Share with cloud" checkbox when cloud. Step 3: review and create.
- **Editable Database name.** Renamed from "team name"; one field for both local and cloud databases. Cloud renames broadcast to every team member via the realtime channel; local writes a `name:` key into the YAML config. New endpoint `POST /api/dbconfig/rename`. ParsedConfig gains an optional `name?: string`.
- **Header dropdown.** Each entry shows the friendly DB name + a Local|Cloud kind chip + a connectivity dot (green/yellow/red). The "Create blank database" inline form is gone; "+ New database" opens the wizard.
- **Settings sidebar reorganized.** Lattice Settings (catalog of every DB this lattice can reach + "Add new database"), Database Settings (renames Project Config; editable Name header at the top), Data Model, User Settings. The legacy `/settings/project-config` route still resolves for back-compat.
- **Migrate-to-Cloud per-table share checkboxes.** The migrate modal now lists every user-defined table with "Share with cloud" pre-checked. Uncheck tables you want kept on the cloud but unshared. After the migrate, only checked tables call `shareObject`.
- **New-entity flow.** Creating an entity from Data Model on a cloud-connected DB shows a pre-checked "Share with cloud" box. Share runs best-effort after the entity is created.
- **Vocabulary.** "Create team" → "Create cloud database". "Team Cloud" → "Cloud database". Team language is preserved everywhere it describes member management ("Invite Team", "Join Team", "Team Members") and remains the brand ("Lattice Teams").

### Added — User preferences: show system tables in sidebar

The sidebar's "System" section (tables prefixed `__lattice_*` / `_lattice_gui_*`) is now hidden by default. A new checkbox in User Settings → Preferences reveals them. Backed by `~/.lattice/preferences.json` and the new `GET`/`POST /api/userconfig/preferences` endpoint. `readPreferences()` / `writePreferences()` exported from `src/framework/user-config.ts`.

### Fixed — Modal label contrast + password masking

- `.modal .field label` and inputs no longer fall through to browser UA defaults, which produced unreadable light-gray-on-white labels in some themes. Both pin explicit `var(--surface)` / `var(--text)` for predictable contrast on every theme.
- `redactUrlCredentials` now masks passwords with the ASCII `'****'` instead of a bullet glyph, so `URL.toString()` stops percent-encoding the userinfo as `%E2%80%A2`.

### Added — Scarf install analytics (opt-out)

`latticesql` now ships with [`@scarf/scarf`](https://www.npmjs.com/package/@scarf/scarf) as a runtime dependency so we can collect anonymous install metrics — package version, Node version, OS, architecture — at `npm install` time. No runtime telemetry is added: the package still makes zero outbound calls after install except the explicit, caller-invoked `checkForUpdate()` / `autoUpdate()` requests to the npm registry.

Opt out per-install (`SCARF_ANALYTICS=false npm install latticesql`), project-wide (`scarf-analytics=false` in `.npmrc`), via the cross-tool standard (`DO_NOT_TRACK=1`), or by disabling postinstall scripts entirely (`--ignore-scripts`). Opting out does not affect functionality. See README § Telemetry and SECURITY.md § Scope for the full disclosure.

## [1.13.7] - 2026-05-27

### Fixed — Joining a team cloud is now seamless end-to-end (dropdown + entity auto-discovery)

This release closes out the "join a team and start working" UX. v1.13.5 made the invite redeem succeed against direct-Postgres clouds; v1.13.6 fixed the dozen team operations that crashed once you were a member. But the user still had to manually rewire YAML configs to actually USE the team's cloud, and even after switching to it the GUI greeted them with an empty SPA. 1.13.7 wires both pieces.

**1. Joined team's cloud DB now appears in the database dropdown.**

`POST /api/teams-gui/connections/join` (the GUI's "Join via invite" handler) previously saved the team connection but did nothing to make the team's cloud DB switchable — the user had no way to actually USE the team's cloud after joining. The credential lived in the local lattice's `__lattice_team_connections` table, but the database-switcher dropdown reads filesystem YAML configs.

Two helpers wire this together (the code shipped in 1.13.6's tarball but only became user-visible together with the entity-discovery fix below, so we credit the feature here):

- **`saveDbCredentialForTeam({teamName, teamId, cloudUrl})`** in `src/framework/user-config.ts` — persists the cloud URL into `~/.lattice/db-credentials.enc` under a sanitized label of the form `<team-name>.config`. If a label collision exists with a different URL, suffixes `-<short-team-id>` to keep them distinct. Returns the label actually used.
- **Sibling YAML write** in `src/gui/teams-routes.ts` `handleJoin` — after `saveConnection`, writes `<credential_label>.yml` to the active project's config directory containing `db: ${LATTICE_DB:<label>}` + an empty `entities:` map. `listConfigs()` picks it up on the next `/api/databases` poll.

The new helper `saveDbCredentialForTeam` is re-exported from the package root.

**2. Joined-team cloud now boots with the team's shared tables already populated.**

Even with the dropdown integration above, clicking the new entry opened to:

> _No entities yet. Define entities in your lattice.config.yml or register them via db.define(), then reload._

…because the sibling YAML carried `entities: {}` and the GUI's `/api/entities` endpoint read tables exclusively from `parseConfigFile(configPath).tables`. The cloud Postgres already had the team's shared tables (rows in `__lattice_shared_objects`), but nothing replayed them into the local Lattice's runtime schema or surfaced them to the SPA.

Two more pieces wire that together:

- **`openConfig` auto-discovers shared schemas on every boot.** After `attachWriteHooks`, the GUI server enumerates every row in `__lattice_team_connections` and calls `client.syncSharedSchemas(connection)`. That fetches each team's `__lattice_shared_objects` rows and `defineLate`s them into the local Lattice. The work is idempotent — re-opening the GUI just re-applies the same specs. Per-team failures are logged but isolated; a single unreachable cloud doesn't block GUI boot.
- **`/api/entities` merges runtime-registered tables with YAML-declared ones.** `entitiesWithCounts` (in `src/gui/server.ts`) now augments the YAML table list with everything the Lattice schema manager knows about that the YAML doesn't — minus the internal `__lattice_*` / `_lattice_*` bookkeeping tables. Tables auto-synced from a team's cloud show up in the dropdown immediately on the next reload.

The fix is purely additive — projects without any team connections behave exactly as before.

**End-to-end UX after this release:** user clicks "Join via invite," enters credentials, clicks Join. The team's cloud DB appears in the database dropdown as `<team-name>.config`. Clicking it opens the SPA with the team's shared tables in the Objects sidebar, ready to query. Zero YAML editing, zero manual schema registration.

---

## [1.13.6] - 2026-05-27

### Fixed — Team operations 400 against `postgres://` cloud URLs (share, list, link, me)

`v1.13.4` added direct-Postgres dispatchers to `listMembers`, `invite`, `kickMember`, `destroyTeam`, and `fetchChangeBatch`, but the same fix didn't propagate to the rest of the cloud-touching `TeamsClient` methods. Every one of them still routed through `fetchAuthed(cloudUrl + path)` — and the Fetch API hard-refuses URLs with embedded credentials. So the GUI's "Share a table" button, the row-link / row-unlink flows, the per-session sync loop, and the `me` identity probe all 400-ed before they left the browser when the operator's cloud connection was a saved Postgres URL (the dominant case after Migrate-to-cloud or Connect-to-existing-cloud).

`TeamsClient` methods that now dispatch on URL scheme — HTTP for `http(s)://`, direct-Postgres for `postgres(ql)://`:

- `shareObject` — calls `shareObjectDirect` (parameterized INSERT/UPSERT on `__lattice_shared_objects` + `applySchemaSpec` + `__lattice_change_log` envelope). Caller must pass `inviterUserId` for the direct path so the row stamps `created_by_user_id` correctly.
- `unshareObject` — calls `unshareObjectDirect` (soft-deletes the row, appends an `unshare` envelope).
- `listSharedObjects` — calls `listSharedObjectsDirect` (parameterized query, JSON-parses each row's `schema_spec_json`).
- `me` — calls `meDirect` (looks up the user by `__lattice_api_tokens.token_hash` matching the bearer; throws `Unauthorized` if the row is missing or the user is soft-deleted).
- `linkRow` — calls `linkRowDirect` (writes the `__lattice_row_links` row + appends a `link` envelope on the cloud DB, then upserts the local mirror in `__lattice_local_links`).
- `unlinkRow` — calls `unlinkRowDirect` (deletes the cloud row + appends an `unlink` envelope, then cleans up the local mirror).
- `drainOutbox` — short-circuits to `{pushed: 0, failed: 0}`. In direct-Postgres mode the operator's local Lattice IS the cloud Lattice; writes already landed in the same DB the cloud reads. There is no separate cloud to push to.
- `pullChanges` — short-circuits to `{applied: 0, last_seq: 0, dlq_count: 0}` for the same reason. `fetchChangeBatch` already had this short-circuit (added in v1.13.4), but `pullChanges` had its own loop that would have 400-ed against the credentialed URL.

New direct-Postgres helpers in `src/teams/direct-ops.ts`: `shareObjectDirect`, `unshareObjectDirect`, `listSharedObjectsDirect`, `meDirect`, `linkRowDirect`, `unlinkRowDirect`, plus a `getStatusDirect` for symmetry (the existing `getStatus` already worked because it only touches the local DB). All use parameterized writes through the `Lattice` insert/upsert/query/delete API — no template-string SQL.

### Fixed — GUI Share dialog now passes `my_user_id` so the direct-Postgres path can stamp the row

`POST /api/teams-gui/teams/:id/shared` (the GUI's "Share a table" endpoint) now passes `conn.my_user_id` to `TeamsClient.shareObject`. The HTTP path ignores the new arg; the direct-Postgres path requires it because there's no bearer-resolved user identity in the direct flow.

### Added (infrastructure only — full UX in 1.13.7) — `saveDbCredentialForTeam` + sibling YAML write on join

This release also lays the groundwork for the joined-team dropdown integration (`saveDbCredentialForTeam` in `src/framework/user-config.ts` + a sibling YAML write in `src/gui/teams-routes.ts` `handleJoin`), but the feature only becomes user-visible once 1.13.7 also auto-discovers the team's shared schemas on `openConfig`. See the 1.13.7 entry for the full description.

## [1.13.5] - 2026-05-26

### Fixed — `redeemInvite` fails with HTTP 404 against Postgres cloud URLs

The "Join via invite" flow (and `connectToExistingCloud` with an invite token) called `fetch(cloudUrl + '/api/auth/redeem-invite')` against the form's cloud URL. When that URL is a Postgres connection string (which is what the GUI's Migrate / Connect wizards save as the cloud URL), the Fetch API either refuses (URL with credentials) or returns 404 (no HTTP server at a pooler endpoint). Joining a team from a new local lattice was effectively broken.

Fix: new `redeemInviteDirect(cloudUrl, inviteToken, email, name)` in `src/teams/direct-ops.ts` runs the same INSERT sequence as the server's `handleRedeemInvite` directly against the cloud Postgres — same invariants (token hash match, email binding, expiry, un-redeemed-yet check). `TeamsClient.redeemInvite` dispatches on URL scheme: `http(s)://` keeps the HTTP path; `postgres(ql)://` uses the direct path.

`connectToExistingCloud` with an invite token now works against Postgres cloud URLs (the whole reason it didn't before).

### Changed — Cloud URL placeholders in Create-team / Join-team modals

Both modals' Cloud URL inputs previously placeholdered `http://localhost:4317` — implying users should enter an HTTP URL, even though the realistic case is a Postgres pooler URL the GUI's Migrate/Connect wizards saved earlier. Updated to `postgres://postgres.<ref>:password@aws-x-region.pooler.supabase.com:5432/postgres` so it's obvious which form to use. `autocapitalize="off"` + `autocorrect="off"` + `spellcheck="false"` added so case-sensitive tenant prefixes don't get auto-capitalized (mirrors the v1.13.2 form-input hardening).

## [1.13.4] - 2026-05-26

### Changed — GUI team card drops the "Sync now" button + outbox/DLQ stats

Lattice is realtime against whatever its `db:` line points at. When that's a direct Postgres URL, every read and every write the GUI does already hits the canonical store. When it's local SQLite, the same is true. There is nothing the user needs to "sync" — operations either succeed live, or they fail gracefully when the connection is down. The HTTP-mode outbox / change-log / dead-letter machinery is still available via `lattice teams sync` on the CLI for HTTP-team operators who genuinely have a local-vs-remote split, but the GUI no longer surfaces it as a user-facing action.

Removed from team cards: the "Sync now" button, and the Last seq / Outbox / DLQ / Local links stat tiles. The card now shows the team name + role pill + redacted cloud URL + members + actions (Invite, Destroy, Leave). Cleaner, accurate.

### Fixed — Team operations failed against direct-Postgres cloud URLs

`TeamsClient` methods for team operations (`listMembers`, `invite`, `kickMember`, `destroyTeam`, `fetchChangeBatch`) all routed through `fetchAuthed(cloudUrl + path)`. When `cloudUrl` is `postgres://user:password@host/db` (Migrate-to-cloud / Connect-to-existing wizards save the Postgres URL directly — no HTTP `lattice serve --team-cloud` server in front), the Fetch API hard-refuses with `Request cannot be constructed from a URL that includes credentials`. So `upgradeToTeamCloud` shipped a usable team to the cloud, but every subsequent action (Invite, Members, Destroy, Sync) failed silently.

Architectural shift: for direct-Postgres cloud URLs, the operator's local Lattice IS the cloud Lattice (the project's `db:` line points at the same Postgres URL the team-internal tables live in). Every operation that the HTTP path POSTs to the cloud server is now also available as a direct query/mutation against `this.local`.

New module `src/teams/direct-ops.ts`:

- `listMembersDirect(db, teamId)` — joins `__lattice_team_members` with `__lattice_users`, returns the same `MemberSummary[]` shape as the HTTP path.
- `inviteDirect(db, teamId, inviterUserId, inviteeEmail, expiresInHours?)` — generates a `latinv_…` token, SHA-256-hashes it into `__lattice_invitations`. Default 7-day expiry.
- `kickMemberDirect(db, teamId, userId)` — deletes the membership row.
- `destroyTeamDirect(db)` — clears the singleton identity row + all members + soft-deletes the `__lattice_team` row.

`TeamsClient.{listMembers, invite, kickMember, destroyTeam}` dispatch on `isPostgresUrl(cloudUrl)` — HTTP path for HTTP clouds, `direct-ops` for Postgres URLs. The `fetchChangeBatch` sync path returns an empty batch immediately for direct-Postgres clouds (local IS cloud, nothing to pull).

The GUI's invite route now passes `connection.my_user_id` as the inviter so the direct path can stamp `__lattice_invitations.invited_by_user_id` correctly. HTTP path ignores it (server resolves the inviter from the bearer).

### Fixed — Plaintext password in the team card's cloud-URL display

The team cards under Project Config → Teams rendered `escapeHtml(conn.cloud_url)` directly. When `cloud_url` is a `postgres://user:PASSWORD@host/db` URL, the password ended up rendered verbatim in the DOM and visible to anyone with screen access. Every cloud-URL render path now goes through a new `redactUrlCredentials(url)` helper that swaps the password portion for `••••••••` while keeping the username (often useful — e.g. Supabase tenant-prefixed users) and host visible.

### Fixed — Team role pill says "UNKNOWN" for the team creator they just registered

When the cloud's `listMembers` request failed (network blip, timing, etc.) or returned a list that didn't contain the user's `my_user_id`, the role pill collapsed to a bare `"unknown"`. Surfaced as "UNKNOWN" on a team the user had just created themselves — confusing because they're obviously the creator.

The role label now splits into three states: the actual role when it resolves, `"(cloud unreachable)"` when the members request fails (network), `"(not in member list)"` when the response is good but doesn't include the local user_id (kicked / stale `my_user_id`). The bare `"unknown"` fallback is gone.

### Fixed — `upgradeToTeamCloud` + `connectToExistingCloud` skipped the local connection row

The v1.13 high-level orchestration registers (or redeems an invite on) the cloud and writes the bearer token to `~/.lattice/keys/<label>.token`, but skipped the matching `saveConnection()` call. So the local `__lattice_team_connections` row was empty after upgrade-to-team or connect-existing — and every subsequent GUI team API call (members, invites, kick, destroy) couldn't find the `cloud_url` + `my_user_id` + `api_token_encrypted` triple it needed to authenticate.

The older `handleRegisterAndCreate` / `handleRedeemInviteAndJoin` routes always wrote the connection row; the v1.13 `TeamsClient.upgradeToTeamCloud` + `TeamsClient.connectToExistingCloud` paths now do the same.

Regression test in `tests/integration/teams-gui.test.ts` asserts the connection row appears after register-and-create.

### Fixed — `/api/system-tables` empty on Postgres-backed Lattices

The GUI's System sidebar (Objects → System) used to list every `_lattice_*` / `__lattice_*` internal table, with their column names + row counts. On Postgres-backed Lattices it silently rendered an empty list because the endpoint ran two SQLite-only queries:

- `SELECT name FROM sqlite_master ...` — table doesn't exist in Postgres.
- `PRAGMA table_info("<name>")` — Postgres has no `PRAGMA` statement.

Both threw and the catch-all silently produced an empty `tables: []`. Migrated cloud projects + team-cloud DBs saw no system tables at all even though they were correctly created during `db.init()`.

Fix: dispatch on `adapter.dialect` for the listing query (`pg_tables WHERE schemaname='public'` on Postgres; `sqlite_master` on SQLite — same `\_%` ESCAPE pattern either way), and replace `PRAGMA table_info` with the public, dialect-portable `Lattice.introspectColumns(table)` which already dispatches internally to `information_schema.columns` on Postgres.

New regression test in `tests/integration/gui-init-postgres.test.ts` opens the GUI server against a Postgres URL, hits `/api/system-tables`, and asserts all four expected system tables (`_lattice_gui_meta`, `_lattice_gui_column_meta`, `_lattice_gui_audit`, `__lattice_user_identity`) appear with their columns enumerated. Runs whenever `LATTICE_TEST_PG_URL` is set (always in CI's Postgres service container).

## [1.13.3] - 2026-05-26

### Fixed — `__lattice_user_identity` init crashes on every Postgres open

`__lattice_user_identity` declared `display_name` + `email` with `DEFAULT ""`. SQLite leniently accepts double-quoted `""` as an empty-string literal, but PostgreSQL treats `""` as a zero-length **delimited identifier** (i.e. an empty column name) and throws at `CREATE TABLE` time:

```
zero-length delimited identifier at or near """""
```

This crashed every cloud-DB open via `lattice gui` (and every Postgres-targeted Migrate / Connect / Switch through the GUI), even with correct credentials. The standard-conformant form is `DEFAULT ''` (single quotes for string literals; double quotes only for identifiers). Both columns are now defined with single quotes so the CREATE TABLE works on both engines.

New regression test in `tests/integration/gui-init-postgres.test.ts` opens the GUI server against a Postgres URL and asserts `/api/entities` serves cleanly — runs whenever `LATTICE_TEST_PG_URL` is set (always in CI's Postgres service container).

### Fixed — Upgrade to team cloud fails when cloud URL is a direct Postgres URL

`TeamsClient.upgradeToTeamCloud` (and `register`) called `fetch(url + path)` against the cloud URL. When the URL is `postgres://user:password@host:5432/db` (which is what the GUI's "Migrate to cloud" / "Connect to existing cloud" wizards save as the cloud credential), browsers refuse the request with `Request cannot be constructed from a URL that includes credentials` — a hard Fetch API restriction. The team-cloud HTTP register flow only works when the cloud is fronted by a `lattice serve --team-cloud` HTTP server; for direct-Postgres clouds there was no fallback.

Fix: new `registerDirectViaPostgres(cloudUrl, email, name, teamName)` runs the same INSERT sequence against the cloud Postgres directly. `TeamsClient.upgradeToTeamCloud` dispatches on URL scheme: `http(s)://` keeps the HTTP path; `postgres(ql)://` uses the direct path. Same invariants enforced both ways (refuses if any user already exists; refuses if the singleton team identity already exists).

New public exports from `latticesql`:

- `registerDirectViaPostgres(cloudUrl, email, name, teamName)`
- `isPostgresUrl(url)`
- `type DirectRegisterResult`

### Fixed — GUI dashboard renders empty for any non-hardcoded schema

`renderDashboard` filtered cards through a hardcoded `DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files']`. Installs whose YAML declared different entity names (e.g. `clients`, `students`, `vendors`, `contracts`) saw a blank dashboard with no error or hint why — even though `/api/entities` returned the tables correctly.

Fix: render a card for every first-class entity (non-junction, non-system-table). `DASHBOARD_ORDER` is now a preference for ordering — entries in the list sort first; everything else follows in declaration order. New empty-state placeholder when no first-class entities exist at all.

### Improved — DB switch failures now surface the real error

`POST /api/databases/switch` previously relied on the top-level request handler's catch-all to surface errors as `500 <message>`. The SPA's toast then read just the status code. Common failure mode: switching back to a cloud DB whose saved credential was rotated or whose Postgres became unreachable showed an opaque 500 with no clue.

Fix: dedicated try/catch around `openConfig` in the switch handler logs the full error to the server's stderr (with code + stack) and returns a structured `Failed to switch to <path>: [SQLSTATE] <message>` JSON to the client, so the toast names the real cause.

### Improved — Validate-on-save in Migrate; Supabase URL pattern hints

The pre-v1.13.3 Migrate flow saved a credential first and probed only later — so an incorrect host / port / user (typical for Supabase: missing tenant prefix in the user, transaction-mode port 6543, wrong direct vs pooler host) got persisted as the active cloud credential and only blew up on the next open. Migrate now routes through the same `probeBeforeCredentialSave` helper Connect-Existing uses: the probe runs first; only on a clean probe does the actual migration kick off.

The same helper detects common Supabase patterns and surfaces inline warnings before the network probe:

- **Pooler host with bare `postgres` user.** Supabase pooler hosts (`*.pooler.supabase.com`) require the tenant-prefixed `postgres.<project-ref>` form. Without it, SCRAM auth fails silently with "password authentication failed for user 'postgres'".
- **Pooler with port 6543.** That's transaction mode; latticesql needs session mode on port 5432.
- **Direct host with tenant-prefixed user.** Direct hosts (`db.<project-ref>.supabase.co`) use a bare `postgres` user. Mixing the two forms produces the same SCRAM mismatch.

These checks fire on the client before any network call, so the form names the issue with a fix immediately instead of after a 30s timeout.

## [1.13.2] - 2026-05-26

### Fixed — GUI Postgres form: silent authentication failures from autocapitalize + paste whitespace

Several real-world failure modes the v1.13 Database wizard didn't defend against, all surfacing as opaque "password authentication failed" or "zero-length delimiter identifier" errors:

- **Autocapitalize on User / Host / Database / Label inputs.** macOS Safari and iOS default to `autocapitalize="sentences"` on plain `<input type="text">`. Pasting a Supabase tenant user like `postgres.<project-ref>` ended up as `Postgres.&lt;project-ref&gt;` on submit — Postgres roles are case-sensitive, so SCRAM auth failed silently with no hint about the case mismatch. Every text input in `postgresFormHtml` now sets `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`.
- **No `.trim()` on User or Password reads.** Clipboard pastes (especially from password managers and chat clients) frequently carry a trailing newline. The trailing newline ended up in the URL's password segment after `encodeURIComponent`, which the Postgres adapter then sent through SCRAM verbatim — failing with "password authentication failed" — or, for the host field, broke URL parsing into the "zero-length delimiter identifier" Postgres parse error. `readPostgresWizardForm` now trims every text field.

### Changed — "Connect to existing cloud" copy: switch, not discard

The Connect-Existing modal previously read "Your local SQLite data will be ignored — use Migrate to cloud instead if you want to push it." That wording mis-described the actual behavior: the local SQLite file is **preserved on disk** (the `db:` line in `lattice.config.yml` is rewritten to `${LATTICE_DB:<label>}`, the file itself is untouched). New copy reframes this accurately: "Switch this project to an existing cloud Postgres. Your local SQLite file is preserved — only this project's active connection changes. Switch back any time by editing `lattice.config.yml`'s `db:` line or via the Databases catalog under User Config."

Mental model going forward: one Lattice user manages multiple databases, some local + some cloud. Project Config's "Switch" creates a one-line YAML change you can reverse; the Databases catalog under User Config lets you jump between projects without editing YAML.

### Changed — `probeCloud` surfaces SQLSTATE + routine in `result.error`

When the underlying driver throws a structured error (Postgres `pg` errors carry `.code` SQLSTATE + `.routine`), `probeCloud` now folds those into `result.error` so the GUI's "Unreachable: …" message includes actionable detail. Example: `[28P01] password authentication failed for user "Postgres"` instead of just `password authentication failed for user "Postgres"`.

## [1.13.1] - 2026-05-26

### Fixed — GUI layout + table-cell overflow

- Replaced `grid-template-columns: 220px 1fr` with `220px minmax(0, 1fr)` on the main layout so wide table content no longer forces the whole page wider than the viewport. The previous `1fr`'s implicit `auto` minimum let chip-heavy cells push the layout past `100vw`, producing a horizontal page scrollbar.
- Object-table cells now truncate to 3 lines via a `.cell-clip` wrapper (`-webkit-line-clamp: 3`). Junction columns with many chips and intrinsic columns with long text blobs render at a consistent row height instead of growing into multi-line paragraphs.

### Fixed — GUI row-context discovery for programmatic entity contexts

The Database panel previously read entity contexts only from `lattice.config.yml` via the parser's `parsed.entityContexts`. Projects that register entity contexts programmatically (in a JS / TS schema module run by their own `lattice render` script — e.g. `lattice.schema.mjs`) never saw their rendered files: every row opened the "no rendered context — define an entityContext" placeholder, even when the on-disk files existed.

The convergence happens in two places now:

1. **`Lattice.entityContexts()`** (new public accessor) returns the full registered map — YAML entries + anything added later via `defineEntityContext()`. The GUI server consumes this instead of the parser's `entityContexts` field, so programmatic registrations on the live Lattice show up automatically.
2. **Manifest fallback.** When a table has no schema-registered entity context but the on-disk render manifest (`.lattice/manifest.json`) names it, the GUI derives a row → slug mapping heuristically from `row.slug` / `row.id` / `row.name` and surfaces the rendered files. This covers the "programmatic registration in an mjs file the GUI process never imports" case without requiring users to duplicate context definitions in YAML.

### Fixed — GUI output-directory discovery

`lattice gui` previously defaulted `--output` to `./context` unconditionally. Projects whose `lattice render` writes into the project root (`.`) or `./generated` would launch the GUI against an empty directory and see "no rendered context." When `--output` is not explicitly passed, the CLI now probes `./context`, `.`, and `./generated` in order and uses the first one containing a `.lattice/manifest.json` (announced via a one-line stdout log). Explicit `--output` is always honoured.

### Added — `Lattice.entityContexts()`

```ts
const db = new Lattice({ config: './lattice.config.yml' });
db.defineEntityContext('agents', {
  /* ... */
});
await db.init();
console.log(db.entityContexts()); // Map<string, EntityContextDefinition>
```

Returns a defensive copy — mutations to the returned map don't affect the schema.

## [1.13.0] - 2026-05-26

### Added — Local → Cloud → Team-Cloud progression

A one-way state machine for the GUI's Database panel, with matching public API on the npm package. Every new GUI action is a thin wrapper over an exported function:

- **`migrateLatticeData(source, target, options?)`** — copy every user-defined entity + native `secrets` / `files` row from one Lattice to another. Refuses non-empty targets. Encrypted columns round-trip through decrypt-on-read + encrypt-on-write so the operator's master key stays on the machine.
- **`openTargetLatticeForMigration(configPath, targetUrl, encryptionKey)`** — open a fresh target Lattice with the same user schema + native entities as the source's YAML config. Caller closes when done.
- **`archiveLocalSqlite(dbPath)`** — rename `<path>.db` (+ `-shm` / `-wal`) to `.db.local-bak`. Idempotent.
- **`probeCloud(targetUrl)`** — non-destructive `{reachable, dialect, teamEnabled, teamName?}` against any Lattice URL. Never throws.
- **`TeamsClient.connectToExistingCloud(opts)`** — wraps probe + (optional) `redeem-invite` + credential save + token-file write.
- **`TeamsClient.upgradeToTeamCloud(opts)`** — wraps atomic `register` + token-file write for the active cloud's label.

All exported from `latticesql` package index.

### Added — Cloud connection probe + connect-existing

GUI routes (thin wrappers):

- `POST /api/dbconfig/probe` — `probeCloud` wrapper.
- `POST /api/dbconfig/migrate-to-cloud` — migrate + archive + swap.
- `POST /api/dbconfig/connect-existing` — connect-existing + optional redeem-invite + swap.
- `POST /api/dbconfig/upgrade-to-team` — atomic register on the active cloud's label.

`GET /api/dbconfig` gains a `state` field — one of `local`, `cloud-connected`, `team-cloud-creator`, `team-cloud-member`, `team-cloud-needs-invite`.

### Changed — Project Config Database panel rewritten state-machine style

- Panel renders state-specific bodies + a color-coded badge (lime accent for connected, warn orange for needs-invite).
- Three new wizards: `showMigrateToCloudModal`, `showConnectExistingModal`, `showUpgradeToTeamModal`.
- "Create team" modal removed — replaced by the narrower "Upgrade to team cloud" wizard that's only available when state is `cloud-connected`.
- Old SQLite-only `POST /api/dbconfig/save` path preserved for local-state file-path edits; the Postgres save path is now `migrate-to-cloud` or `connect-existing`.

### Changed — User Config Databases catalog

- New `State` column per row (local SQLite rows report `LOCAL`; cloud labels report `UNKNOWN` until probed).
- New `Add a cloud DB →` button — creates a fresh project via the existing `/api/databases/create` then opens the Connect-to-existing wizard against it.

### Fixed — Form input + placeholder contrast

Step 7's dark-theme restyle didn't override the OS-default input/placeholder colors. Two global CSS rules now set:

- `input, select, textarea { color: var(--text); }`
- `input::placeholder, textarea::placeholder { color: var(--text-muted); opacity: 1; }`

Affects every form across the GUI: Data Model editor, Database wizard, User Config Identity, all team modals.

## [1.12.0] - 2026-05-25

### Added — Lattice Teams (Phase 5 + OSS-only redesign)

This release lands the full Lattice Teams feature (multi-user shared cloud Lattice databases) on top of v1.11's `lattice gui`. Highlights:

- **Atomic team bootstrap.** `lattice teams register --cloud <url> --email <e> --name <display> --team-name <team>` creates the user, the team, the creator membership, and the bearer token in one HTTP call.
- **Email-bound invitations.** `lattice teams invite --team <team> --invitee-email <e>` mints a `latinv_` token tied to the recipient's email; redemption with a different email is rejected `403`.
- **Native `secrets` + `files` entities** with at-rest encryption on `secrets.value`. Available to any Lattice via `registerNativeEntities()`; auto-registered by `lattice gui`.
- **Machine-local user config at `~/.lattice/`** — `identity.json`, encrypted `db-credentials.enc`, per-team `keys/<label>.token`, and an auto-generated `master.key`.
- **GUI restyle** matching the latticesql.com design tokens (dark theme, lime accent, Inter + JetBrains Mono).

Full architecture, schema, and HTTP surface: see [docs/teams.md](docs/teams.md).

### Added — OSS-only redesign on top of Phase 5 (feat/teams)

A follow-on PR layered on the five-phase Lattice Teams branch. Adds machine-local user config, a Database panel in Project Config, native `secrets`/`files` entities with at-rest encryption on plain `define()` tables, email-bound invitations + a singleton team-identity facade, and a GUI restyle that pulls design tokens directly from latticesql.com.

**Native `secrets` and `files` entities.** Every Lattice opened via the GUI server now has framework-shipped `secrets` and `files` tables registered before `init()`. `secrets.value` is encrypted at rest using a new `TableDefinition.encrypted?: boolean | { columns: string[] }` field (same shape as `EntityContextDefinition.encrypted`). The encryption resolver in `src/lattice.ts` walks both entity contexts and registered tables; `defineLate()` also wires encryption for late-registered tables with the `encrypted` flag.

- `src/framework/native-entities.ts` — `NATIVE_ENTITY_DEFS` + `registerNativeEntities(db)`. `secrets` columns: `id, name, kind, value (encrypted), description, created_at, updated_at, deleted_at`. `files` columns: a superset of the legacy `path`/`kind` shape plus content-addressed `sha256` / `blob_path` / `original_name` / `mime` / `size_bytes` / `extraction_status` / `extracted_text` / `description`.
- `src/framework/blob-store.ts` — `attachBlob(srcPath, latticeRoot)` writes a file into `<root>/data/blobs/<sha256>` (idempotent) and returns metadata suitable for a `files` row.

**Machine-local user config at `~/.lattice/`.** Files, not a Lattice DB.

- `master.key` — AES-256 master key, auto-generated chmod 0600 on first use. `LATTICE_ENCRYPTION_KEY` env var takes precedence.
- `identity.json` — `{display_name, email}`. Loaded into the active Lattice as `__lattice_user_identity` (singleton row, id='singleton') on every open.
- `db-credentials.enc` — AES-GCM-encrypted Postgres URLs by label.
- `keys/<label>.token` — per-team bearer tokens.
- `src/framework/user-config.ts` exports `getOrCreateMasterKey`, `readIdentity`/`writeIdentity`, `listDbCredentials`/`saveDbCredential`/`getDbCredential`/`deleteDbCredential`, `listTokens`/`readToken`/`writeToken`/`deleteToken`.

**`/api/userconfig/*` GUI endpoints.** Identity get/post (mirrors identity.json into the active Lattice on save) and a catalog of databases (sibling YAML configs + saved Postgres labels).

**Database panel in Project Config.** New `/api/dbconfig/*` endpoints:

- `GET /api/dbconfig` — current shape (sqlite/postgres + redacted params + `teamEnabled` flag from `__lattice_team_identity`).
- `POST /api/dbconfig/save` — Postgres saves to `db-credentials.enc` and rewrites the active YAML's `db:` to `${LATTICE_DB:<label>}`; SQLite rewrites the path in place using yaml round-tripping.
- `POST /api/dbconfig/connect` — re-opens the active config path so the YAML rewrite takes effect.
- `POST /api/dbconfig/test` — instantiates a probe `Lattice(url)` + `init()`; returns `{ ok: false, error }` on failure.
- `GET /api/dbconfig/labels` — saved Postgres labels.

YAML resolver in `src/config/parser.ts` honours `${LATTICE_DB:<label>}` (looks up via `getDbCredential`, throws on missing), `postgres://...` / `file:` / `:memory:` (passthrough), and the existing relative-path resolve for everything else.

**Email-bound invitations + singleton team identity.**

- `__lattice_users.email` becomes `NOT NULL`. Uniqueness still enforced at the route layer.
- `__lattice_invitations.invitee_email TEXT NOT NULL` — `redeem-invite` verifies the caller's claimed email matches the bound invitee (case-insensitive) and returns `403` on mismatch.
- New `__lattice_team_identity` singleton table (`id='singleton', team_id, team_name, creator_email, created_at`). Populated atomically by `POST /api/auth/register`.
- `POST /api/auth/register` is now an **atomic** bootstrap: body requires `{email, name, team_name}` and the handler creates the user, team, identity row, creator membership, and bearer token in one call. There is no longer a separate `createTeam` step.
- New singleton routes:
  - `GET /api/team` — identity + member list, or `{enabled: false}`.
  - `DELETE /api/team` — creator-only; drops the identity row + soft-deletes the underlying `__lattice_team` row.
  - `POST /api/team/invitations` — convenience alias for `/api/teams/:id/invitations` that resolves the id from the singleton.
- `TeamsClient.invite()` gains a required `inviteeEmail` argument; `InviteResponse` echoes the email back. CLI `lattice teams invite` adopts `--invitee-email`.
- The teams-gui invite endpoint (`POST /api/teams-gui/teams/:id/invitations`) requires `invitee_email` in the request body.

**Multi-team enumeration removed.** One cloud = one team. The following surface is gone:

| Removed                                                       | Replacement                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/teams` (create)                                    | `POST /api/auth/register` (atomic with bootstrap user)               |
| `GET /api/teams` (list)                                       | `GET /api/team` (singleton)                                          |
| `DELETE /api/teams/:id`                                       | `DELETE /api/team`                                                   |
| `TeamsClient.createTeam()` / `.listTeams()` / `.deleteTeam()` | `register()` (atomic) / `getSingleton()` (via GET) / `destroyTeam()` |
| `lattice teams create` (CLI)                                  | `lattice teams register --team-name <name>`                          |
| CLI `--name` overloaded as team name                          | `--name` = display name; new `--team-name` = team name               |

`TeamsClient.register()` now requires a `teamName` argument and returns `{ user, raw_token, team }`. Existing `/api/teams/:id/{objects,changes,members,invitations,rows,links}` routes (the load-bearing sync engine) are unchanged — the `:id` segment continues to identify the (one) team's UUID.

**GUI: identity + databases panels, email-driven invite modal.**

- User Config view now hosts an **Identity** panel (display_name + email, persisted via `/api/userconfig/identity`) and a **Databases** panel (local + cloud table from `/api/userconfig/databases` with switch-to action), with the existing "Cloud accounts" team-connection list moved below.
- Create-team and join-team modals prefill display name + email from `identity.json` so operators only type the per-team bits.
- The per-team-card "Invite" button now opens an email modal (`showInviteByEmailModal`) that threads `invitee_email` through.

**GUI restyle in latticesql.com design tokens.**

- `:root` lifts colors, spacing accents, and font families directly from `lattice-website`'s `tailwind.config.ts` (last-sync comment in the inline `<style>` block flags manual sync).
- Dark theme (`--bg: #0b0d10`, `--surface: #13171b`, `--accent: #bef264` lime, `--warn: #fb923c`, `--signal: #22d3ee`). Inter for body, JetBrains Mono for code.
- Primary buttons swap white-on-blue for dark text on lime with `--accent-glow` on hover.

### Added — Lattice Teams (Phase 5: GUI integration)

Fifth and final slice of **Lattice Teams**: the user-facing dev GUI (`lattice gui`) now drives the full Lattice Teams lifecycle. No new top-level sidebar — everything plugs into PR #10's existing **Project Config** and **User Config** settings views, which were placeholder "Coming soon" screens before this PR.

**`/api/teams-gui/*` endpoints (`src/gui/teams-routes.ts`).** A thin, unauthenticated dev-tool API that wraps the user's local `TeamsClient`. Available only in local GUI mode (`teamCloud=false`) — team-cloud mode disables this dispatcher, matching the existing database-switcher gating.

| Method | Route                                            | Wraps                                                                 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| GET    | `/api/teams-gui/connections`                     | `TeamsClient.listConnections()`                                       |
| POST   | `/api/teams-gui/connections/register-and-create` | bootstrap-register + createTeam + saveConnection                      |
| POST   | `/api/teams-gui/connections/join`                | `redeemInvite()` + `saveConnection()`                                 |
| DELETE | `/api/teams-gui/connections/:teamId`             | self-kick + `deleteConnection()` (creator → 400)                      |
| POST   | `/api/teams-gui/teams/:id/sync`                  | `pullChanges()` + `drainOutbox()` + refreshes the GUI's `validTables` |
| GET    | `/api/teams-gui/teams/:id/status`                | `TeamsClient.getStatus()`                                             |
| GET    | `/api/teams-gui/teams/:id/members`               | `listMembers()`                                                       |
| POST   | `/api/teams-gui/teams/:id/invitations`           | `invite()`                                                            |
| DELETE | `/api/teams-gui/teams/:id/members/:userId`       | `kickMember()`                                                        |
| DELETE | `/api/teams-gui/teams/:id`                       | `deleteTeam()` + `deleteConnection()`                                 |
| GET    | `/api/teams-gui/teams/:id/shared`                | `listSharedObjects()`                                                 |
| POST   | `/api/teams-gui/teams/:id/shared`                | serialises local schema + `shareObject()`                             |
| DELETE | `/api/teams-gui/teams/:id/shared/:table`         | `unshareObject()`                                                     |
| POST   | `/api/teams-gui/teams/:id/links`                 | `linkRow()`                                                           |
| DELETE | `/api/teams-gui/teams/:id/links/:table/:pk`      | `unlinkRow()`                                                         |
| GET    | `/api/teams-gui/links`                           | raw `__lattice_local_links` query                                     |

Upstream `TeamsHttpError`s surface as JSON with their original status code so the SPA can branch on auth/permission failures.

**Cached `TeamsClient` per active DB.** The GUI's `ActiveDb` now holds a `TeamsClient` instance, with `attachWriteHooks()` called on every `openConfig()` so any pre-existing local links resume tracking writes. The cached client is what the SPA's CRUD endpoints write through — a row update via the GUI dashboard fires the same outbox-capture hook as a CLI write.

**`validTables` refresh after sync.** Tables registered at runtime via `defineLate` (from a schema envelope) didn't make it into the GUI's `validTables` set, so the SPA's table viewer 400'd on freshly-synced shared tables. The sync handler now refreshes `validTables` from `lattice.getRegisteredTableNames()` after every pull.

**SPA — Project Config view.** Lists every joined team as a card with role pill, four-stat status grid (last_change_seq, outbox depth, DLQ depth, local links), and inline actions:

- **Sync now** — runs `/teams-gui/teams/:id/sync`, re-renders the card with fresh stats.
- **Generate invite token** (creator only) — opens a modal with the `latinv_`-prefixed token, click-to-copy.
- **Leave / Destroy team** — destroys for creators, leaves for members; both clean up the local connection row.
- **Shared tables** sub-section — list with per-row Unshare button; "Share another table" modal lets the user pick from currently-registered local tables.
- **Members** sub-section (creator-only) — per-member Kick button.
- **Create team** — register-and-create flow on a fresh cloud in one modal.
- **Join via invite** — paste cloud URL + invite token + email + name; redeem + save in one call.

**SPA — User Config view.** Cloud-account list (cloud URL + my user_id + joined_at) with per-cloud Sign out. Same "Add cloud" flow as Project Config's Join. Documents the v1 limitation that each team membership keeps its own bearer token.

**Per-row Link affordance (DEFERRED).** The `POST /api/teams-gui/teams/:id/links` + `DELETE /api/teams-gui/teams/:id/links/:table/:pk` endpoints ship in this PR, and the integration test exercises them end-to-end. The SPA button on the existing table-view row menu is a follow-up — adding it requires fetching link state on every row render, which interacts with the GUI agent's parallel work on the table view. The functionality is fully available via the CLI (`lattice teams link/unlink`) in the meantime.

**New `Lattice.getRegisteredTableNames()`.** Returns the SchemaManager's currently-registered table list. Used by the sync handler to refresh `validTables` and is broadly useful for any consumer that wants to discover runtime-added tables.

### Added — Tests

- `tests/integration/teams-gui.test.ts` — 5 cases covering the full GUI-driven round-trip: register-and-create, share + invite + join + sync (schema propagates to receiver, row updates flow through outbox to receiver), shared-list + members-list + invite generation, leave-as-creator returns 400, team-cloud mode rejects `/api/teams-gui/*` (auth gate fires first).

### Added — Lattice Teams (Phase 4: row link/unlink + sync engine)

Fourth slice of **Lattice Teams**: row-level link/unlink, write-hook capture into a local outbox, polling pull with a replay guard, and auto-unlink on member kick. End-to-end propagation of row updates between two locals now runs through one cloud.

**Cloud endpoints (row layer).**

- `POST /api/teams/:id/objects/:table/links` — link a row: body `{pk, row_snapshot}`. Owner is taken from the bearer token, not trusted from the client. Emits `link` + `upsert` envelopes.
- `DELETE /api/teams/:id/objects/:table/links/:pk` — unlink. Owner or team creator only. Emits `unlink`.
- `POST /api/teams/:id/objects/:table/rows` — push an owner-update for a linked row. Body `{pk, payload}`. Cloud rejects non-owners (403). Emits `upsert`.
- `DELETE /api/teams/:id/objects/:table/rows/:pk` — owner-side delete. Equivalent to unlink for Phase 4 v1.
- `DELETE /api/teams/:id/members/:userId` — extended: now also auto-unlinks every row owned by the kicked user before the membership row is removed. Each torn-down link emits an `unlink` envelope so other members' pullers drop the row from their local mirrors. Self-kick (= "leave") triggers the same path.

**New cloud table.** `__lattice_row_links` — composite PK `(team_id, table_name, pk)`, `owner_user_id`, `linked_at`.

**New local tables.** `__lattice_local_links` (composite PK, mirrors the cloud's view of which rows are linked + by whom), `__lattice_team_outbox` (pending pushes with `attempts`, `last_error`, `next_attempt_at` for exponential-backoff retry), `__lattice_team_dlq` (envelopes that failed to apply locally; one bad row doesn't stall the stream).

**`WriteHook` API widening (small breaking change in an unreleased internal API).** `WriteHook.handler` now accepts `() => void | Promise<void>` and `Lattice._fireWriteHooks` awaits the return. Callers that need to persist side-effects (the teams outbox is the canonical case) can do so atomically with the user's `await db.insert/update/delete(...)` instead of racing the response. All six `_fireWriteHooks` callsites in `lattice.ts` are now awaited.

**`TeamsClient` sync engine.**

- `linkRow(connection, table, pk)` — reads the local row, POSTs the snapshot, records the link locally, ensures the write-hook is attached for `table`.
- `unlinkRow(connection, table, pk)` — DELETEs the cloud link + drops the local link row.
- `ensureWriteHook(table)` — idempotent per-table hook registration. The hook captures local writes to linked rows into `__lattice_team_outbox`, but only for rows the local user actually owns (non-owner writes are local-only divergence; cloud is authoritative).
- `attachWriteHooks()` — scans `__lattice_local_links` and re-registers hooks for every linked table at session start (hooks are bound to the in-memory Lattice, not the DB).
- `drainOutbox(connection)` — FIFO drain in `created_at` order. 2xx → delete the outbox row. Failure → bump `attempts`, set `next_attempt_at` to a future ISO timestamp (exponential backoff to 60s).
- `pullChanges(connection)` — loops the `/changes` endpoint internally until drained. Inside the apply loop, sets `_isReplaying = true` so the write-hook skips outbox insertion — otherwise pulled envelopes would re-push immediately. Individual envelope failures land in `__lattice_team_dlq` so one bad row doesn't stall the stream. Advances `__lattice_team_connections.last_change_seq` after every successful batch.
- `getStatus(connection)` — surfaces `last_change_seq`, outbox depth + failing count, DLQ depth, and local-link count for the team.
- The write-hook re-fetches the full row via `lattice.get()` before queueing — Lattice's update hook fires with the partial diff (no PK, no unchanged columns), so the snapshot pushed to the cloud needs to be re-materialised.

**Cloud-side schema materialisation.** `handleShareObject` (Phase 3) now also applies the schema spec to the cloud's own lattice (via the new shared `applySchemaSpec` helper extracted from `TeamsClient.applyCloudSchemaLocally`). Without this, the cloud's lattice had no table to upsert linked rows into. The applier lives in `src/teams/schema-spec.ts` so both client and server share the logic.

**Replay guard correctness.** A pull that materialises Alice's link envelope on Bob's local must NOT immediately push the upsert back to the cloud — that would cause an infinite ping-pong. `TeamsClient._isReplaying` (set during `pullChanges`'s apply block) is checked in `captureWrite` before any outbox insertion.

**Ownership enforcement.**

- Cloud-side: 403 on row pushes from non-owners (security boundary).
- Local-side: the write-hook checks `__lattice_local_links.owner_user_id === my_user_id_for_this_team` before queueing — non-owners' writes silently no-op (cloud will overwrite via next pull). Belt-and-suspenders.

**CLI additions.** `lattice teams {link, unlink, pull, push, status}`. Each command calls `attachWriteHooks()` at startup so prior links resume tracking writes.

### v1 design notes (documented)

- **Phase 4 has no background polling.** Pull and push are explicit (`lattice teams pull` / `lattice teams push`). A polling loop is a transparent layer over these methods and can land in Phase 5 (GUI) or 4.5 without API changes.
- **Cursor is single-writer.** The cloud's change-log seq generation uses `MAX(seq) + 1` under the single-Lattice-process invariant. Adding HA cloud replicas later would need a transaction-scoped advisory lock — already documented in routes.ts.
- **`onUnlink` is "delete the mirrored row"** — `keep` mode is a future per-team setting; Phase 4 hard-deletes on every unlink envelope (with a try/catch for already-missing rows).

### Added — Tests

- `tests/integration/teams-sync.test.ts` — 7 cases covering the full sync flow: link → propagate → drain outbox → receiver pulls update, replay guard verified (receivers' pulls don't push back), non-owner cannot push or unlink (403), non-owner local writes don't reach the outbox, unlink propagates with hard-delete on receiver, kick auto-unlinks every owned row, outbox retry behaviour (success deletes the row; failure leaves it with bumped `attempts` for backoff).

### Added — Lattice Teams (Phase 3: object sharing + schema propagation)

Third slice of **Lattice Teams**: any member can share a table with the team, and other members' locals auto-register the schema on demand.

**Schema spec format (`src/teams/schema-spec.ts`).** Dialect-neutral structured representation of a TableDefinition: each column carries a normalised `type` (TEXT/INTEGER/REAL/BLOB/JSONB) plus `notNull` / `pk` / `default` flags. The serializer parses Lattice's raw SQL type strings into this shape (VARCHAR→TEXT, BIGINT→INTEGER, BYTEA→BLOB, JSON→JSONB, etc.); the deserializer renders dialect-appropriate DDL on the receiver (JSONB collapses to TEXT on SQLite; BLOB renders as BYTEA on Postgres). Relations: `belongsTo` propagates as descriptive metadata, `hasMany` is stripped.

**Cloud endpoints.**

- `POST /api/teams/:id/objects` — share or re-share a table. Re-sharing the same `table_name` bumps `schema_version` and replaces the stored spec.
- `GET /api/teams/:id/objects` — list shared objects (member-only).
- `DELETE /api/teams/:id/objects/:table` — soft-delete the share. Only the original sharer or the team creator may unshare.
- `GET /api/teams/:id/changes?since=<seq>&limit=<n>` — monotonic change-log feed. Phase 3 emits `schema` and `unshare` envelopes; Phase 4 adds row-level ops on the same stream.

**New cloud tables.** `__lattice_shared_objects` (composite PK `(team_id, table_name)`, holds the JSON-serialised spec + schema_version + soft-delete) and `__lattice_change_log` (monotonic `seq` per cloud, `(team_id, table_name, op, payload_json, created_at)`).

**TeamsClient additions.** `shareObject`, `unshareObject`, `listSharedObjects`, `pullChanges`, plus the orchestrator `syncSharedSchemas(connection)` which fetches the team's shared objects + applies each via `applyCloudSchemaLocally`. The applier handles three states:

1. **Table doesn't exist locally** → `defineLate` with the deserialised TableDefinition.
2. **Table exists, additive change** → `addColumn` for every cloud-only column (no-op when local already matches).
3. **PK mismatch** (different column name, different count) → `TeamsSchemaConflictError`. `syncSharedSchemas` catches per-table and surfaces conflicts in its return value; `applyCloudSchemaLocally` throws directly so callers can react.

Local extras (columns present on the receiver but absent from the cloud's spec) are preserved silently — when Phase 4 pushes a row, the payload will be filtered to the cloud's columns.

**Cursor semantics.** Phase 3 cloud is single-writer per process, so `nextChangeSeq = MAX(seq) + 1` over `__lattice_change_log` is safe inside the Node event loop. Phase 4's outbox-pushing concurrency will need a transaction-scoped advisory lock around the seq read+insert; documented in routes.ts.

**Lattice public additions.**

- `lattice.introspectColumns(table)` — thin wrapper around the adapter's introspect, used by the schema applier to read the current on-disk columns.
- `lattice.getDialect()` — returns `'sqlite' | 'postgres'` for dialect-aware DDL rendering.
- `lattice.getPrimaryKey(table)` — exposes the SchemaManager's PK lookup so the applier can verify compatibility before ALTER.
- `lattice.addColumn(table, column, typeSpec)` — runtime additive DDL with column-cache refresh; idempotent for already-present columns.
- `lattice.getRegisteredColumns(table)` — returns the raw column-DDL map for a registered table; used by `lattice teams share` to serialise the local def.

**CLI additions.** `lattice teams share <table> --team <name>` serialises the local TableDefinition and posts to the cloud; `lattice teams unshare`, `lattice teams shared`, `lattice teams sync` follow the same pattern. `sync` runs `syncSharedSchemas` and prints applied + conflict tables; non-zero exit on conflicts.

### Added — Tests

- `tests/integration/teams-sharing.test.ts` — 9 cases: schema-spec helpers (parse/render/serialize/diff), share + auto-register on a receiver, additive ALTER on schema-version bump, PK conflict reported by syncSharedSchemas, schema + unshare envelopes streamed via `/changes`, and unauth'd access blocked by 401.

### Added — Lattice Teams (Phase 2: team management)

Second slice of **Lattice Teams**: identity + team-management endpoints on top of Phase 1's auth scaffolding. `lattice teams <subcommand>` now drives the full create → invite → join → leave/destroy lifecycle.

**Cloud-side endpoints:**

- `POST /api/auth/register` — bootstrap-only (403 once any user exists); creates first user + initial token.
- `POST /api/auth/redeem-invite` — public; takes `{invite_token, email, name}`, validates + creates a fresh user (one per redemption — v1 limitation, documented below), adds to the team, issues a permanent API token.
- `GET /api/auth/me` — current user info (handy for debugging + the create-team flow).
- `POST /api/auth/tokens` — mint additional tokens for the caller.
- `DELETE /api/auth/tokens/:id` — revoke (idempotent; only the owner can revoke).
- `POST /api/teams` — caller becomes creator.
- `GET /api/teams` — teams I'm in.
- `DELETE /api/teams/:id` — soft-delete (creator only).
- `GET /api/teams/:id/members` — member-only.
- `POST /api/teams/:id/invitations` — creator only; returns `latinv_`-prefixed token + expiry.
- `DELETE /api/teams/:id/members/:userId` — creator can kick others; any member can kick themselves (= leave); creators cannot kick themselves (must destroy the team instead).

**New cloud-side tables:** `__lattice_team`, `__lattice_team_members` (composite PK), `__lattice_invitations`. **New local-side table:** `__lattice_team_connections` (per-team metadata + encrypted API token; Phase 2 currently stores plaintext — encryption-at-rest follow-up captured as a TODO).

**`TeamsClient` (`src/teams/client.ts`)** — local-side orchestrator wrapping the cloud HTTP API + local-table persistence. Idempotent table bootstrap via the new defineLate idempotency. Throws a typed `TeamsHttpError` carrying the response status so callers can branch on auth/permission failures.

**CLI:** `lattice teams <subcommand>` for `register | create | join | list | members | invite | leave | destroy`. Subcommands that operate on an existing team (members/invite/leave/destroy) look the team up locally via `--team <name>` or `--team-id <uuid>`; the create/join flow takes `--cloud --token --name [--email]` and persists the connection after the cloud call returns.

**Invitation tokens** use a distinct `latinv_` prefix and 24-byte (192-bit) entropy, hashed with SHA-256 like API tokens. The bearer-extractor's `lat_` prefix check rejects them — invitation tokens are exchanged via the redeem endpoint, never used as bearer tokens.

**`defineLate` is now idempotent.** A second call for an already-registered table is a no-op (CREATE TABLE IF NOT EXISTS handles the DB side; this skip avoids the SchemaManager throw). Lets `TeamsClient` bootstrap its internal tables on every session start without explicit checks.

### v1 limitations (documented for follow-ups)

- **Every invitation redemption creates a fresh cloud user.** A single human joining two teams on the same cloud ends up with two `user_id`s and two API tokens. Email-based identity merging is a Phase 5-or-later refinement.
- **Local API tokens are stored in plaintext.** The `__lattice_team_connections.api_token_encrypted` column name reserves the slot for encryption-at-rest; the integration with Lattice's existing AES-256-GCM layer (currently scoped to entity contexts) will land in a follow-up.

### Added — Tests

- `tests/integration/teams-management.test.ts` — 5 cases: full create → invite → join → list → leave → destroy round-trip across two locals + one cloud (one in-process), plus self-kick blocked for creators, invitation tokens rejected as bearers, token revocation, and `findConnectionByName` ambiguity error.

### Added — Lattice Teams (Phase 1: server mode + bearer auth)

First slice of the **Lattice Teams** feature: a single Postgres- or SQLite-backed lattice instance can now boot in **team-cloud server mode**, exposing the HTTP API over a non-localhost interface with bearer-token authentication. The rest of the feature (team management, object sharing, row link/unlink, sync engine, GUI integration) lands in subsequent phases.

- **`lattice serve` CLI command.** New subcommand alongside `lattice gui`. Accepts `--host`, `--port`, `--team-cloud`, and the usual `--config` / `--output`. Without `--team-cloud` it acts like `gui` but without auto-opening a browser; with `--team-cloud` it registers the internal teams tables and gates every request on a bearer token.
- **`Lattice.defineLate(table, def)`.** Mirror image of `define()` for post-`init()` table registration. Compiles the definition, registers it on the schema manager, and immediately applies its DDL through `SchemaManager.applySchemaForAsync` (which holds the same `pg_advisory_xact_lock` the boot path uses, so concurrent defineLate callers on Postgres serialize). Updates `_columnCache` for the new table so subsequent `query`/`insert`/`update` calls are aware of it.
- **`SchemaManager.applySchemaForAsync(adapter, name)`.** Per-table version of `applySchema` — pulled out into a shared `_applyOneTable` helper, then wrapped in a `withClient` block on Postgres so the advisory lock covers the DDL window. SQLite falls through to the existing direct-DDL path.
- **Bearer-token auth (`src/teams/server/auth.ts`).** Tokens are `lat_`-prefixed 256-bit random strings; only their SHA-256 hex hash is stored in `__lattice_api_tokens.token_hash`. `authenticate(req, db)` hashes the incoming bearer, looks it up directly, re-verifies with `timingSafeEqual`, and resolves the linked `__lattice_users` row (rejecting revoked tokens and soft-deleted users). `generateToken()` mints a new raw + hash pair for the issuer to store. scrypt/bcrypt are intentionally not used — they exist to slow down brute-forcing of low-entropy passwords; 256-bit tokens don't need slowdown.
- **Cloud-side internal tables (`src/teams/internal-tables.ts`).** `__lattice_users` and `__lattice_api_tokens` table definitions. Registered via `defineLate` when a lattice is booted with `teamCloud: true`. Teams, members, shared objects, row links, and the change log are added in later phases.
- **`startGuiServer` extensions.** `StartGuiServerOptions` gains `host?: string` (default `127.0.0.1`) and `teamCloud?: boolean`. In team-cloud mode: every API request requires a valid bearer token (401 otherwise), the database-switcher endpoints (`/api/databases*`) return 403 (single-user filesystem-trust assumption breaks under multi-user access), and the listen bind uses `host` instead of the previously-hardcoded `127.0.0.1`.

### Added — Tests

- `tests/unit/teams-auth.test.ts` — 11 cases covering: token hash/extract helpers (5), server boots in team-cloud mode and registers internal tables (1), 401 on missing/wrong-prefix/wrong-scheme/unknown-token Authorization headers (3), 200 on valid bearer (1), 401 on revoked token (1), 403 on the database-switcher endpoint in team-cloud mode (1).

## [1.11.0] — 2026-05-25

### Added

- **`lattice gui` CLI command.** Starts a local-only browser GUI for exploring and editing the data in a Lattice database. The server binds to `127.0.0.1`, auto-increments port `4317` when busy, and opens a single-page app for browsing entities, viewing relationship graphs, editing rows, and adding / removing junction-table links. All HTTP routes delegate straight to the existing `Lattice` CRUD methods — no separate state, no schema duplication. New flags: `--port <number>`, `--no-open`.

### Notes for upgraders

- **Three additive `_lattice_gui_*` tables are created in any database opened with `lattice gui`.** The first time the GUI runs against a given DB, it creates `_lattice_gui_meta` (per-entity icon overrides), `_lattice_gui_column_meta` (per-column `secret` flag), and `_lattice_gui_audit` (mutation log powering undo / redo). These are filtered out of `/api/entities`, hidden from the dashboard, and write to `.lattice-gui/*.md` rather than your declared `outputFile` paths — they do not appear in rendered context. **No fictional / demo rows are inserted: your existing data is what the GUI shows.** The schema mutation is one-way additive — there is no migration to remove these tables, but they are inert if you stop using `lattice gui`.
- **The GUI has no authentication and binds only to loopback.** Do not expose port 4317 (or its auto-incremented successor) on a non-loopback interface or proxy it to a public host. See [SECURITY.md](./SECURITY.md).

### Security

- **`SECURITY.md` contact updated** to `contact@automatedindustries.ai`. Supported versions updated to `1.11.x`. GUI HTTP surface added to the in-scope list.

---

## [1.10.0] — 2026-05-04

### BREAKING

- **`PostgresAdapter` no longer supports the synchronous `StorageAdapter` methods.** `run` / `get` / `all` / `prepare` / `introspectColumns` / `addColumn` now throw on Postgres with a clear error pointing callers at the async equivalents. `pg.Pool` is fundamentally async — there is no synchronous path on the Node main thread that doesn't go through a worker thread + `Atomics.wait`, and the `synckit`-bridged sync surface that 1.8.x/1.9.0 kept alive for back-compat has been removed. **Lattice core methods (`Lattice.query`, `.insert`, `.update`, `.delete`, `.count`, `.render`, `.reconcile`, `.search`, `.history`, `.rollback`, etc.) already route through the async surface as of 1.9.0** — typical consumers of `latticesql` see zero impact. Only callers that escape into `db.lattice.adapter.run/get/all` directly (rare — e.g. raw-SQL routes that reach into the adapter for one-off metadata queries) need to migrate to `runAsync` / `getAsync` / `allAsync` / `withClient`. The error message points the way.
- **`synckit` is no longer an `optionalDependency`.** Drop it from your install if you had it pinned via this package — `latticesql` no longer references it. `pg` remains an `optionalDependency` for Postgres consumers.
- **`postgres-worker.cjs` is no longer in the published tarball.** The synckit worker file that 1.6.2–1.9.0 shipped at `dist/postgres-worker.cjs` is gone (it served the now-removed sync surface). Anything that imported it directly will break — but nothing should have been doing that; it was an internal implementation detail.
- **`Lattice._ensureColumnCache` no longer lazy-populates via `introspectColumns` on cache miss.** Pre-1.10.0 it would call `adapter.introspectColumns(table)` synchronously and cache the result on first access. With sync introspect gone on Postgres, the lazy fallback is gone too. The method now returns the pre-populated cache (built at the end of `_initAsync` for every `define()`d table) or an empty `Set` for unregistered tables. Effective behavior change: code paths that mix raw `adapter.run('CREATE TABLE foo …')` (bypassing `define()`) with `Lattice.upsertByNaturalKey('foo', …)` no longer get column-detection on the unregistered table — you need to `define()` it. Production code using the documented `define()` workflow sees zero change. (The `crud-generic` integration test was the only call site that depended on the lazy fallback; it's been updated to use `define()` instead of raw DDL — which is the production-shape pattern anyway.)

### Changed

- **`PostgresAdapter` is now native against `pg.Pool`** with no worker thread. The previously-synckit-bridged `introspectColumns` and `addColumn` surfaces are now exposed as `introspectColumnsAsync(table)` and `addColumnAsync(table, column, typeSpec)` on the adapter, implemented natively against `pg.Pool`. The async surface (`runAsync` / `getAsync` / `allAsync` / `prepareAsync` / `introspectColumnsAsync` / `addColumnAsync` / `withClient`) is the only path that does work on Postgres now. `SQLiteAdapter` adds the same async methods as one-microtask wrappers around the sync versions so consumers can write a single async-preferring code path that works against both backends without branching on dialect.
- **Postgres polyfills (`pgcrypto` extension, `json_extract` SQL function, `strftime` SQL function) now register lazily on first pool use.** Previously the synckit worker registered them synchronously inside `open()`. With the worker gone, registration kicks off as a Promise (`_polyfillsReady`) when `open()` is called, and every async method awaits that Promise before its first query. By the time any user query runs, the polyfills are guaranteed to be in place. Net effect: `randomblob(N)`, `json_extract(doc, '$.a.b')`, and `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` keep working unchanged in user migrations on Postgres.
- **`StorageAdapter` interface gains optional `introspectColumnsAsync` and `addColumnAsync` methods**, mirroring the existing optional `runAsync` / `getAsync` / `allAsync`. Both built-in adapters implement them. Helper functions `introspectColumnsAsyncOrSync(adapter, table)` and `addColumnAsyncOrSync(adapter, table, column, typeSpec)` are exported from `db/adapter.ts` (mirroring the existing `runAsyncOrSync` family) for third-party adapters that haven't yet adopted the async surface.

### Removed

- **`synckit` import + worker bridge** from `PostgresAdapter`. The `_call(action)` synckit gateway, the `_workerPath` field, the `_syncFn` field, and the entire `dist/postgres-worker.cjs` build target are gone. `PostgresAdapter` shrinks from 482 LOC to ~370 LOC, plus the entire 168-line `postgres-worker.ts` source file is deleted. The third tsup build target (the worker CJS bundle) is removed.

### Notes for upgraders

- **Most consumers see zero impact.** Lattice 1.9.0 already routed all its internal DB I/O through the async surface. If your code calls `db.query(...)`, `db.insert(...)`, `db.render(...)`, etc., this release is a transparent upgrade.
- **If you escape into `db.lattice.adapter` for raw SQL**, audit those sites: replace `adapter.run` / `adapter.get` / `adapter.all` with `await adapter.runAsync(...)` / `await adapter.getAsync(...)` / `await adapter.allAsync(...)`, and replace any raw `adapter.run('BEGIN')` / `adapter.run('COMMIT')` blocks with `await adapter.withClient(async (tx) => { … })`. The thrown error surfaces the same advice.
- **If you registered a third-party `StorageAdapter`**, you'll want to add `runAsync` / `getAsync` / `allAsync` / `introspectColumnsAsync` / `addColumnAsync` / `withClient` implementations. The async-or-sync helper pattern (`runAsyncOrSync` etc.) means a third-party adapter that _only_ implements the sync surface still works — lattice falls back. But Postgres-style third-party adapters should expose async natively.
- **Connection budget on Postgres drops by 1 per adapter instance.** The synckit worker owned a separate `pg.Client` outside the pool. With the worker gone, a `PostgresAdapter` instance consumes only `poolSize` upstream connections (default 10). For the canonical setup (3 service replicas across dev + prod = 6 instances × 10 pool = 60 connections), that's a 6-connection reduction.

## [1.9.0] — 2026-05-04

### Changed

- **Lattice core now prefers the adapter's async surface over the sync surface at every internal call site.** Previously, even after 1.8.0 added `runAsync` / `getAsync` / `allAsync` to `StorageAdapter`, lattice itself still routed every read and write through the sync methods — meaning Postgres consumers were paying the synckit `Atomics.wait` cost on the Node main thread for every `lattice.query`, `lattice.insert`, `lattice.render`, and so on, even though `pg.Pool` was already available. This release flips that: `Lattice.{insert,upsert,upsertBy,update,updateReturning,delete,get,query,count,upsertByNaturalKey,enrichByNaturalKey,softDeleteMissing,getActive,countActive,getByNaturalKey,link,unlink,reward,history,recentChanges,rollback,snapshot,pruneChangelog,buildReport}`, the `RenderEngine` walk (single-table renders, multi-table renders, entity-context renders, cleanup), `SchemaManager.applySchema` / `queryTable`, `ReverseSyncEngine.process`, `ReverseSeedEngine.detect` / `process`, and the embeddings store/load helpers all consume DB I/O via three new internal helpers — `runAsyncOrSync(adapter, sql, params)`, `getAsyncOrSync(...)`, `allAsyncOrSync(...)` — exported from `src/db/adapter.ts`. Each helper prefers the async surface when present and falls back to sync when an adapter doesn't implement it. SQLite consumers see no behavioral change: SQLite has no `allAsync` / `getAsync` / `runAsync`, so every call falls through to the existing sync path. Postgres consumers now keep the Node event loop free during DB roundtrips — no more `Atomics.wait` on request-handling threads.
- **Several previously-synchronous internal helpers now return Promises.** `Lattice._appendChangelog`, `_pruneChangelog`, `_ensureChangelogTable`, plus `RenderEngine.cleanup` and `SchemaManager.applySchema` / `queryTable` are now async. The public CRUD methods that wrap them were already returning Promises; the change is internal-only for direct lattice consumers. The `Lattice.cleanup(...)` callsite inside `Lattice.reconcile` is now awaited.
- **`Lattice.init()` async tail reordering.** The synchronous validation phase of `init()` is preserved (encryption-key config check still throws synchronously, so `expect(() => db.init()).toThrow(...)` patterns remain green). What changed: `applySchema` moved into the async tail (`_initAsync`) because it now performs async DB I/O. Encryption setup was split into a sync `_validateEncryptionConfig` (throw-only, no DB access) and an async `_finalizeEncryptionSetup` (resolves columns via `introspectColumns`, runs after `applySchema`).
- **`removeEmbedding` and `ensureEmbeddingsTable` are now async.** `Lattice._syncEmbedding` continues to fire-and-forget — both branches (insert/update via `storeEmbedding` and delete via `removeEmbedding`) now route their rejection through the existing error handler chain, preserving the "embedding errors don't break the write" semantic.

### Fixed

- **`Lattice.softDeleteMissing` and `Lattice.countActive` now correctly return `number` on Postgres.** Both methods declared `Promise<number>` but returned the raw `cnt` field from a `SELECT COUNT(*) as cnt` query. SQLite returns `COUNT(*)` as a JS number, but the Postgres wire protocol returns it as a string for arbitrary-precision safety. Pre-1.9.0 the contract was honored on SQLite and silently violated on Postgres. Both methods now wrap the result in `Number(...)`, matching the behavior `Lattice.count` already had. Surfaced by the new `insert-update-async-postgres.test.ts` smoke against a real Postgres.

### Added

- **Postgres integration tests covering the four hottest call paths:**
  - `tests/integration/query-async-postgres.test.ts` — `Lattice.query` covering eq / in / like / isNull / isNotNull / numeric / orderBy / limit and the unknown-column rejection path.
  - `tests/integration/insert-update-async-postgres.test.ts` — `insert` / `upsert` / `upsertBy` / `update` / `updateReturning` / `delete` / `softDeleteMissing` / `link` / `unlink` end-to-end.
  - `tests/integration/render-async-postgres.test.ts` — full `Lattice.render(outputDir)` walk against a Postgres-backed schema with both table-level and entity-context renders. Asserts manifest contents and per-entity files.
  - `tests/integration/parallel-pool-query-postgres.test.ts` — fires 10 concurrent `Lattice.count` calls and asserts wall time is sub-linear in the batch size, proving `pg.Pool` concurrency. Regression test for the original symptom that motivated this whole rewrite (sync queries serializing through the synckit worker).

  All four follow the `describe.skipIf(!process.env.LATTICE_TEST_PG_URL, ...)` pattern; CI's existing `postgres:16` service container provides the env var so they always run on `main`.

### Notes for upgraders

- **No public-API breakage.** Methods that returned `Promise<T>` before still return `Promise<T>`; methods that were sync (e.g. `Lattice.close`) stay sync. The change is internal: lattice now routes through the async surface when the adapter offers one.
- **Postgres consumers should observe a substantial reduction in event-loop stalls.** Previously, a request that triggered a `db.query(...)` on the main thread blocked the event loop on `Atomics.wait` for the duration of the synckit roundtrip — typically tens to hundreds of ms per call, and serialized across concurrent requests. Post-1.9.0, those calls suspend cleanly via `await` and the event loop is free to handle other work. The original motivating symptom — a `~25-30s` health-probe stall during sync bursts — should drop to single-digit-second probes.
- **SQLite consumers see zero behavioral change.** The sync path is untouched and authoritative for any adapter that doesn't implement `allAsync` / `getAsync` / `runAsync`. The new helpers add a single microtask boundary on each call (`async` wrappers around `Promise.resolve(adapter.all(...))`) but no real overhead.
- **Internal-only async cascade.** Anyone subclassing `RenderEngine` or `SchemaManager` and overriding `cleanup` / `applySchema` / `queryTable` will see the return type change from `T` to `Promise<T>`. Update overrides to be `async` and await internal helpers — the parameter shapes are unchanged.

## [1.8.1] — 2026-05-02

### Fixed

- **`SchemaManager.applyMigrationsAsync` now uses the correct Postgres advisory-lock function name.** 1.8.0 shipped with the function name typoed as `pg_xact_advisory_lock` (advisory and xact swapped) — that function does not exist in Postgres. Every fresh boot crashed with `Fatal: error: function pg_xact_advisory_lock(unknown) does not exist`. The misleading `(unknown)` made it look like a parameter-typing problem; adding an `::bigint` cast reproduced as `function pg_xact_advisory_lock(bigint) does not exist`, surfacing that the function name itself was wrong. The actual Postgres function is `pg_advisory_xact_lock(bigint)` — advisory first, xact second. Fixed in `src/schema/manager.ts`. The `::bigint` cast is kept as belt-and-suspenders documentation.

### Added

- **Postgres integration test for `applyMigrationsAsync`** (`tests/integration/apply-migrations-async-postgres.test.ts`). Skips when `LATTICE_TEST_PG_URL` is unset; otherwise exercises the full end-to-end migration runner against a real Postgres. Covers: basic apply, idempotency, rollback on failure, and concurrent-boot serialization on the transaction-scoped advisory lock. Catches the regression that 1.8.0 shipped — the SQLite-only unit tests passed because they skip the advisory-lock branch entirely; this test runs the exact code path that broke.
- **Postgres service container in CI** (`.github/workflows/ci.yml`). Provisions a `postgres:16` service container and sets `LATTICE_TEST_PG_URL` on the test job so the new integration suite always runs in CI.

## [1.8.0] — 2026-05-02

### Added

- **Optional async surface on `StorageAdapter`** — `runAsync` / `getAsync` / `allAsync` / `prepareAsync` / `withClient`, plus a `dialect: 'sqlite' | 'postgres'` discriminator and a new `TxClient` interface for transaction-scoped query handles. Existing sync methods (`run` / `get` / `all` / `prepare`) are unchanged and still authoritative for SQLite consumers; the async surface is preferred by lattice itself when present. Adapters that don't implement async methods continue to work via the sync surface.
- **`PostgresAdapter` now exposes a native async surface backed by `pg.Pool`** alongside the existing synckit-bridged sync surface. New `PostgresAdapterOptions.poolSize` (default 10) controls the pool. The async path runs on the Node main thread without `Atomics.wait`, so the event loop is free to serve other work between awaited DB roundtrips. The synckit worker is kept alive for back-compat — sync `run`/`get`/`all` callers see no behavioral change. Total upstream connection demand per adapter instance is `1 + poolSize` while both surfaces are in use; in a future release the synckit path will be removed.
- **`SQLiteAdapter.withClient(fn)`** — wraps an async `fn(tx: TxClient)` in a `BEGIN`/`COMMIT` block on the single SQLite connection. Throws inside `fn` cause `ROLLBACK`. Provided for cross-dialect parity with `PostgresAdapter.withClient` so transactional callers don't need to branch on adapter type.
- **`SchemaManager.applyMigrationsAsync`** — runs the migration loop inside a single `withClient(fn)` block. On Postgres, also acquires `pg_xact_advisory_lock(LATTICE_MIGRATION_LOCK_ID)` at the top of the transaction so concurrent app boots queue and apply migrations serially instead of racing on `CREATE TABLE` / seed inserts. The lock is transaction-scoped, so it auto-releases at `COMMIT` — no explicit unlock and no risk of a leaked lock surviving a crashed boot. SQLite path uses the same withClient block but skips the advisory-lock branch (better-sqlite3's single-writer guarantee plus WAL + busy_timeout already cover concurrent boots). Falls back to the synchronous `applyMigrations` when the adapter doesn't implement `withClient`.
- **`Lattice.init()` and `Lattice.migrate()` now drive migrations through `applyMigrationsAsync`.** The synchronous validation phase of `init()` (encryption-key config check, etc.) is preserved as a non-async function so existing `expect(() => db.init()).toThrow(...)` patterns continue to surface config errors as synchronous throws, not promise rejections.

### Changed

- **Internal raw `BEGIN`/`COMMIT`/`ROLLBACK` call sites in `reverse-seed/engine.ts` and `reverse-sync/engine.ts` migrated to `withClient(fn)`.** Previously these relied on the synckit worker's single `pg.Client` to incidentally pin BEGIN/COMMIT to one connection. Under the new pool-backed async surface, raw BEGIN/COMMIT can land on different upstream connections and break atomicity silently. `withClient(fn)` checks out a single client for the full transaction — the surface is identical on SQLite and Postgres so the migration is mechanical.
- **`ReverseSeedEngine.process` and `ReverseSyncEngine.process` are now async** (return `Promise<ReverseSeedResult>` / `Promise<ReverseSyncResult>`). Callers inside lattice's own render loop are already inside async methods; downstream consumers awaiting the previous sync return value see no behavioral change since both engines were always invoked from `Lattice.render()` and `Lattice.reverseSeed()`, which already return Promises.

### Fixed

- **Migration runner is now safe under transaction-mode connection pooling.** Before this release, if a Postgres consumer pointed `PostgresAdapter` at a transaction-mode pgbouncer endpoint (e.g. Supabase port 6543), there was no upstream connection guarantee across the migration loop's individual `adapter.run` calls and concurrent boots could race on `CREATE TABLE IF NOT EXISTS` + seed inserts. The new `pg_xact_advisory_lock` inside `withClient(fn)` serializes concurrent migration runs.

### Notes for upgraders

- This release is **additive** at the `StorageAdapter` interface level — existing third-party adapters that implement only the sync surface continue to work unchanged. Lattice will use the sync path when `withClient` is undefined on the adapter.
- Postgres consumers gain real async DB I/O on the new `runAsync`/`getAsync`/`allAsync`/`withClient` methods. To benefit, downstream code should adopt the async surface (e.g. `await db.query(...)` already routes through the async path via the consumer's `DataStore` async wrappers in most cases).
- Raw `adapter.run('BEGIN')` / `adapter.run('COMMIT')` is **no longer a safe transaction idiom** if you call it on a future Postgres release where the synckit worker has been removed. Migrate now to `await adapter.withClient(async (tx) => { ... })` — the surface is the same on SQLite and Postgres.

## [1.7.0] — 2026-04-20

### Changed

- **`better-sqlite3` is now a `peerDependency` with range `>=11 <13`** (previously a regular `dependency` pinned to `^12.8.0`). Lattice only uses the stable, long-standing subset of the better-sqlite3 API (`new Database()`, `prepare`, `exec`, `pragma`, `transaction`, `function`, `close`), which is unchanged across 11.x → 12.x. Pinning a single major forced downstream projects already on `better-sqlite3@^11` to either upgrade in lockstep or hit `ETARGET` / peer-conflict errors on `npm install latticesql`. Moving it to `peerDependencies` also matches the library pattern (the host app owns the native sqlite driver build). Kept as a `devDependency` at `^12.8.0` so local tests still run.

### Fixed

- **`require('latticesql')` from a CJS consumer no longer crashes at module load.** `src/db/postgres.ts` used to call `fileURLToPath(import.meta.url)` and `createRequire(import.meta.url)` at the top level. Under tsup's dual-bundle CJS output, `import.meta` is rewritten to `{}` so `.url` is `undefined` — loading `dist/index.cjs` threw `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of URL. Received undefined` before any user code ran. Fix: lazy-resolve the module directory and local `require` via a small `moduleContext()` helper that prefers `import.meta.url` under ESM and falls back to Node's CJS-injected `__dirname` / `require` globals when `import.meta.url` is unavailable. The CI workflow's "Verify CJS require" step now passes.
- **Lint cleanups in the Postgres dialect translator (`src/db/postgres.ts`) and worker (`src/db/postgres-worker.ts`).** No runtime behavior change — replaces bare `sql[i]` indexed reads (flagged under `noUncheckedIndexedAccess`) with `sql.charAt(i)`, tightens regex-callback signatures so template-literal expressions are `string` rather than `any`, widens `hadInsertOrIgnore` to `boolean` so TypeScript doesn't narrow it to literal `false`, removes now-redundant `eslint-disable no-console` directives, and types `pg.Client.query<Record<string, unknown>>(...)` to propagate row-shape through to the worker's `Result` type. Restores green CI on `main`.

## [1.6.10] — 2026-04-14

### Added

- **`strftime()` Postgres polyfill** — Handles the common `strftime(format, 'now')` ISO-timestamp pattern plus arbitrary SQLite-style format strings by token-replacing to `to_char()` form. Also accepts ISO timestamps as the modifier arg.

## [1.6.9] — 2026-04-14

### Added

- **`json_extract()` Postgres polyfill** — On `PostgresAdapter.open()`, registers a SQL function `json_extract(doc text, path text) RETURNS text` that mimics SQLite's behavior by stripping the `9` prefix and splitting the remaining dotted path into a Postgres `#>>` array access. Lets migrations that use SQLite JSON syntax (e.g. `json_extract(metadata_json, '9contact_id')`) work on Postgres unchanged.

## [1.6.8] — 2026-04-14

### Added

- **`datetime('now')` translation** — Lattice internally emits `UPDATE ... SET deleted_at = datetime('now')` for soft-deletes and `DEFAULT (datetime('now'))` in some core schemas. Now translated to `NOW()` when the adapter is Postgres. `datetime()` with any other argument throws loudly.

## [1.6.7] — 2026-04-14

### Added — `CREATE VIEW IF NOT EXISTS` translation

- SQLite supports `CREATE VIEW IF NOT EXISTS v AS SELECT ...`; Postgres rejects it as `syntax error at or near "NOT"`. The translator now rewrites it to `CREATE OR REPLACE VIEW v AS SELECT ...`, which is the Postgres-native idempotent form (and works in SQLite too, though only the Postgres path runs the translation). 3 new unit tests cover the translation + a guard that `CREATE TABLE IF NOT EXISTS` is unchanged (tables ARE supported by both dialects).

## [1.6.6] — 2026-04-14

### Fixed

- **`INSERT OR IGNORE ... SELECT ...` with string literals in the SELECT body now translates correctly.** Previously the `ON CONFLICT DO NOTHING` clause was appended per code region in `translateDialect`, which put it directly after the column list when the SELECT body contained string literals (they split the SQL into multiple code regions in the tokenizer). The resulting SQL had the clause before the `SELECT ... FROM ... LIMIT N` tail, which Postgres rejected with `syntax error near '<string literal>'`. Fix: track the `INSERT OR IGNORE` flag across the whole statement and append `ON CONFLICT DO NOTHING` once at the END of the full SQL. Regression test added for the canonical `INSERT OR IGNORE INTO file ... SELECT 'uuid', id, 'name', ... FROM org LIMIT 1` pattern that downstream consumer migrations use.

## [1.6.5] — 2026-04-13

### Fixed

- **`PostgresAdapter` now uses `createRequire(import.meta.url)` to load `pg` and `synckit`.** The bundler's `__require` shim throws "Dynamic require of '…' is not supported" under ESM, which fell into the catch block and surfaced as the misleading "requires 'pg' and 'synckit'" error even when both packages were installed and reachable. Switched to `createRequire(import.meta.url)` rooted at this file's URL, which builds a real CJS require that walks up from `latticesql/dist/` and finds the consumer's `node_modules` entries. Error messages now include the underlying require error so future failures are diagnosable.

### Note

This is the fourth attempt at making the Postgres backend actually work end-to-end (1.6.0 missed the worker file, 1.6.2 added it as `.js` under `type: module` so Node refused to load it, 1.6.3 fixed the extension, 1.6.4 marked deps external, 1.6.5 fixes the require shim). With this version, `new Lattice('postgres://...').init()` succeeds against a real Supabase project.

## [1.6.4] — 2026-04-13

### Fixed

- **`pg`, `synckit`, and `@pkgr/core` are now external in the bundle.** 1.6.0 through 1.6.3 inadvertently bundled all three into `dist/index.js`. That broke under ESM consumers because `@pkgr/core` (a transitive dep of synckit) calls `createRequire(import.meta.url)` at module init — which throws when `import.meta` is the bundler's stub object (`{}`). The error fell into `PostgresAdapter.open()`'s catch and surfaced as the misleading `"requires 'pg' and 'synckit'"` message even though both were installed.
- After this fix, `pg` and `synckit` resolve from the consumer's `node_modules` at runtime (where they belong as `optionalDependencies`). End-to-end Postgres now works from ESM consumers.

### Note

Versions 1.6.0 / 1.6.1 / 1.6.2 / 1.6.3 are all affected by the bundling bug. 1.6.4 is the first version where `new Lattice('postgres://…').init()` actually succeeds.

## [1.6.3] — 2026-04-13

### Fixed

- **PostgresAdapter worker now runs.** 1.6.2 emitted `dist/postgres-worker.js` but the published `package.json` has `"type": "module"`, so Node 18+ treats every `.js` file in the package as ESM. The worker is built as CJS (it `require()`s `pg` and `synckit`), so loading it failed with `require is not defined in ES module scope`. The synckit `try/catch` masked this as the misleading "requires 'pg' and 'synckit'" message. Worker now ships as `dist/postgres-worker.cjs`; `PostgresAdapter` constructor resolves the `.cjs` extension. End-to-end Postgres connection now works under Node 18 / 20 / 22 / 24.

### Note

If you tried 1.6.2 and got the same misleading "requires 'pg' and 'synckit'" error, this is the actual fix. 1.6.0 / 1.6.1 / 1.6.2 should not be used with the Postgres backend.

## [1.6.2] — 2026-04-13

### Fixed

- **`PostgresAdapter` worker file now ships in the published tarball.** The 1.6.0 / 1.6.1 dist included the bundled library + CLI but not the `postgres-worker.js` file that `synckit` loads via `new Worker(workerPath)`. Result: any consumer that called `new Lattice('postgres://…').init()` got an immediate `"PostgresAdapter requires 'pg' and 'synckit'"` error even when both were installed — the catch block masked the real `Cannot find module 'postgres-worker.js'` error from synckit. `tsup.config.ts` now emits `dist/postgres-worker.js` as a standalone CJS bundle alongside the main library, with `pg` + `synckit` declared external so they resolve from the consumer app's `node_modules` at runtime.

### Note

If you tried 1.6.0 or 1.6.1 with a Postgres connection string and got the misleading "requires pg and synckit" error, upgrade to 1.6.2 — `pg` and `synckit` were correctly installed; the worker file just wasn't there to load them.

## [1.6.1] — 2026-04-13

### Added — extra `PostgresAdapter` dialect translations

The `PostgresAdapter` rewriter (introduced in 1.6.0) gains four more SQLite → Postgres translations so existing migration code that uses common SQLite idioms keeps working unchanged when pointed at a Postgres connection string:

| SQLite                     | Postgres translation                    | Notes                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT OR IGNORE INTO …`  | `INSERT INTO … ON CONFLICT DO NOTHING`  | Strips `OR IGNORE`, appends `ON CONFLICT DO NOTHING` to the statement tail. Skipped if the user already wrote an explicit `ON CONFLICT` clause. Requires at least one unique constraint on the target table.                        |
| `INSERT OR REPLACE INTO …` | (intentionally not translated — throws) | The correct `ON CONFLICT (col) DO UPDATE SET …` form depends on the conflict target, which the translator can't infer. Surface the error so the operator picks the right form.                                                      |
| `randomblob(N)`            | `gen_random_bytes(N)`                   | Requires `pgcrypto`. `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` idempotently — succeeds on Supabase / Neon / RDS, warns (non-fatally) on hosted Postgres providers that restrict CREATE EXTENSION. |
| `hex(<expr>)`              | `encode(<expr>, 'hex')`                 | Postgres lacks the SQLite `hex()` shorthand. Composite `lower(hex(randomblob(16)))` (a common 32-char hex-id pattern) translates to `lower(encode(gen_random_bytes(16), 'hex'))`.                                                   |

`INSERT OR IGNORE` translation is **string-literal aware** — the keywords are not rewritten if they appear inside quoted user data. `randomblob` / `hex` translations are not string-aware (the alternative breaks the common `hex('abc')` literal-argument case); the documented limitation is that storing the literal text `"hex(...)"` inside a single-quoted user data string will get the function name rewritten. Real migrations virtually never store SQL function names inside user data.

### Changed

- `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` once per connection. Failures are warned (`console.warn`) but non-fatal — providers that restrict CREATE EXTENSION can still use the adapter as long as `pgcrypto` is enabled out-of-band.
- `_translateDialectForTest` exported from `src/db/postgres.ts` for unit testing of the new translation passes.

### Tests

12 new unit tests in `tests/unit/postgres-rewrite.test.ts` — `INSERT OR IGNORE` (5), `randomblob` / `hex` (5), `INSERT OR REPLACE` rejection (1), composite end-to-end (1). All 551 tests pass.

## [1.6.0] — 2026-04-13

### Added

- **Pluggable database backend.** Lattice now supports either SQLite (the existing default) or any Postgres-compatible database via a new `PostgresAdapter`. Pass a connection string and Lattice picks the right adapter:
  - `new Lattice('/path/to/db.sqlite')` — SQLite (unchanged).
  - `new Lattice(':memory:')` — in-memory SQLite (unchanged).
  - `new Lattice('file:/path/to/db.sqlite')` — explicit SQLite via `file:` scheme.
  - `new Lattice('postgres://user:pass@host:5432/db')` — Postgres.
  - `new Lattice('postgresql://...')` — Postgres (alternate scheme).
  - `new Lattice(anyPath, { adapter: myAdapter })` — bring your own adapter.
- **`StorageAdapter` interface gains two methods:** `introspectColumns(table)` and `addColumn(table, col, typeSpec)`. Implementations dispatch on their own dialect (SQLite uses `PRAGMA table_info`, Postgres uses `information_schema`; SQLite handles non-constant defaults via backfill, Postgres natively).
- **Public exports** for advanced consumers: `StorageAdapter`, `PreparedStatement`, `SQLiteAdapter`, `PostgresAdapter`, `PostgresAdapterOptions`.
- **`Lattice.adapter`** getter — portable accessor for the configured `StorageAdapter`. The existing `Lattice.db` getter still returns the better-sqlite3 handle but throws when the adapter isn't a `SQLiteAdapter`.

### Changed

- `Lattice` constructor signature is unchanged for SQLite users — the same `new Lattice(path)` form continues to work, with the same `wal` / `busyTimeout` options.
- `_addMissingColumns` and the four `PRAGMA table_info(…)` call sites in `Lattice` and `SchemaManager` now go through `adapter.introspectColumns(table)` and `adapter.addColumn(table, col, type)`. Behavior under SQLite is identical; the refactor enables the Postgres path.

### Implementation notes

- `PostgresAdapter` runs `pg` inside a `synckit` worker thread so the synchronous `StorageAdapter` interface can wrap an inherently async client. Each query pays ~1–3 ms of message-passing overhead — fine for Lattice's batch-insert + periodic-render workload, not OLTP-grade. If/when a workload genuinely needs async throughput, an async `StorageAdapter` variant can be added without breaking SQLite consumers.
- `?` placeholders are translated to `$N` automatically. The translator skips over single-quoted strings, double-quoted identifiers, and SQL comments, so `?` characters inside those are left alone.
- `BLOB` column types are translated to `BYTEA` automatically inside `addColumn`. `datetime('now')` and `RANDOM()` are translated to `NOW()` and `random()` respectively.
- `pg` and `synckit` ship as `optionalDependencies` — SQLite-only consumers don't pay the install cost. The `PostgresAdapter` constructor throws a clear error message if either is missing.

### Provider notes

- Any Postgres-compatible database that speaks the standard wire protocol on port 5432 should work — including managed providers like Supabase, Neon, and RDS.
- When using a connection pooler, prefer **session-mode pooling**. Transaction-mode poolers typically do not support prepared statements across transactions, which would break Lattice's `adapter.prepare()` pattern.

### Limitations (out of scope for this release)

- `lastInsertRowid` is `0` on the Postgres path. Use `TEXT PRIMARY KEY` (UUIDs) for portable schemas; if you need a fresh integer ID after insert on Postgres, write your own `INSERT … RETURNING id` query.
- Two SQLite-only paths remain: `fixSchemaConflicts(db)` (lifecycle helper) and the writeback session-apply machinery both take a raw better-sqlite3 handle. Postgres consumers shouldn't call them.
- A migration tool that dumps an existing SQLite Lattice DB into Postgres is not included. Use a generic SQLite → Postgres migration tool, or `INSERT … SELECT` row-by-row.

## [1.5.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` between v1.3.1 and v1.5.0 — primarily formatting / tooling fixes (incremental changelog writes, Windows path-separator handling, prettier formatting, lint cleanup). No public API changes.

## [1.4.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` — see notes for 1.5.0.

## [1.3.0] — 2026-04-04

### Added

- **Token-budget-aware rendering** — New `tokenBudget` and `prioritizeBy` options on `TableDefinition`. When rendered output exceeds the token budget, rows are pruned by priority and a truncation footer is appended. Token count estimated at ~4 characters per token.
- **Writeback validation** — New `validate`, `rejectBelow`, and `onReject` options on `WritebackDefinition`. Validate agent-written data before persisting — entries that fail validation or score below threshold are rejected. Supports sync and async validators.
- **Relevance-filtered rendering** — New `relevanceFilter` on `TableDefinition` and `setTaskContext()`/`getTaskContext()` on Lattice. Dynamically filter rows by relevance to the current task context before rendering.
- **Context enrichment pipeline** — New `enrich` option on `TableDefinition`. Array of transform functions applied to rows after filtering but before rendering — use for clustering, annotation, summarization, or cross-referencing.
- **Reward-scored memory** — New `rewardTracking` and `pruneBelow` options on `TableDefinition`, and `reward()` method on Lattice. Auto-adds `_reward_total` and `_reward_count` columns. Rows sorted by reward during render. Low-scoring rows auto-pruned via soft-delete.
- **Semantic search via embeddings** — New `embeddings` option on `TableDefinition` and `search()` method on Lattice. Bring your own embedding function. Embeddings stored in a companion table, cosine similarity computed in JS. Supports `topK` and `minScore` options.
- Exported new types: `WritebackValidationResult`, `RewardScores`, `EmbeddingsConfig`, `SearchOptions`, `SearchResult`.
- Exported new utilities: `estimateTokens()`, `applyTokenBudget()`.

## [1.2.3] — 2026-04-04

### Security

- **CRITICAL**: Fixed command injection in `autoUpdate()` — replaced `execSync` with `execFileSync` + semver validation
- **HIGH**: Fixed path traversal in entity slug rendering — validates slug characters and verifies resolved paths stay within output directory
- **MEDIUM**: Fixed SQL injection in reverse-sync — validates table names with same pattern as column names

## [1.2.0] — 2026-04-04

### Changed

- **Auto-combined entity context** — When an entity has multiple rendered files, the first declared file automatically becomes the combined output containing all connected context. No `combined` config needed — the primary entity file (e.g., PROJECT.md) always includes the full assembled context by default. Explicit `combined` config still works for custom output filenames or exclusions.

## [1.1.1] — 2026-04-04

### Fixed

- **ALTER TABLE with non-constant defaults** — `_addMissingColumns` now handles columns with `DEFAULT CURRENT_TIMESTAMP`, `datetime('now')`, or `RANDOM()` defaults. SQLite rejects non-constant defaults in ALTER TABLE ADD COLUMN. The fix strips the non-constant default for the ALTER statement, then backfills existing rows with `CURRENT_TIMESTAMP`. This resolves crash-on-startup when upgrading to a schema that adds new timestamp columns to existing tables.

## [1.1.0] — 2026-04-04

### Added

- **`autoUpdate()` export** — Call at app startup to automatically check npm for a newer version of `latticesql` and install it. Returns `AutoUpdateResult` with `updated`, `packages`, and `restartRequired` fields. Safe to call on every startup — skips if already on latest. Pass `{ quiet: true }` to suppress console output.

## [1.0.0] — 2026-04-04

### Changed

- **Stable release** — latticesql is now 1.0.0. The API is considered stable. Consumers using `^1.0.0` will automatically receive all non-breaking updates.

## [0.18.4] — 2026-04-04

### Added

- **CLI update checker** — `lattice` CLI now checks for new versions in the background and prints a notice when an update is available. Cached for 24 hours.
- **`lattice update` command** — self-update to the latest version from npm.

## [0.18.0] — 2026-04-03

### Added

- **Protected entity contexts** — Set `protected: true` on an entity context to prevent its data from leaking into other entities' rendered context files. Sources referencing a protected table return empty results; within the same protected table, sources return self-only. Access protected data via direct database queries.
- **At-rest encryption** — Set `encrypted: true` (all text columns) or `encrypted: { columns: ['value'] }` (specific columns) on an entity context for transparent AES-256-GCM encryption. Requires `encryptionKey` in `LatticeOptions`. Encrypted values stored as `enc:<base64>`, plaintext values pass through unchanged (migration-safe).
- **`encryptionKey`** option in `LatticeOptions` — master key for deriving AES-256 encryption keys via scrypt.
- **Encryption utilities** — `encrypt()`, `decrypt()`, `deriveKey()`, `isEncrypted()` exported for direct use.

## [0.17.0] — 2026-04-03

### Added

- **`insertReturning(table, row)`** — Insert a row and return the full inserted row (including auto-generated id and default values). Equivalent to `insert()` + `get()` in a single call.
- **`updateReturning(table, id, row)`** — Update a row and return the full updated row. Equivalent to `update()` + `get()`.
- **`migrate(migrations)`** — Run versioned migrations after `init()`. Useful for package-level schema changes applied at runtime. Supports string-based version identifiers (e.g. `"@mypackage:1.0.0"`).
- **Schema-only tables** — `render` and `outputFile` are now optional in `TableDefinition`. Tables defined without rendering produce schema but no output files.
- **Composite primary key auto-constraint** — When `primaryKey` is an array (e.g. `['user_id', 'tag_id']`), a `PRIMARY KEY(...)` table constraint is now automatically generated in the CREATE TABLE statement.

### Changed

- **Migration version type** — `Migration.version` now accepts `number | string` (was `number` only). The `__lattice_migrations` table uses `TEXT PRIMARY KEY` instead of `INTEGER PRIMARY KEY` to support both numeric and string-based versions. Existing integer versions continue to work (backward compatible).
- Migration sort order uses locale-aware numeric comparison (`localeCompare` with `{ numeric: true }`) instead of arithmetic subtraction.

## [0.16.2] — 2026-04-03

### Fixed

- Removed internal build-process file that was accidentally committed to the public repo
- Lint errors: unused `configDir` parameter in `config/parser.ts`, `let` → `const` in integration test
- `outputFile` path doubling when using config-parsed entity tables with relative paths

## [0.16.1] — 2026-04-01

### Fixed

- Export `contentHash()` from package index (documented but previously inaccessible)
- Resolve all 282 ESLint errors blocking CI (floating promises, non-null assertions, template expressions, unused imports)
- Update compatibility matrix for v0.16.0 features

## [0.16.0] — 2026-04-01

### Added

- **Reverse-sync**: Detects external modifications to rendered entity context files and sweeps changes back into the database before re-rendering. Opt-in per file via `reverseSync` function on `EntityFileSpec`. Supports dry-run mode (`reverseSync: 'dry-run'`).
- **Manifest v2**: Per-file SHA-256 content hashes stored in `.lattice/manifest.json` for change detection. v1 manifests are auto-migrated (reverse-sync skips files with no hash baseline).
- New types: `ReverseSyncUpdate`, `ReverseSyncResult`, `ReverseSyncError`, `EntityFileManifestInfo`
- New exports: `entityFileNames()`, `normalizeEntityFiles()`, `isV1EntityFiles()` manifest helpers
- `contentHash()` exported from `render/writer`

### Changed

- `ReconcileResult` now includes `reverseSync: ReverseSyncResult | null`
- `ReconcileOptions` accepts `reverseSync?: boolean | 'dry-run'` (default: `true`)
- Manifest `version` bumped from `1` to `2`; `entities` field changed from `string[]` to `Record<string, EntityFileManifestInfo>`

## [0.14.0] — 2026-03-28

### Added

- **Report framework**: `buildReport()` with time-windowed sections, duration parsing ('8h','24h','7d'), four format types (count_and_list, counts, list, custom)

## [0.13.0] — 2026-03-28

### Added

- **Seeding DSL**: `seed()` method for bulk upsert from structured data (YAML/JSON). Links to entities via junction tables, soft-deletes removed entries. SeedConfig, SeedLinkSpec types.

## [0.12.0] — 2026-03-28

### Added

- **Writeback persistence**: Pluggable `WritebackStateStore` interface. `InMemoryStateStore` (default), `SQLiteStateStore` (persistent across restarts). `createSQLiteStateStore()` factory. `onArchive` lifecycle hook on WritebackDefinition.

## [0.11.0] — 2026-03-28

### Added

- **Generic CRUD layer**: `upsertByNaturalKey()`, `enrichByNaturalKey()`, `softDeleteMissing()`, `getActive()`, `countActive()`, `getByNaturalKey()` — work on ANY table via PRAGMA introspection (no `define()` required)
- **Junction table helpers**: `link()` (INSERT OR IGNORE/REPLACE), `unlink()` (DELETE matching)
- Internal: `_ensureColumnCache()` lazily populates column cache for unregistered tables

## [0.10.0] — 2026-03-27

### Added

- **Write hooks**: `defineWriteHook()` fires after insert/update/delete with table + column filtering. `WriteHook`, `WriteHookContext` types.

## [0.9.0] — 2026-03-27

### Added

- **Entity render templates**: `entity-table`, `entity-profile`, `entity-sections` declarative templates for `EntityFileSpec.render`. Backward compatible with function form. Auto read-only header + frontmatter.

## [0.8.0] — 2026-03-27

### Added

- **Junction column projection**: `junctionColumns` on `ManyToManySource` — include junction table columns in results with optional aliasing
- **Multi-column ORDER BY**: `orderBy` accepts `OrderBySpec[]` array with per-column direction

## [0.7.0] — 2026-03-27

### Added

- **Enriched source type**: `{ type: 'enriched', include: { ... } }` — starts with entity row, attaches related data as `_key` JSON string fields via declarative or custom sub-lookups

## [0.6.0] — 2026-03-27

### Added

- **Source query options**: `filters`, `orderBy`, `orderDir`, `limit`, `softDelete` on `HasManySource`, `ManyToManySource`, `BelongsToSource`
- **sourceDefaults**: `EntityContextDefinition.sourceDefaults` merges into all relationship sources
- **Markdown utilities**: `frontmatter()`, `markdownTable()`, `slugify()`, `truncate()` — composable helpers for render functions

## [0.5.5] — 2026-03-27

### Fixed

- Removed all consumer-specific references from source code and documentation
- `READ_ONLY_HEADER` now uses generic text; `createReadOnlyHeader()` factory for custom headers
- `parseSessionMD` / `parseMarkdownEntries` accept `SessionParseOptions` for configurable entry types/aliases
- Added `scripts/check-generic.sh` guardrail wired into `prepublishOnly`

---

## [0.5.0] — 2026-03-23

### Added

**Entity Context Directories**

A new high-level API for generating parallel file-system trees that mirror your database schema — one directory per entity, one file per relationship type, and an optional combined context file per entity. Replaces ad-hoc `defineMulti()` patterns for per-entity context generation.

- `defineEntityContext(table, def)` — new `Lattice` method, must be called before `init()`. Returns `this` for chaining.
- `EntityContextDefinition` — top-level config type: `slug`, `index?`, `files`, `combined?`, `directory?`, `directoryRoot?`, `protectedFiles?`
- `EntityFileSpec` — per-file spec: `source`, `render`, `budget?`, `omitIfEmpty?`
- Five source types for per-file row resolution:
  - `SelfSource` (`{ type: 'self' }`) — entity row itself
  - `HasManySource` (`{ type: 'hasMany', table, foreignKey, references? }`) — rows on a related table pointing back
  - `ManyToManySource` (`{ type: 'manyToMany', junctionTable, localKey, remoteKey, remoteTable, references? }`) — rows from a remote table via a junction table
  - `BelongsToSource` (`{ type: 'belongsTo', table, foreignKey, references? }`) — single parent row via FK on this entity
  - `CustomSource` (`{ type: 'custom', query: (row, adapter) => Row[] }`) — fully custom query
- `resolveEntitySource(source, entityRow, entityPk, adapter)` — internal resolver (exported for testing)
- `truncateContent(content, budget?)` — truncates at `budget` characters with a `*[truncated — context budget exceeded]*` notice
- `combined` option — concatenates all rendered files with `\n\n---\n\n` dividers into a single combined file per entity, respecting an `exclude` list
- `omitIfEmpty` flag — skip writing a file when the source returns zero rows
- `budget` — per-file character limit with truncation notice
- `directoryRoot` — top-level directory owned by the entity context (defaults to table name); used by orphan cleanup
- `protectedFiles` — filenames Lattice must never delete during cleanup (e.g. `SESSION.md`)
- `directory(row)` — optional custom directory path function (overrides default `{directoryRoot}/{slug}` pattern)

**Lifecycle Management**

Tracks what Lattice has generated and removes orphaned files/directories when entities are deleted or definitions change.

- `reconcile(outputDir, options?)` — new `Lattice` method: runs a full render cycle then cleans up orphans. Returns `ReconcileResult` (`RenderResult` + `CleanupResult`)
- `ReconcileOptions` / `ReconcileResult` — new types
- `WatchOptions.cleanup?: CleanupOptions` — if set, the watch loop reads the previous manifest before each render and runs orphan cleanup after
- `WatchOptions.onCleanup?: (result: CleanupResult) => void` — callback fired after each cleanup cycle in watch mode
- `CleanupOptions` — `{ removeOrphanedDirectories?, removeOrphanedFiles?, protectedFiles?, dryRun?, onOrphan? }`
- `CleanupResult` — `{ directoriesRemoved, filesRemoved, directoriesSkipped, warnings }`
- `cleanupEntityContexts(outputDir, entityContexts, currentSlugsByTable, manifest, options, newManifest?)` — internal cleanup function (exported)

**Manifest**

After every render cycle that includes entity contexts, Lattice writes `.lattice/manifest.json` inside `outputDir`. The manifest is the authoritative record of what Lattice generated — it is what enables safe orphan cleanup.

- `readManifest(outputDir)` — read `.lattice/manifest.json`; returns `LatticeManifest | null`
- `writeManifest(outputDir, manifest)` — write the manifest atomically
- `manifestPath(outputDir)` — return the path to the manifest file
- `LatticeManifest` — `{ version: 1, generated_at, entityContexts: Record<string, EntityContextManifestEntry> }`
- `EntityContextManifestEntry` — `{ directoryRoot, indexFile?, declaredFiles, protectedFiles, entities: Record<slug, string[]> }`

**Documentation**

- `docs/entity-context.md` — complete guide to entity context directories
- Updated `docs/api-reference.md` — all v0.5 types and methods
- Updated `docs/architecture.md` — lifecycle module, manifest, cleanup
- Updated `README.md` — entity context and lifecycle sections

### Changed

- `package.json` version → `0.5.0`
- `RenderEngine._renderEntityContexts()` now returns `Record<string, EntityContextManifestEntry>` and manifests are written after each render cycle that includes entity contexts
- `SyncLoop.watch()` reads the previous manifest before render and calls `RenderEngine.cleanup()` after render when `WatchOptions.cleanup` is set
- `Lattice.reconcile()` reads previous manifest, renders (writing new manifest), then compares old vs new manifest to detect orphans

---

## [0.4.0] — 2026-03-22

### Added

**YAML schema config (`lattice.config.yml`)**

- New `LatticeConfig` / `LatticeEntityDef` / `LatticeFieldDef` types for the YAML config schema
- `parseConfigFile(configPath)` — reads and validates a `lattice.config.yml` file, returns `ParsedConfig`
- `parseConfigString(yaml, configDir)` — parses a raw YAML string (useful in tests and dynamic config)
- Field types: `uuid`, `text`, `integer`, `int`, `real`, `float`, `boolean`, `bool`, `datetime`, `date`, `blob`
- Automatic `belongsTo` relation creation from `ref: <entity>` on a field — `_id` suffix stripped from relation name
- Entity-level `primaryKey` override for composite or custom primary keys
- `render` spec in YAML: accepts a built-in template name string or `{ template, formatRow }` object
- `outputFile` paths resolved relative to the config file directory at parse time

**`lattice generate` CLI**

- New `lattice` binary bundled with the package (`bin.lattice = ./dist/cli.js`)
- `lattice generate` command — reads config, writes `generated/types.ts` and `generated/migration.sql`
- `--config / -c` flag — path to config file (default: `./lattice.config.yml`)
- `--out / -o` flag — output directory (default: `./generated`)
- `--scaffold` flag — also create empty scaffold context files at each entity's `outputFile` path
- `--version / -v` — print installed version
- `--help / -h` — print usage

**`generateTypes(config)`** — TypeScript interface generator

- One `export interface` per entity, PascalCase entity names
- Fields marked `primaryKey: true` or `required: true` are non-optional; all others have `?`
- Inline comment `// → <target>` on `ref` fields
- Type mapping: uuid/text/datetime/date → `string`; integer/int/real/float → `number`; boolean/bool → `boolean`; blob → `Buffer`

**`generateMigration(config)`** — SQL migration generator

- `CREATE TABLE IF NOT EXISTS` per entity
- Full column spec generation: `PRIMARY KEY`, `NOT NULL`, `DEFAULT` (string-quoted or numeric)

**`Lattice({ config })` constructor form**

- New `LatticeConfigInput` type: `{ config: string; options?: LatticeOptions }`
- Constructor overload: `new Lattice({ config: './lattice.config.yml' })` reads the YAML file, resolves `dbPath`, and calls `define()` for each entity automatically

**Exports added to `latticesql`:**

- `parseConfigFile`, `parseConfigString`, `ParsedConfig`
- `LatticeConfigInput`
- `LatticeFieldType`, `LatticeFieldDef`, `LatticeEntityDef`, `LatticeEntityRenderSpec`, `LatticeConfig`

**Documentation**

- `docs/api-reference.md` — complete per-method API reference
- `docs/configuration.md` — full YAML config format guide
- `docs/templates.md` — built-in templates and render hooks
- `docs/migrations.md` — schema migration workflow
- `docs/cli.md` — CLI reference
- `docs/architecture.md` — internals walkthrough
- `docs/examples/agent-system.md` — complete agent system example
- `docs/examples/ticket-tracker.md` — complete ticket tracker example
- `docs/examples/cms.md` — complete CMS example
- `CONTRIBUTING.md` — dev setup and contribution guide

### Changed

- `package.json` version → `0.4.0`
- `better-sqlite3` → `^12.8.0` (Node 25 compatibility; Node 25 requires the updated C++ bindings)
- `tsup.config.ts` refactored to array form: separate library and CLI build entries; CLI entry adds `#!/usr/bin/env node` shebang via `banner`
- `yaml` `^2.8.3` added to runtime dependencies

### Fixed

- TypeScript `exactOptionalPropertyTypes` error in `src/render/templates.ts` — `_NormalizedSpec.hooks` typed as `hooks?: RenderHooks | undefined`
- CLI `ParsedArgs.command` typed as `command?: string | undefined` to satisfy strict optional property checks

---

## [0.3.0] — 2026-03-18

### Added

**Built-in render templates**

- `BuiltinTemplateName` type: `'default-list' | 'default-table' | 'default-detail' | 'default-json'`
- `RenderHooks` interface: `{ beforeRender?, formatRow? }`
- `TemplateRenderSpec` interface: `{ template: BuiltinTemplateName; hooks?: RenderHooks }`
- `RenderSpec` union type: function | `BuiltinTemplateName` | `TemplateRenderSpec`
- `compileRender()` — converts any `RenderSpec` to `(rows: Row[]) => string` at `define()` time (zero per-cycle overhead)
- `interpolate(template, row, relations)` — `{{field}}` and `{{relationName.field}}` substitution engine

**Built-in template implementations**

- `default-list` — bulleted Markdown list, supports `formatRow` hook
- `default-table` — GitHub-flavoured Markdown table, headers from first row keys
- `default-detail` — one Markdown section per row, supports `formatRow` hook
- `default-json` — `JSON.stringify(rows, null, 2)` in a fenced code block

**`beforeRender` hook** — transform or filter rows before rendering; called before `formatRow`

**`formatRow` hook** — accepts a `(row: Row) => string` function or a `{{field}}` template string

**Relation resolution in templates** — `belongsTo` relations declared in `TableDefinition.relations` are joined in-process when `{{rel.field}}` tokens are found in `formatRow` strings

### Changed

- `TableDefinition.render` now accepts `RenderSpec` (function | string | object) instead of only `(rows: Row[]) => string`
- All existing function-form render definitions are fully backward compatible — no changes needed

---

## [0.2.0] — 2026-03-14

### Added

**Configurable primary key**

- `TableDefinition.primaryKey?: PrimaryKey` — single column name (`string`) or composite (`string[]`)
- Default remains `'id'` (UUID auto-generated on insert when absent)
- Custom PK: caller must supply value on every insert; no UUID generated
- Composite PK: `PkLookup` accepts `Record<string, unknown>` in addition to `string`

**Expanded query filters**

- `FilterOp` type: `'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isNull' | 'isNotNull'`
- `Filter` interface: `{ col: string; op: FilterOp; val?: unknown }`
- `QueryOptions.filters?: Filter[]` — advanced filter clauses combined with `where` using AND
- `CountOptions` — same `where` + `filters` as `QueryOptions`

**Relationship declarations**

- `BelongsToRelation` — `{ type: 'belongsTo', table, foreignKey, references? }`
- `HasManyRelation` — `{ type: 'hasMany', table, foreignKey, references? }`
- `TableDefinition.relations?: Record<string, Relation>` — metadata used by template rendering in v0.3+

**`tableConstraints`**

- `TableDefinition.tableConstraints?: string[]` — SQL table-level constraints appended to `CREATE TABLE`
- Required for composite PKs and multi-column unique constraints

**`upsertBy(table, col, val, row)`** — insert-or-update by an arbitrary column (not the PK)

**`count(table, opts?)`** — count rows with optional where/filters

### Changed

- `SchemaManager.define()` validates that the primary key column is non-empty
- `_pkWhere()` now dispatches on `PkLookup` type to build correct WHERE clause

---

## [0.1.0] — 2026-03-10

### Added

Initial release.

**Core API**

- `Lattice(path, options?)` constructor
- `define(table, def)` — register a table schema
- `defineMulti(name, def)` — register a multi-table view
- `defineWriteback(def)` — register a writeback pipeline
- `init(options?)` — open database, apply schema, run migrations
- `close()` — close database connection
- `insert(table, row)` — insert a row; auto-generate UUID for default `id` PK
- `upsert(table, row)` — `INSERT OR REPLACE` semantics
- `update(table, id, row)` — update one row by PK
- `delete(table, id)` — delete one row by PK
- `get(table, id)` — fetch one row by PK
- `query(table, opts?)` — query rows with `where`, `orderBy`, `orderDir`, `limit`, `offset`
- `render(outputDir)` — render all tables to context files once
- `sync(outputDir)` — render + process writeback entries
- `watch(outputDir, opts?)` — start polling sync loop; returns `StopFn`
- `on(event, handler)` — subscribe to `'audit'`, `'render'`, `'writeback'`, `'error'` events
- `db` escape hatch — direct `better-sqlite3` database access

**Schema**

- `TableDefinition` — `columns`, `render` (function only), `outputFile`, `filter`, `primaryKey` (default `'id'`)
- Migration system — `_lattice_migrations` tracking table, version-based deduplication

**Security**

- `Sanitizer` — null-byte stripping, field length limits, audit event emission
- `SecurityOptions` — `sanitize`, `auditTables`, `fieldLimits`

**Infrastructure**

- `SQLiteAdapter` — `better-sqlite3` wrapper with WAL mode + busy timeout support
- `SchemaManager` — schema registry, `applySchema()`, `applyMigrations()`
- `RenderEngine` — file-write deduplication (skip unchanged content)
- `SyncLoop` — `setInterval`-based polling
- `WritebackPipeline` — offset-based file reading with dedup key support

**Exports**

- All public types exported from `latticesql`
- ESM + CJS dual build via tsup

## [0.18.2] — 2026-04-03

### Added

- **`fixSchemaConflicts(db, checks)`** — Pre-init utility to resolve legacy schema conflicts. Renames tables with incompatible columns to `_legacy_{name}` so `init()` can create fresh tables. Also handles `__lattice_migrations` INTEGER→TEXT PK migration.
