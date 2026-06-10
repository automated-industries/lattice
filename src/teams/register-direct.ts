import { Lattice } from '../lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from './internal-tables.js';
import { generateToken } from './server/auth.js';

/**
 * Shape returned by both the HTTP register path and the Postgres-direct
 * register path. Kept aligned with `RegisterResponse` in
 * `src/teams/client.ts`.
 */
export interface DirectRegisterResult {
  user: { id: string; email: string; name: string };
  raw_token: string;
  team: { id: string; name: string; role: 'creator' };
}

/**
 * True iff `url` parses as a `postgres://` / `postgresql://` URL — used
 * by the GUI's upgrade flow to decide between HTTP `register` and the
 * direct-Postgres path implemented here.
 */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

/**
 * Direct-Postgres equivalent of the cloud's `POST /api/auth/register`.
 *
 * The HTTP teams-cloud server (`lattice serve --team-cloud`) handles
 * `register` by running an INSERT sequence inside its own request
 * handler. This helper does the same sequence locally by opening the
 * cloud Postgres directly — useful when the GUI's "Migrate to cloud"
 * or "Connect to existing cloud" flow has saved the **Postgres URL**
 * as the cloud credential (no HTTP teams server in front).
 *
 * Hard browser limitation that motivates this: when `cloudUrl` is a
 * Postgres URL with embedded credentials, the HTTP path's `fetch(url)`
 * throws "Request cannot be constructed from a URL that includes
 * credentials" before any network IO happens. We have to drive the
 * register flow against the database protocol, not HTTP.
 *
 * Mirrors `handleRegister`'s invariants:
 *   - Refuses if any non-deleted user already exists on the cloud.
 *   - Refuses if the `__lattice_team_identity` singleton already exists.
 *
 * On success returns the same shape the HTTP route returns so a
 * direct-postgres register can mirror the hosted register path.
 *
 * @deprecated Since 2.2 — new direct registrations are rejected (a direct
 * connection bypasses row-level security). Retained only for the
 * grandfathered existing-connection path; will be removed in 3.0. Create or
 * join new workspaces through a hosted Teams server (an `http(s)://` URL).
 */
export async function registerDirectViaPostgres(
  cloudUrl: string,
  email: string,
  name: string,
  teamName: string,
): Promise<DirectRegisterResult> {
  if (!isPostgresUrl(cloudUrl)) {
    throw new Error(
      `registerDirectViaPostgres: cloudUrl must be a postgres:// URL (got ${cloudUrl.slice(0, 12)}…)`,
    );
  }
  // Open the cloud as a fresh Lattice with no YAML schema attached.
  // `defineLate()` after init registers the team-internal tables so the
  // inserts below operate against a fully-typed surface.
  const db = new Lattice(cloudUrl);
  try {
    await db.init();
    for (const [table, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
      await db.defineLate(table, def);
    }

    // Bootstrap-only: refuse if any non-deleted user exists. Matches the
    // server-side invariant — subsequent members join via redeem-invite.
    const existing = await db.query('__lattice_users', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
      limit: 1,
    });
    if (existing.length > 0) {
      throw new Error(
        'Registration is disabled. This cloud already has users — join via invitation.',
      );
    }

    // One team per cloud. If the singleton identity row exists, the
    // cloud is already a team — caller should be using
    // connectToExistingCloud instead.
    let identity: unknown = null;
    try {
      identity = await db.get('__lattice_team_identity', 'singleton');
    } catch {
      // Table absent on truly fresh clouds — defineLate above created it
      // but get() can still surface adapter quirks. Treat as no team.
      identity = null;
    }
    if (identity) {
      throw new Error('This cloud already has a team. Use Connect to existing cloud instead.');
    }

    const now = new Date().toISOString();
    const userId = await db.insert('__lattice_users', {
      email,
      name,
      created_at: now,
      updated_at: now,
    });
    const { raw, hash } = generateToken();
    await db.insert('__lattice_api_tokens', {
      user_id: userId,
      token_hash: hash,
      name: `creator:${teamName}`,
      created_at: now,
    });
    const teamId = await db.insert('__lattice_team', {
      name: teamName,
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: teamId,
      user_id: userId,
      role: 'creator',
      joined_at: now,
    });
    await db.insert('__lattice_team_identity', {
      id: 'singleton',
      team_id: teamId,
      team_name: teamName,
      creator_email: email,
      created_at: now,
    });

    return {
      user: { id: userId, email, name },
      raw_token: raw,
      team: { id: teamId, name: teamName, role: 'creator' },
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
}
