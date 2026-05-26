# Changelog

All notable changes to `latticesql` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

---

## [Unreleased]

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

- **Autocapitalize on User / Host / Database / Label inputs.** macOS Safari and iOS default to `autocapitalize="sentences"` on plain `<input type="text">`. Pasting a Supabase tenant user like `postgres.<project-ref>` ended up as `Postgres.<project-ref>` on submit — Postgres roles are case-sensitive, so SCRAM auth failed silently with no hint about the case mismatch. Every text input in `postgresFormHtml` now sets `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`.
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

- **`INSERT OR IGNORE ... SELECT ...` with string literals in the SELECT body now translates correctly.** Previously the `ON CONFLICT DO NOTHING` clause was appended per code region in `translateDialect`, which put it directly after the column list when the SELECT body contained string literals (they split the SQL into multiple code regions in the tokenizer). The resulting SQL had the clause before the `SELECT ... FROM ... LIMIT N` tail, which Postgres rejected with `syntax error near '<string literal>'`. Fix: track the `INSERT OR IGNORE` flag across the whole statement and append `ON CONFLICT DO NOTHING` once at the END of the full SQL. Regression test added for the canonical `INSERT OR IGNORE INTO file ... SELECT 'uuid', id, 'name', ... FROM org LIMIT 1` pattern that the Automated Industries app's migrations use.

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
