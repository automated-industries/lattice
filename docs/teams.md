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

| File                          | Purpose                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `master.key`                  | 32-byte AES-256 key (base64). Auto-generated. `LATTICE_ENCRYPTION_KEY` env var takes precedence. `chmod 0600`. |
| `identity.json`               | `{display_name, email}`. Mirrored into `__lattice_user_identity` (singleton) on every Lattice open. |
| `db-credentials.enc`          | AES-GCM-encrypted JSON `{ [label]: postgresUrl }`. Decrypted in-memory; never returned over HTTP.  |
| `keys/<label>.token`          | Per-joined-team bearer token. One file per joined team.                                            |

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

| Method | Route                          | Notes                                                                                 |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| POST   | `/api/auth/register`           | Bootstrap-only — fails 403 once a user exists. Atomic with team creation.             |
| POST   | `/api/auth/redeem-invite`      | Email-bound; checks `invitee_email` match before consuming the token.                 |

**Authenticated**:

| Method | Route                                          | Notes                                                          |
| ------ | ---------------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/auth/me`                                 | Current user from the bearer.                                  |
| POST   | `/api/auth/tokens`                             | Mint a second bearer for this user.                            |
| DELETE | `/api/auth/tokens/:id`                         | Revoke a bearer (self-revoke allowed).                         |
| GET    | `/api/team`                                    | Singleton: team identity + member list.                        |
| DELETE | `/api/team`                                    | Destroy the team (creator-only).                               |
| POST   | `/api/team/invitations`                        | Invite by email (creator-only). Singleton alias.               |
| GET    | `/api/teams/:id/members`                       | Members of the (one) team.                                     |
| DELETE | `/api/teams/:id/members/:userId`               | Kick (creator-only) or self-leave.                             |
| POST   | `/api/teams/:id/invitations`                   | Multi-team-shaped alias for `POST /api/team/invitations`.      |
| POST   | `/api/teams/:id/objects`                       | Share a table (member-only).                                   |
| GET    | `/api/teams/:id/objects`                       | List shared objects (member-only).                             |
| DELETE | `/api/teams/:id/objects/:table`                | Unshare (sharer or creator).                                   |
| GET    | `/api/teams/:id/changes?since=<seq>&limit=<n>` | Pull the monotonic change feed (envelopes for schema + rows).  |
| POST   | `/api/teams/:id/objects/:table/links`          | Link a local row to the team.                                  |
| DELETE | `/api/teams/:id/objects/:table/links/:pk`      | Unlink (owner or creator).                                     |
| POST   | `/api/teams/:id/objects/:table/rows`           | Push an owner-side update.                                     |
| DELETE | `/api/teams/:id/objects/:table/rows/:pk`       | Owner-side delete (emits `unlink` envelope to receivers).      |

`/api/team/*` are the singleton-shaped routes for new code. `/api/teams/:id/*` are the per-team routes — there's only ever one team, so `:id` is just the singleton's UUID. Both are kept because the sync engine is happier addressing the team by id.

---

## Local → Cloud → Team-Cloud progression (v1.13+)

The GUI's Database panel models the project lifecycle as a one-way state machine: a project starts on local SQLite, can be promoted to a BYO Postgres (data migration), and a non-team cloud can be upgraded to a team cloud. There is no revert path in the UI.

```
LOCAL  →  CLOUD CONNECTED  →  TEAM CLOUD (creator | member | needs-invite)
       migrate              upgrade / connect-existing+invite
```

State detection (returned by `GET /api/dbconfig` as the `state` field):

| State                       | Detection                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `local`                     | YAML `db:` is a local path (not `${LATTICE_DB:...}` and not `postgres://...`).                                                |
| `cloud-connected`           | YAML resolves to a Postgres URL, `__lattice_team_identity` row absent.                                                         |
| `team-cloud-creator`        | YAML is cloud, identity row present, `~/.lattice/keys/<label>.token` exists, and `identity.email` matches `creator_email`.    |
| `team-cloud-member`         | YAML is cloud, identity row present, token exists, but email doesn't match the creator.                                       |
| `team-cloud-needs-invite`   | YAML is cloud, identity row present, no token in `~/.lattice/keys/`.                                                          |

### Transition: Local → Cloud (migrate)

Driven by `POST /api/dbconfig/migrate-to-cloud`. The handler:

1. Probes the target via `probeCloud(url)` → refuses on `reachable: false` (502) or `teamEnabled: true` (409 — migration is into-empty only).
2. Opens a fresh target Lattice via `openTargetLatticeForMigration(configPath, url, encryptionKey)` — registers the same user entities + native `secrets`/`files` as the source, then `init()`s.
3. Calls `migrateLatticeData(source, target)` — copies every user-defined entity row + `secrets` + `files` row in batches of 500. Encrypted columns round-trip via decrypt-on-read + encrypt-on-write.
4. Closes the target. Calls `archiveLocalSqlite(sourceDbPath)` to rename `<name>.db` (+ `-shm`/`-wal`) to `.db.local-bak`.
5. `saveDbCredential(label, url)` + rewrites the YAML's `db:` line to `${LATTICE_DB:<label>}`.
6. Swaps the active Lattice via the GUI server's `swap()` callback.

On any error before step 4 the YAML is untouched and the SQLite file stays in place. Blobs under `data/blobs/` are not moved — the migrated `files` rows reference relative paths that remain valid against the same project root.

### Transition: Local → Cloud (connect to existing)

Driven by `POST /api/dbconfig/connect-existing`. Used when a teammate has already created a team — the local project's data is discarded.

1. Probes the target.
2. If `teamEnabled: true`, requires `invite_token` in the body. The handler resolves email + display name from `~/.lattice/identity.json`, calls `TeamsClient.connectToExistingCloud()` which internally runs `POST /api/auth/redeem-invite` against the cloud.
3. On success the bearer lands in `~/.lattice/keys/<label>.token` and the credential in `db-credentials.enc`. The YAML is rewritten, active Lattice swapped.

### Transition: Cloud → Team Cloud (upgrade)

Driven by `POST /api/dbconfig/upgrade-to-team`. Available only when the panel is in `cloud-connected` state.

1. Reads cloud URL from the saved credential (looked up by the active label).
2. Reads identity from `~/.lattice/identity.json` (refuses if email or display name is empty).
3. Calls `TeamsClient.upgradeToTeamCloud()` which runs the atomic `POST /api/auth/register` flow against the cloud — creates the user, the team, the creator membership, and the bearer in one call.
4. Writes the bearer to `~/.lattice/keys/<label>.token`. Swaps the active Lattice so the panel re-renders into `team-cloud-creator`.

### v1.13 HTTP routes (thin wrappers over the public API)

| Method | Route                                  | Wraps                                                  |
| ------ | -------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/dbconfig`                        | adds `state` field per the table above                 |
| POST   | `/api/dbconfig/probe`                  | `probeCloud(url)` from `latticesql/framework/cloud-connect` |
| POST   | `/api/dbconfig/migrate-to-cloud`       | `migrateLatticeData` + `archiveLocalSqlite` from `latticesql/framework/cloud-migration` |
| POST   | `/api/dbconfig/connect-existing`       | `TeamsClient.connectToExistingCloud`                   |
| POST   | `/api/dbconfig/upgrade-to-team`        | `TeamsClient.upgradeToTeamCloud`                       |

All five are reachable as public functions from the `latticesql` package — the frontend is just a wrapper.

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
```

`--name` is the user's display name; `--team-name` is the team's name. They were previously overloaded onto a single `--name` flag — that was clarified in v1.12.

---

## GUI

`lattice gui` (no `--team-cloud`) drives the same flows from a browser:

- **User Config → Identity** edits `~/.lattice/identity.json`. Display name + email are prefilled in every create-team / join-team modal.
- **User Config → Databases** lists sibling YAML configs (local SQLite candidates) + saved Postgres labels (cloud candidates). Switch-to action re-opens the Lattice against a different config.
- **Project Config → Database** is the panel that writes the Postgres URL into `db-credentials.enc` and rewrites the active YAML's `db:` to `${LATTICE_DB:<label>}`. Test / Connect actions probe + swap without restarting the GUI.
- **Project Config → Teams** lists every team this local Lattice is a member of, with sync stats, share/unshare, invite-by-email, kick (creator), and leave/destroy actions.

The GUI is localhost-only and unauthenticated by default. `--team-cloud` mode swaps the dev-tool surface for the bearer-gated team routes.

---

## Schema reference

Cloud-side:

| Table                       | Columns                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `__lattice_users`           | `id, email NOT NULL, name, created_at, updated_at, deleted_at`                                   |
| `__lattice_api_tokens`      | `id, user_id, token_hash UNIQUE, name, created_at, last_used_at, revoked_at`                     |
| `__lattice_team`            | `id, name, created_by_user_id, created_at, updated_at, deleted_at`                               |
| `__lattice_team_identity`   | `id='singleton', team_id, team_name, creator_email, created_at`                                  |
| `__lattice_team_members`    | `(team_id, user_id) PK, role IN ('creator','member'), joined_at`                                 |
| `__lattice_invitations`     | `id, team_id, token_hash UNIQUE, invitee_email NOT NULL, invited_by_user_id, created_at, expires_at, redeemed_at, redeemed_by_user_id` |
| `__lattice_shared_objects`  | `(team_id, table_name) PK, schema_spec_json, schema_version, …`                                  |
| `__lattice_change_log`      | `id, seq (monotonic), team_id, table_name, pk, op, payload_json, owner_user_id, created_at`      |
| `__lattice_row_links`       | `(team_id, table_name, pk) PK, owner_user_id, linked_at`                                         |

Local-side:

| Table                         | Columns                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `__lattice_user_identity`     | Singleton (`id='singleton'`) mirroring `~/.lattice/identity.json`.                             |
| `__lattice_team_connections`  | `team_id PK, team_name, cloud_url, my_user_id, api_token_encrypted, last_change_seq, joined_at`|
| `__lattice_local_links`       | Same shape as `__lattice_row_links` (used by write-hook capture + receiver mirrors)             |
| `__lattice_team_outbox`       | FIFO outbox of local writes pending push to the cloud                                          |
| `__lattice_team_dlq`          | Dead-letter for envelopes that failed too many push attempts                                   |

---

## Limits + known gaps (v1.12)

- **No web identity layer.** Email is asserted by the local install, not verified. Two coordinating users could collide on the same email. A future release may add latticesql.com-side identity for compliance/audit use cases.
- **Bearer tokens never expire** until explicitly revoked. Use `lattice teams destroy` (or `DELETE /api/team`) to drop the whole team — this cascades to memberships + tokens.
- **One team per DB.** If you need multiple teams, stand up multiple cloud Postgres databases — each gets its own URL in `db-credentials.enc` and its own YAML config.
- **Schema migrations on shared tables** are additive only. Dropping a column from a shared table will surface as a divergence on receivers; coordinate manually.
- **Postgres SSL** is up to your connection string. Lattice doesn't override; pass `?sslmode=require` (or your provider's equivalent) in the URL.
