import type { TableDefinition } from '../types.js';

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
      created_at: 'TEXT NOT NULL',
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
