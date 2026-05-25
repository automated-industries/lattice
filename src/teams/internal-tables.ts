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
 * Phase 1 covers only the rows the auth middleware needs to validate a
 * bearer token. Teams, members, shared objects, row links, and the change
 * log are added in later phases.
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
};
