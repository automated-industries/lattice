import type { Lattice } from '../lattice.js';
import type { Migration, TableDefinition } from '../types.js';

/**
 * Cloud-side internal tables for the Lattice Teams feature.
 *
 * Registered via `lattice.defineLate()` after `init()` when the lattice is
 * booted in team-cloud server mode. Kept separate from user-defined
 * tables so the user's YAML config remains the source of truth for
 * domain entities — these tables only appear when team-cloud mode is on.
 *
 * The map keys are the table names; values are standard TableDefinitions
 * with empty render functions and out-of-the-way outputFiles so they
 * don't pollute the user's rendered context output.
 *
 * Phase 2 adds teams, members, and invitations. Shared objects, row
 * links, and the change log come in Phases 3 and 4.
 */
export const CLOUD_INTERNAL_TABLE_DEFS: Record<string, TableDefinition> = {
  __lattice_users: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      email: 'TEXT NOT NULL',
      name: 'TEXT',
      created_at: 'TEXT NOT NULL',
      updated_at: 'TEXT NOT NULL',
      deleted_at: 'TEXT',
    },
    // Uniqueness enforced at the route layer (we soft-delete by setting
    // deleted_at, so a column-level UNIQUE blocks re-registration after
    // a delete). The register/redeem handlers check for an existing
    // non-deleted user with the same email before insert.
    render: () => '',
    outputFile: '.lattice-teams/users.md',
  },
  __lattice_api_tokens: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      user_id: 'TEXT NOT NULL',
      token_hash: 'TEXT NOT NULL UNIQUE',
      name: 'TEXT',
      created_at: 'TEXT NOT NULL',
      last_used_at: 'TEXT',
      revoked_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-teams/tokens.md',
  },
  __lattice_team: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      created_by_user_id: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
      updated_at: 'TEXT NOT NULL',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-teams/teams.md',
  },
  // Singleton mirror of __lattice_team — populated by `createTeam` when
  // the first (and only) team is established on this cloud. One row per
  // DB, id='singleton'. Lets GET /api/team / DELETE /api/team / POST
  // /api/team/invitations resolve the active team without scanning.
  // The multi-team `__lattice_team` table remains the source of truth
  // for the row/object/changes routes until Step 8 deprecates them.
  __lattice_team_identity: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      team_id: 'TEXT NOT NULL',
      team_name: 'TEXT NOT NULL',
      creator_email: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
    },
    primaryKey: 'id',
    render: () => '',
    outputFile: '.lattice-teams/team-identity.md',
  },
  __lattice_team_members: {
    columns: {
      team_id: 'TEXT NOT NULL',
      user_id: 'TEXT NOT NULL',
      role: "TEXT NOT NULL CHECK (role IN ('creator', 'member'))",
      joined_at: 'TEXT NOT NULL',
    },
    primaryKey: ['team_id', 'user_id'],
    render: () => '',
    outputFile: '.lattice-teams/members.md',
  },
  __lattice_invitations: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      team_id: 'TEXT NOT NULL',
      token_hash: 'TEXT NOT NULL UNIQUE',
      // Email the invitation is addressed to — redeem requires the
      // caller's identity email to match. Email-binding makes invite
      // codes safe to share over a channel that's not strongly
      // authenticated; the recipient still has to be the recipient.
      invitee_email: 'TEXT NOT NULL',
      invited_by_user_id: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
      expires_at: 'TEXT',
      redeemed_at: 'TEXT',
      redeemed_by_user_id: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-teams/invitations.md',
  },
  __lattice_shared_objects: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      schema_spec_json: 'TEXT NOT NULL',
      schema_version: 'INTEGER NOT NULL',
      created_by_user_id: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
      updated_at: 'TEXT NOT NULL',
      deleted_at: 'TEXT',
    },
    primaryKey: ['team_id', 'table_name'],
    render: () => '',
    outputFile: '.lattice-teams/shared-objects.md',
  },
  // Per-table ownership for a team cloud. Every member connects to the
  // SAME physical Postgres, so every table exists for everyone at the
  // SQL level — visibility must be enforced at the application layer.
  // This table records the creator (owner) of each user-facing table
  // (including the native `files`/`secrets` objects). The GUI shows a
  // user only the tables they own PLUS tables present in
  // `__lattice_shared_objects` (explicitly shared to the team). Tables
  // without a row here are reconciled to the team creator on open. See
  // `reconcileObjectOwners` / `listObjectOwners` in `direct-ops.ts`.
  __lattice_object_owners: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      owner_user_id: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
    },
    primaryKey: ['team_id', 'table_name'],
    render: () => '',
    outputFile: '.lattice-teams/object-owners.md',
  },
  __lattice_change_log: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      seq: 'INTEGER NOT NULL',
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT',
      pk: 'TEXT',
      op: 'TEXT NOT NULL',
      payload_json: 'TEXT',
      owner_user_id: 'TEXT',
      // Server-receipt time. `seq` is the authoritative monotonic ordering key.
      created_at: 'TEXT NOT NULL',
      // True edit time as recorded by the originating client. Distinct from
      // created_at so an offline replay preserves WHEN the edit was made
      // without ever letting client clock skew reorder the canonical `seq`.
      // Nullable + additive (back-compat with pre-1.16 change-log rows).
      client_ts: 'TEXT',
      // Client-generated idempotency key for offline replay: a queued edit
      // carries a stable edit_id, so re-sending it after a reconnect is a
      // no-op rather than a duplicate write. Nullable + additive.
      edit_id: 'TEXT',
      // Per-recipient targeting for 2.2 hard row-level sync. NULL =
      // broadcast (delivered to every member, then filtered at pull time
      // against __lattice_row_acl); non-null = targeted to exactly this
      // user (the grant / revoke / delete fan-out). Nullable + additive,
      // same precedent as client_ts / edit_id.
      recipient_user_id: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-teams/change-log.md',
  },
  __lattice_row_links: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      pk: 'TEXT NOT NULL',
      owner_user_id: 'TEXT NOT NULL',
      linked_at: 'TEXT NOT NULL',
    },
    primaryKey: ['team_id', 'table_name', 'pk'],
    render: () => '',
    outputFile: '.lattice-teams/row-links.md',
  },
  // Per-row access control for a team cloud (2.2 row-level permissions).
  // Mirrors __lattice_object_owners at row granularity: each shared row
  // has an owner (its creator) and a visibility. Enforcement is at the
  // application layer (see src/teams/row-access.ts) — every member shares
  // the same physical DB, so a row a user can't see must be filtered out
  // before its bytes reach them. Kept out-of-band (never injected into
  // user tables) so the user's own schema stays untouched.
  __lattice_row_acl: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      pk: 'TEXT NOT NULL',
      owner_user_id: 'TEXT NOT NULL',
      // 'private' = owner only · 'everyone' = all team members ·
      // 'custom' = the explicit grant list in __lattice_row_grants.
      visibility: "TEXT NOT NULL CHECK (visibility IN ('private', 'everyone', 'custom'))",
      created_at: 'TEXT NOT NULL',
      updated_at: 'TEXT NOT NULL',
    },
    primaryKey: ['team_id', 'table_name', 'pk'],
    render: () => '',
    outputFile: '.lattice-teams/row-acl.md',
  },
  // Explicit per-row grant list, consulted only when the owning row's
  // __lattice_row_acl.visibility = 'custom'. One row per (row, grantee).
  __lattice_row_grants: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      pk: 'TEXT NOT NULL',
      grantee_user_id: 'TEXT NOT NULL',
      granted_by_user_id: 'TEXT NOT NULL',
      granted_at: 'TEXT NOT NULL',
    },
    primaryKey: ['team_id', 'table_name', 'pk', 'grantee_user_id'],
    render: () => '',
    outputFile: '.lattice-teams/row-grants.md',
  },
};

/**
 * Local-side internal tables for the Lattice Teams feature.
 *
 * Registered on local lattice instances by `TeamsClient` when a user
 * joins their first team (idempotent on subsequent joins). Carries the
 * connection metadata + per-team encrypted API token; the pull cursor
 * (`last_change_seq`) is reserved for Phase 4.
 *
 * The plan called for `team_id` as PK; that holds here because team_ids
 * are UUIDs and globally unique. A user who joins the same team twice
 * (e.g. left + rejoined) overwrites the existing row via upsert.
 */
export const LOCAL_INTERNAL_TABLE_DEFS: Record<string, TableDefinition> = {
  __lattice_team_connections: {
    columns: {
      team_id: 'TEXT PRIMARY KEY',
      team_name: 'TEXT NOT NULL',
      cloud_url: 'TEXT NOT NULL',
      my_user_id: 'TEXT NOT NULL',
      api_token_encrypted: 'TEXT NOT NULL',
      last_change_seq: 'INTEGER',
      joined_at: 'TEXT NOT NULL',
    },
    // Override Lattice's default `id` PK convention — this table is
    // keyed by team_id so a duplicate-join just upserts.
    primaryKey: 'team_id',
    render: () => '',
    outputFile: '.lattice-teams/connections.md',
  },
  __lattice_local_links: {
    columns: {
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      pk: 'TEXT NOT NULL',
      owner_user_id: 'TEXT NOT NULL',
      linked_at: 'TEXT NOT NULL',
      // Stable hash of the row payload as of the last applied sync. Lets the
      // puller detect a non-owner local edit before a last-write-wins
      // overwrite clobbers it: if the current local row hashes differently,
      // the local copy diverged since last sync. Additive column — older
      // local DBs get it via _addMissingColumns on the next session, NULL
      // until the row's next applied upsert (NULL = "never synced, skip
      // divergence check"). See TeamsClient.applyEnvelope.
      synced_hash: 'TEXT',
    },
    primaryKey: ['team_id', 'table_name', 'pk'],
    render: () => '',
    outputFile: '.lattice-teams/local-links.md',
  },
  __lattice_team_outbox: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      team_id: 'TEXT NOT NULL',
      table_name: 'TEXT NOT NULL',
      pk: 'TEXT NOT NULL',
      op: 'TEXT NOT NULL',
      payload_json: 'TEXT',
      attempts: 'INTEGER NOT NULL',
      last_error: 'TEXT',
      next_attempt_at: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
    },
    render: () => '',
    outputFile: '.lattice-teams/outbox.md',
  },
  __lattice_team_dlq: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      team_id: 'TEXT NOT NULL',
      envelope_json: 'TEXT NOT NULL',
      error: 'TEXT NOT NULL',
      created_at: 'TEXT NOT NULL',
    },
    render: () => '',
    outputFile: '.lattice-teams/dlq.md',
  },
};

/**
 * Postgres trigger that emits `NOTIFY lattice_changes` after every
 * `__lattice_change_log` insert. The payload mirrors the row minus the
 * potentially-large `payload_json` blob — clients re-fetch that by `pk`
 * if they need it. SQLite has no equivalent; trigger install is a no-op
 * there.
 *
 * Idempotent: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` +
 * `CREATE TRIGGER` lets future versions update the trigger body by
 * bumping the migration version.
 */
export const CLOUD_NOTIFY_CHANGE_LOG_SQL = `
CREATE OR REPLACE FUNCTION lattice_notify_change_log() RETURNS trigger AS $LATTICE$
BEGIN
  PERFORM pg_notify('lattice_changes', json_build_object(
    'seq', NEW.seq,
    'team_id', NEW.team_id,
    'table_name', NEW.table_name,
    'pk', NEW.pk,
    'op', NEW.op,
    'owner_user_id', NEW.owner_user_id,
    'created_at', NEW.created_at,
    'client_ts', NEW.client_ts
  )::text);
  RETURN NEW;
END;
$LATTICE$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lattice_notify_change_log_trg ON __lattice_change_log;
CREATE TRIGGER lattice_notify_change_log_trg
AFTER INSERT ON __lattice_change_log
FOR EACH ROW
EXECUTE FUNCTION lattice_notify_change_log();
`;

/**
 * Install the change-log NOTIFY trigger on a cloud Postgres. No-op on
 * SQLite (LISTEN/NOTIFY is Postgres-only). Idempotent via Lattice's
 * migration tracker — the version key skips already-applied runs.
 *
 * Safe to call on every team-cloud schema setup path. The `internal:`
 * version prefix marks this as Lattice-managed (not application).
 */
export async function installCloudInternalTriggers(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const migration: Migration = {
    // v2 adds client_ts to the NOTIFY payload (1.16 realtime emit gap fix).
    // Bumping the version key re-runs CREATE OR REPLACE on existing clouds.
    version: 'internal:cloud-notify-change-log:v2',
    sql: CLOUD_NOTIFY_CHANGE_LOG_SQL,
  };
  await db.migrate([migration]);
}

/**
 * Row-level permission schema (2.2). Installs the pieces that need
 * explicit, ordered, idempotent migrations: the per-table default-row-
 * visibility column on __lattice_shared_objects, the supporting indexes,
 * and the upgrade backfill. The ACL tables themselves (__lattice_row_acl,
 * __lattice_row_grants) and the additive __lattice_change_log
 * .recipient_user_id column are created through the normal defineLate path
 * from CLOUD_INTERNAL_TABLE_DEFS — only the column-with-a-default, the
 * indexes, and the data backfill need a migration.
 *
 * Unlike the Postgres-only NOTIFY trigger, this runs on BOTH dialects:
 * SQLite Teams servers and Postgres clouds both enforce row visibility.
 * Idempotent via Lattice's migration tracker. The numeric ":NN-" ordering
 * prefixes keep the column-add ahead of the index + backfill that depend
 * on it — the runner sorts by version with numeric-aware localeCompare, so
 * a descriptive-only suffix would mis-order. Each migration is a SINGLE
 * statement: the SQLite path runs through better-sqlite3 `prepare()`, which
 * rejects multi-statement SQL (the multi-statement NOTIFY trigger above is
 * Postgres-only, so it never hits that path).
 *
 * Safe to call after installCloudInternalTriggers on every cloud schema
 * setup path; defineLate must have registered the internal tables first so
 * __lattice_change_log.recipient_user_id and __lattice_row_grants exist
 * before the indexes that reference them.
 */
export async function installRowPermsSchema(db: Lattice): Promise<void> {
  const migrations: Migration[] = [
    {
      // 01 — per-table default visibility for newly-created rows. Born
      // 'private' unless the table owner opts the table into 'everyone';
      // the backfill (06) flips already-shared tables to preserve pre-2.2
      // visibility. No IF NOT EXISTS: the version guard runs this exactly
      // once, which is what SQLite's ADD COLUMN needs (it has no
      // IF NOT EXISTS form).
      version: 'internal:row-perms:01-default-row-visibility:v1',
      sql: `ALTER TABLE "__lattice_shared_objects" ADD COLUMN "default_row_visibility" TEXT NOT NULL DEFAULT 'private' CHECK ("default_row_visibility" IN ('private', 'everyone'))`,
    },
    {
      // 02-05 — indexes. One CREATE INDEX per migration (single-statement
      // for the SQLite path). IF NOT EXISTS is valid in both dialects.
      version: 'internal:row-perms:02-idx-change-log-team-seq:v1',
      sql: `CREATE INDEX IF NOT EXISTS "idx_lattice_change_log_team_seq" ON "__lattice_change_log" ("team_id", "seq")`,
    },
    {
      version: 'internal:row-perms:03-idx-change-log-team-recipient-seq:v1',
      sql: `CREATE INDEX IF NOT EXISTS "idx_lattice_change_log_team_recipient_seq" ON "__lattice_change_log" ("team_id", "recipient_user_id", "seq")`,
    },
    {
      version: 'internal:row-perms:04-idx-change-log-team-table-pk:v1',
      sql: `CREATE INDEX IF NOT EXISTS "idx_lattice_change_log_team_table_pk" ON "__lattice_change_log" ("team_id", "table_name", "pk")`,
    },
    {
      version: 'internal:row-perms:05-idx-row-grants-grantee:v1',
      sql: `CREATE INDEX IF NOT EXISTS "idx_lattice_row_grants_grantee" ON "__lattice_row_grants" ("team_id", "grantee_user_id", "table_name", "pk")`,
    },
    {
      // 06 — upgrade backfill. Every already-shared table defaults to
      // 'everyone' so pre-2.2 rows stay visible to all members (nothing
      // disappears on upgrade). Pre-2.2 rows have no __lattice_row_acl
      // entry; resolveRowAcl() folds in this table default, so they read
      // as 'everyone' until an owner narrows an individual row. Runs once.
      version: 'internal:row-perms:06-backfill-shared-defaults:v1',
      sql: `UPDATE "__lattice_shared_objects" SET "default_row_visibility" = 'everyone' WHERE "deleted_at" IS NULL`,
    },
  ];
  await db.migrate(migrations);
}
