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
      email: 'TEXT',
      name: 'TEXT',
      created_at: 'TEXT NOT NULL',
      updated_at: 'TEXT NOT NULL',
      deleted_at: 'TEXT',
    },
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
      op: 'TEXT NOT NULL',
      payload_json: 'TEXT',
      created_at: 'TEXT NOT NULL',
    },
    render: () => '',
    outputFile: '.lattice-teams/change-log.md',
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
};
