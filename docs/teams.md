# Lattice Teams

Multi-user cloud-shared Lattice databases on your own Postgres. The same `latticesql` binary boots in two modes:

- **Local mode** — what you've always used. SQLite (or your own Postgres) for a single user.
- **Team-cloud mode** — `lattice gui --team-cloud` exposes a bearer-gated HTTP API on top of a Postgres database that one or more local Lattices sync into. Identity is local-first (email + bearer tokens, no central web auth). Invitations are bound to a recipient email so an invite token is safe to share over an unauthenticated channel.

One cloud = one team. The cloud's Postgres database holds the team identity, member list, shared object schemas, change log, and row-link table. Each member's local Lattice keeps a connection row, an outbox, and a DLQ. The puller and outbox drainer drive the sync loop.

---

## Architecture at a glance

```
┌─ Alice's local lattice ─────────┐                      ┌─ Bob's local lattice ──────────┐
│                                 │                      │                                │
│  user-defined entities          │                      │  user-defined entities         │
│  __lattice_team_connections     │                      │  __lattice_team_connections    │
│  __lattice_local_links          │ ──┐         ┌──── ── │  __lattice_local_links         │
│  __lattice_team_outbox          │   │         │        │  __lattice_team_outbox         │
│  __lattice_team_dlq             │   │         │        │  __lattice_team_dlq            │
└─────────────────────────────────┘   │         │        └────────────────────────────────┘
                                      ▼         ▼
                              ┌─ Cloud Postgres (team-cloud mode) ─┐
                              │                                    │
                              │  __lattice_users                   │
                              │  __lattice_api_tokens              │
                              │  __lattice_team                    │
                              │  __lattice_team_identity           │  ← singleton, "this cloud's team"
                              │  __lattice_team_members            │
                              │  __lattice_invitations             │
                              │  __lattice_shared_objects          │
                              │  __lattice_object_owners           │  ← per-table ownership (v1.14)
                              │  __lattice_change_log              │
                              │  __lattice_row_links               │
                              │  (mirrored user tables for shared  │
                              │   objects + linked rows)           │
                              └────────────────────────────────────┘
```

The cloud Postgres is fully under the operator's control — Lattice doesn't host anything. Connection URLs (with passwords) live encrypted in each operator's `~/.lattice/db-credentials.enc`; the YAML config references them by label (`db: ${LATTICE_DB:atlas}`).

---

## Local user config (`~/.lattice/`)

Machine-local, outside any Lattice DB. Files are created lazily on first use; the directory is `chmod 0700` on POSIX, best-effort on Windows.

| File                 | Purpose                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `master.key`         | 32-byte AES-256 key (base64). Auto-generated. `LATTICE_ENCRYPTION_KEY` env var takes precedence. `chmod 0600`. |
| `identity.json`      | `{display_name, email}`. Mirrored into `__lattice_user_identity` (singleton) on every Lattice open.            |
| `db-credentials.enc` | AES-GCM-encrypted JSON `{ [label]: postgresUrl }`. Decrypted in-memory; never returned over HTTP.              |
| `keys/<label>.token` | Per-joined-team bearer token. One file per joined team.                                                        |

The `src/framework/user-config.ts` module exposes the read/write API:

```ts
import {
  getOrCreateMasterKey,
  readIdentity,
  writeIdentity,
  saveDbCredential,
  getDbCredential,
  writeToken,
  readToken,
} from 'latticesql/framework/user-config';
```

---

## Identity & email-bound invitations

`__lattice_users.email` is `NOT NULL`. Every member of the cloud's team has a `__lattice_team_members` row keyed by `(team_id, user_id)`, and the team has a singleton `__lattice_team_identity` row carrying the team name + creator email.

Invitations have an `invitee_email TEXT NOT NULL` column. `POST /api/auth/redeem-invite` requires `{email, invite_token, name}` and verifies that the caller's claimed email matches the invitation's bound `invitee_email` (case-insensitive). Mismatched email → `403`. The check happens **before** the token-already-used check, so an attacker who steals an invite link still can't redeem it without also knowing (or guessing) the bound email.

The bootstrap flow:

```
1. Operator A points lattice at a fresh cloud Postgres.
2. POST /api/auth/register { email, name, team_name }
   → atomic: creates user A, the singleton team, A's creator membership, A's bearer token.
   ← { user, raw_token, team }
3. A invites B: POST /api/team/invitations { invitee_email: 'b@example.com' }
   → { raw_token: 'latinv_…' }
4. A shares the latinv_ token with B (e.g. email or chat).
5. B redeems: POST /api/auth/redeem-invite
   { invite_token, email: 'b@example.com', name: 'B' }
   → { user, raw_token, team }   (B is now a member; bearer token issued)
```

After the first user exists, `POST /api/auth/register` returns `403` — new members must come through `redeem-invite`.

---

## HTTP surface

All routes live on the cloud Postgres-backed Lattice booted via `lattice gui --team-cloud`. Auth is `Authorization: Bearer <token>` with the token issued by `register` or `redeem-invite`.

**Unauthenticated** (the only routes the cloud accepts without a bearer):

| Method | Route                     | Notes                                                                     |
| ------ | ------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/auth/register`      | Bootstrap-only — fails 403 once a user exists. Atomic with team creation. |
| POST   | `/api/auth/redeem-invite` | Email-bound; checks `invitee_email` match before consuming the token.     |

**Authenticated**:

| Method | Route                                          | Notes                                                         |
| ------ | ---------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/auth/me`                                 | Current user from the bearer.                                 |
| POST   | `/api/auth/tokens`                             | Mint a second bearer for this user.                           |
| DELETE | `/api/auth/tokens/:id`                         | Revoke a bearer (self-revoke allowed).                        |
| GET    | `/api/team`                                    | Singleton: team identity + member list.                       |
| DELETE | `/api/team`                                    | Destroy the team (creator-only).                              |
| POST   | `/api/team/invitations`                        | Invite by email (creator-only). Singleton alias.              |
| GET    | `/api/teams/:id/members`                       | Members of the (one) team.                                    |
| DELETE | `/api/teams/:id/members/:userId`               | Kick (creator-only) or self-leave.                            |
| POST   | `/api/teams/:id/invitations`                   | Multi-team-shaped alias for `POST /api/team/invitations`.     |
| POST   | `/api/teams/:id/objects`                       | Share a table (member-only).                                  |
| GET    | `/api/teams/:id/objects`                       | List shared objects (member-only).                            |
| DELETE | `/api/teams/:id/objects/:table`                | Unshare (sharer or creator).                                  |
| GET    | `/api/teams/:id/changes?since=<seq>&limit=<n>` | Pull the monotonic change feed (envelopes for schema + rows). |
| POST   | `/api/teams/:id/objects/:table/links`          | Link a local row to the team.                                 |
| DELETE | `/api/teams/:id/objects/:table/links/:pk`      | Unlink (owner or creator).                                    |
| POST   | `/api/teams/:id/objects/:table/rows`           | Push an owner-side update.                                    |
| DELETE | `/api/teams/:id/objects/:table/rows/:pk`       | Owner-side delete (emits `unlink` envelope to receivers).     |

`/api/team/*` are the singleton-shaped routes for new code. `/api/teams/:id/*` are the per-team routes — there's only ever one team, so `:id` is just the singleton's UUID. Both are kept because the sync engine is happier addressing the team by id.

---

## Local → Cloud-Workspace progression (v1.13+, reframed in v1.16.3)

The GUI's Database panel models the project lifecycle as a one-way state machine: a project starts on local SQLite and can be promoted to a BYO Postgres. As of v1.16.3 a cloud database **is** a cloud workspace with members — there is no separate "upgrade to team" step and no intermediate `cloud-connected` state. Migrating or connecting to Postgres initializes the workspace's member/share machinery automatically (the opener becomes owner). There is no revert path in the UI.

```
LOCAL  →  CLOUD WORKSPACE (creator | member | needs-invite)
       migrate / connect-existing (+invite)
```

State detection (returned by `GET /api/dbconfig` as the `state` field; `isCreator`, `teamId`, and `myUserId` are returned alongside it for the SPA's member-admin UI):

| State                     | Detection                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `local`                   | YAML `db:` is a local path (not `${LATTICE_DB:...}` and not `postgres://...`).                                                     |
| `team-cloud-creator`      | YAML is cloud, identity row present, and the operator's resolved identity is a member whose user id matches the workspace creator. |
| `team-cloud-member`       | YAML is cloud, identity row present, operator is a member but not the creator.                                                     |
| `team-cloud-needs-invite` | YAML is cloud, identity row present, but the operator is **not** a member (no `__lattice_team_members` row resolves for them).     |

> **v1.16.3 change:** the `cloud-connected` state was removed. A Postgres-backed database whose `__lattice_team_identity` row is absent now initializes that row automatically (on migrate, connect, or open), so it resolves directly to one of the three `team-cloud-*` states rather than sitting in an intermediate "connected but not a workspace" state. The SPA badge labels these "CLOUD · OWNER / MEMBER / NEEDS INVITE".
>
> **v1.14 change:** membership is the authoritative signal — the state is derived from whether the operator's identity resolves to a live `__lattice_team_members` row, not from whether a `~/.lattice/keys/<label>.token` file happens to be on disk. This stopped an already-joined member from being shown the "paste invite token to join" panel.

### Transition: Local → Cloud (migrate)

Driven by `POST /api/dbconfig/migrate-to-cloud`. The handler:

1. Probes the target via `probeCloud(url)` → refuses on `reachable: false` (502) or `teamEnabled: true` (409 — migration is into-empty only).
2. Opens a fresh target Lattice via `openTargetLatticeForMigration(configPath, url, encryptionKey)` — registers the same user entities + native `secrets`/`files` as the source, then `init()`s.
3. Calls `migrateLatticeData(source, target)` — copies every user-defined entity row + `secrets` + `files` row in batches of 500. Encrypted columns round-trip via decrypt-on-read + encrypt-on-write.
4. Closes the target. Calls `archiveLocalSqlite(sourceDbPath)` to rename `<name>.db` (+ `-shm`/`-wal`) to `.db.local-bak`.
5. `saveDbCredential(label, url)` + rewrites the YAML's `db:` line to `${LATTICE_DB:<label>}`.
6. Swaps the active Lattice via the GUI server's `swap()` callback.

On any error before step 4 the YAML is untouched and the SQLite file stays in place. Blobs under `data/blobs/` are not moved — the migrated `files` rows reference relative paths that remain valid against the same project root.

### Transition: Join a team via invite

Driven by `POST /api/dbconfig/connect-existing`. (The standalone "Connect to existing cloud" wizard was removed in 1.16.4 — the two cloud operations are Migrate to cloud and Join a team via invite; this endpoint now backs the invite‑redeem case for an active cloud.) Used when a teammate has already created a team — you redeem an invite to join; the local project's data is discarded.

1. Probes the target.
2. If `teamEnabled: true`, requires `invite_token` in the body. The handler resolves email + display name from `~/.lattice/identity.json`, calls `TeamsClient.connectToExistingCloud()` which internally runs `POST /api/auth/redeem-invite` against the cloud.
3. On success the bearer lands in `~/.lattice/keys/<label>.token` and the credential in `db-credentials.enc`. The YAML is rewritten, active Lattice swapped.

### Automatic workspace initialization (v1.16.3)

There is no longer an explicit "upgrade to team" transition. The member/share machinery (`__lattice_users` / `__lattice_api_tokens` / `__lattice_team` / `__lattice_team_members` / `__lattice_team_identity` + bearer + saved connection) is created automatically at three points:

1. **Migrate-to-cloud** — after the data copy succeeds, the migrating operator becomes the workspace owner.
2. **Connect-to-existing** — if the target cloud has no `__lattice_team_identity` yet, the connecting operator initializes it as owner.
3. **On open** — opening a Postgres-backed database that lacks `__lattice_team_identity` initializes it lazily (opener = owner).

All three call `TeamsClient.ensureCloudWorkspaceIdentity({ label, cloudUrl, workspaceName, email, displayName })` (idempotent — a no-op if the cloud is already a workspace; the workspace name defaults to the database label). It refuses only when the operator has no identity email (clear error → set it in User Settings), and a duplicate-identity race is treated as "already a workspace". The `POST /api/dbconfig/upgrade-to-team` route was removed.

### v1.13 HTTP routes (thin wrappers over the public API)

| Method | Route                            | Wraps                                                                                   |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/dbconfig`                  | adds `state` field per the table above                                                  |
| POST   | `/api/dbconfig/probe`            | `probeCloud(url)` from `latticesql/framework/cloud-connect`                             |
| POST   | `/api/dbconfig/migrate-to-cloud` | `migrateLatticeData` + `archiveLocalSqlite` from `latticesql/framework/cloud-migration` |
| POST   | `/api/dbconfig/connect-existing` | `TeamsClient.connectToExistingCloud`                                                    |

All are reachable as public functions from the `latticesql` package — the frontend is just a wrapper.

---

## CLI

```
lattice teams <subcommand> [options]

Subcommands:
  register   Bootstrap on a fresh cloud: create user + team in one call
             (requires --cloud --email --name --team-name)
  join       Redeem an invitation (requires --cloud --token --email --name)
  list       List your local team connections
  members    List members of the team (--team)
  invite     Generate an invitation (creator only; --team --invitee-email)
  leave      Leave the team (--team)
  destroy    Destroy the team (creator only; --team)
  share      Share a local table (--team --table)
  unshare    Stop sharing a table (--team --table)
  shared     List shared objects (--team)
  sync       Apply cloud-shared schemas locally (--team)
  link       Link a local row (--team --table --pk)
  unlink     Unlink a row (--team --table --pk)
  pull       Pull change envelopes (--team)
  push       Drain the outbox (--team)
  status     Show sync status (--team)
  dlq        Inspect the dead-letter queue: dlq list|retry|purge (--team [--id])
```

`--name` is the user's display name; `--team-name` is the team's name. They were previously overloaded onto a single `--name` flag — that was clarified in v1.12.

---

## GUI (v1.14+)

`lattice gui` (no `--team-cloud`) drives the same flows from a browser. As of v1.14 the settings sidebar has three entries and **Workspace Settings is the hub for everything about the active database** — there is no separate "Teams" or "Project Config" page:

- **Lattice Settings** — the catalog of every database this lattice can switch to (the same list as the header dropdown), plus an Add-new-database entry. Each row shows a Local | Cloud tag, and is click-to-switch (no per-row Delete — deletion lives in each workspace's Danger Zone).
- **Workspace Settings** — everything about the _active_ database:
  - **Name** — editable for the owner; read-only for members. Cloud renames write `__lattice_team_identity.team_name` and broadcast to every member in realtime; local renames write a `name:` key into the YAML.
  - **Database** — connection summary + state badge. For a cloud workspace it shows the **Members** list inline, including **pending invitees** who haven't joined yet (the owner is always listed as `creator`, and your own row is marked "(you)").
  - **Data Model** — the entity graph (moved here from a separate nav item), including the native `files`/`secrets` objects, with a **Share with workspace / Make private** toggle on each table you own and nodes colored by share status (yellow = shared, red = private, green = selected).
- **User Settings** — identity (`~/.lattice/identity.json`) + machine-local preferences. The Join-via-invite modal pulls your email + display name from here read-only, so you always join as yourself.

Member administration is resolved against the active cloud database (workspace id + your user id + role come from `GET /api/dbconfig`), so it works whether the cloud workspace itself is the active DB or you're on a local DB with a saved connection:

- **Invite** (owner only) generates an email-bound `latinv_` token. Pending invitees appear in the Members list until redeemed (`GET /api/teams/:id/invitations`).
- **Kick** (owner only) removes another member; the button is hidden for non-owners and the route 403s them.
- **Leave** (your own row, member) / **Disconnect** (owner, Danger Zone) removes you from the workspace. Leaving tears down the local config + saved credential so the database disappears from the dropdown and is no longer reachable, then switches you to another database.

The GUI is localhost-only and unauthenticated by default. `--team-cloud` mode swaps the dev-tool surface for the bearer-gated cloud routes.

---

## Per-table ownership & opt-in sharing (v1.14+)

In direct-Postgres team mode every member connects to the **same physical Postgres**, so every table exists for everyone at the SQL level. Visibility is therefore enforced at the application layer.

- A new cloud table **`__lattice_object_owners`** `(team_id, table_name) PK, owner_user_id, created_at` records the creator of every user-facing table (including the native `files`/`secrets` objects).
- **A user sees only the tables they own, plus tables explicitly shared to the team** (present in `__lattice_shared_objects`). This filter gates the GUI's queryable allowlist, the entity cards, and the Data Model graph — so a table you can't see is also not reachable through the API.
- **Native `files`/`secrets` are owned by the database creator and are private by default** — other members can't see or query them unless the owner shares them.
- Ownership is recorded at table-creation time (first-writer-wins) and reconciled on open: any unowned table is assigned to the team creator, so visibility is deterministic. Creating a table no longer auto-shares it — sharing is an explicit action in the Data Model dialog, and only the owner of a table may share or unshare it.

---

## Conflict resolution & sync semantics

This is what the sync loop actually does today — read it before designing a multi-writer workflow on top of Teams.

- **Last-write-wins, no version comparison.** Applying a pulled `upsert` envelope is a blind `local.upsert(table, payload)`. There is no `updated_at` / version-vector check, no causal ordering, and no merge step — whichever write the cloud serializes last is the one everyone ends up with. The cloud `__lattice_change_log.seq` is a monotonic **delivery cursor** (so a receiver knows where it left off), not a conflict signal.
- **Single-writer per row (owner-only push).** A row is owned by whoever first `link`ed it (`__lattice_row_links.owner_user_id`). The cloud rejects a push to a row from anyone but its owner with `403`. So in practice two members can't both push the _same_ row — only its owner can. Different rows can have different owners.
- **Non-owner local edits are overwritten on the next pull.** A non-owner can still edit a mirrored row in their own local DB. That edit produces **no** outbox entry (only owners push), so it never reaches the cloud — and the owner's next update overwrites it. As of **v1.14+** this is no longer silent: before the overwrite, the puller compares the current local row against `__lattice_local_links.synced_hash` (the hash captured at the last sync) and, if they differ, writes a **`divergence`** entry to the DLQ capturing both the lost local content and the incoming row. The row still converges to the owner's state (LWW); the loss is now visible.
- **DLQ = pull-apply failures + divergence notices.** When a pulled envelope throws while applying (e.g. it arrived before the table/dependency it needs), it lands in `__lattice_team_dlq` and the pull cursor advances past it — so one bad envelope doesn't stall the stream, but the envelope isn't lost. Inspect and recover with:

  ```
  lattice teams dlq list  --team <name>           # show entries (op, target, error)
  lattice teams dlq retry --team <name> [--id <id>]  # replay; succeeds clear, failures stay
  lattice teams dlq purge --team <name> [--id <id>]  # discard without applying
  ```

  `retry` replays through the normal apply path, so an envelope that failed because its dependency hadn't arrived yet applies cleanly once the dependency lands. (Push failures are different — they stay in the **outbox** and retry automatically with exponential backoff; they never enter the DLQ.)

- **Recommended operating practice.** Until the conflict rate on your team is understood, review `lattice teams dlq list` periodically (e.g. weekly). A non-empty DLQ means either an out-of-order delivery to replay or a divergence to reconcile — both want a human's eye.

---

## Schema reference

Cloud-side:

| Table                      | Columns                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `__lattice_users`          | `id, email NOT NULL, name, created_at, updated_at, deleted_at`                                                                         |
| `__lattice_api_tokens`     | `id, user_id, token_hash UNIQUE, name, created_at, last_used_at, revoked_at`                                                           |
| `__lattice_team`           | `id, name, created_by_user_id, created_at, updated_at, deleted_at`                                                                     |
| `__lattice_team_identity`  | `id='singleton', team_id, team_name, creator_email, created_at`                                                                        |
| `__lattice_team_members`   | `(team_id, user_id) PK, role IN ('creator','member'), joined_at`                                                                       |
| `__lattice_invitations`    | `id, team_id, token_hash UNIQUE, invitee_email NOT NULL, invited_by_user_id, created_at, expires_at, redeemed_at, redeemed_by_user_id` |
| `__lattice_shared_objects` | `(team_id, table_name) PK, schema_spec_json, schema_version, …` — tables shared to the whole team                                      |
| `__lattice_object_owners`  | `(team_id, table_name) PK, owner_user_id, created_at` — creator of every user-facing table; drives per-user visibility (v1.14+)        |
| `__lattice_change_log`     | `id, seq (monotonic), team_id, table_name, pk, op, payload_json, owner_user_id, created_at`                                            |
| `__lattice_row_links`      | `(team_id, table_name, pk) PK, owner_user_id, linked_at`                                                                               |

Local-side:

| Table                        | Columns                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `__lattice_user_identity`    | Singleton (`id='singleton'`) mirroring `~/.lattice/identity.json`.                                                                                           |
| `__lattice_team_connections` | `team_id PK, team_name, cloud_url, my_user_id, api_token_encrypted, last_change_seq, joined_at`                                                              |
| `__lattice_local_links`      | `__lattice_row_links` shape plus `synced_hash` (last-applied row hash, for divergence detection on receiver mirrors — v1.14+)                                |
| `__lattice_team_outbox`      | FIFO outbox of local writes pending **push** to the cloud (retries with exponential backoff)                                                                 |
| `__lattice_team_dlq`         | Dead-letter for change envelopes that failed to apply on **pull**, plus non-owner-overwrite divergence notices (inspect/retry/purge via `lattice teams dlq`) |

---

## Limits + known gaps (v1.12)

- **No web identity layer.** Email is asserted by the local install, not verified. Two coordinating users could collide on the same email. A future release may add latticesql.com-side identity for compliance/audit use cases.
- **Bearer tokens never expire** until explicitly revoked. Use `lattice teams destroy` (or `DELETE /api/team`) to drop the whole team — this cascades to memberships + tokens.
- **One team per DB.** If you need multiple teams, stand up multiple cloud Postgres databases — each gets its own URL in `db-credentials.enc` and its own YAML config.
- **Schema migrations on shared tables** are additive only. Dropping a column from a shared table will surface as a divergence on receivers; coordinate manually.
- **Postgres SSL** is up to your connection string. Lattice doesn't override; pass `?sslmode=require` (or your provider's equivalent) in the URL.
