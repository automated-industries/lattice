/**
 * Direct-Postgres equivalents of the team-cloud HTTP operations.
 *
 * v1.13–v1.13.3 assumed every team-cloud connection went through an
 * HTTP `lattice serve --team-cloud` server fronting the Postgres. In
 * practice, the Migrate-to-cloud and Connect-to-existing-cloud flows
 * point the local lattice at the cloud Postgres URL **directly** —
 * no HTTP layer in front. In that case the user's local Lattice IS
 * the cloud Lattice; team operations are just queries / mutations
 * against the same database the GUI is already reading.
 *
 * v1.13.4 wires these direct-path equivalents so the GUI's Invite,
 * Members, Destroy, and Sync actions all work against postgres://
 * cloud URLs. The dispatcher lives in `TeamsClient` — these helpers
 * stay pure functions over a Lattice handle so they can be exercised
 * in tests without spinning up the full GUI.
 *
 * They mirror the server-side handlers in `src/teams/server/routes.ts`
 * (`handleListMembers`, `handleCreateInvitation`, `handleKickMember`,
 * `handleDestroySingletonTeam`) — same Lattice queries, no
 * authentication layer because the caller is already the
 * connection-credential holder. If the operator can connect to the
 * Postgres, they're authorized.
 */
import { Lattice } from '../lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from './internal-tables.js';
import { generateInviteToken, generateToken, hashToken } from './server/auth.js';
import { isPostgresUrl } from './register-direct.js';
import type { MemberSummary, InviteResponse, RedeemResponse } from './client.js';

interface MemberRow {
  user_id: string;
  team_id: string;
  role: string;
  joined_at: string;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  deleted_at: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  deleted_at: string | null;
}

/**
 * Members of `teamId` joined with their `__lattice_users` row. Returns
 * the same shape `TeamsClient.listMembers` would return from the HTTP
 * path. Excludes users whose `__lattice_users` row has been
 * soft-deleted.
 */
export async function listMembersDirect(db: Lattice, teamId: string): Promise<MemberSummary[]> {
  const members = (await db.query('__lattice_team_members', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as MemberRow[];
  if (members.length === 0) return [];
  const users = (await db.query('__lattice_users', {
    filters: [
      { col: 'id', op: 'in', val: members.map((m) => m.user_id) },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as UserRow[];
  const userById = new Map(users.map((u) => [u.id, u]));
  const out: MemberSummary[] = [];
  for (const m of members) {
    const u = userById.get(m.user_id);
    if (!u) continue;
    out.push({
      user_id: m.user_id,
      email: u.email,
      name: u.name,
      role: m.role,
      joined_at: m.joined_at,
    });
  }
  return out;
}

/**
 * Issue a new invite token for `teamId`. Mirrors `handleCreateInvitation`
 * exactly — generate the token, insert into `__lattice_invitations`
 * with a SHA-256 hashed form, return the raw token to the caller
 * once. Default expiry: 7 days.
 *
 * Caller is responsible for verifying the caller is the team creator;
 * for direct-Postgres mode that authorization is implicit in
 * connection-credential possession.
 */
export async function inviteDirect(
  db: Lattice,
  teamId: string,
  inviterUserId: string,
  inviteeEmail: string,
  expiresInHours = 7 * 24,
): Promise<InviteResponse> {
  const team = (await db.get('__lattice_team', teamId)) as unknown as TeamRow | null;
  if (!team || team.deleted_at) {
    throw new Error(`Team not found: ${teamId}`);
  }
  const expiresAt = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
  const { raw, hash } = generateInviteToken();
  const id = await db.insert('__lattice_invitations', {
    team_id: teamId,
    token_hash: hash,
    invitee_email: inviteeEmail,
    invited_by_user_id: inviterUserId,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  return {
    id,
    raw_token: raw,
    expires_at: expiresAt,
    team_name: team.name,
    invitee_email: inviteeEmail,
  };
}

/**
 * Remove a member from a team. The HTTP handler also auto-unlinks
 * Phase-4 row links; this direct path leaves that to the caller (the
 * GUI's direct flow doesn't surface per-row sharing yet against
 * direct-Postgres clouds).
 */
export async function kickMemberDirect(db: Lattice, teamId: string, userId: string): Promise<void> {
  await db.delete('__lattice_team_members', { team_id: teamId, user_id: userId });
}

/**
 * Destroy the singleton team — clears the identity row + all members.
 * Used by the GUI's "Destroy team" button when the active connection
 * is a direct-Postgres cloud.
 */
export async function destroyTeamDirect(db: Lattice): Promise<void> {
  // Order matters: members → identity → team. The team row itself
  // stays via soft-delete to preserve historical references; the
  // identity row going away is what the GUI surfaces as "team
  // destroyed".
  const identityRow = (await db.get('__lattice_team_identity', 'singleton')) as {
    team_id: string;
  } | null;
  if (identityRow && typeof identityRow.team_id === 'string') {
    const teamId = identityRow.team_id;
    const members = (await db.query('__lattice_team_members', {
      filters: [{ col: 'team_id', op: 'eq', val: teamId }],
    })) as unknown as MemberRow[];
    for (const m of members) {
      await db.delete('__lattice_team_members', { team_id: teamId, user_id: m.user_id });
    }
    await db.update('__lattice_team', teamId, { deleted_at: new Date().toISOString() });
  }
  await db.delete('__lattice_team_identity', 'singleton');
}

interface InvitationRow {
  id: string;
  team_id: string;
  token_hash: string;
  invitee_email: string | null;
  expires_at: string | null;
  redeemed_at: string | null;
}

/**
 * Direct-Postgres equivalent of `POST /api/auth/redeem-invite`.
 *
 * Used by the GUI's "Join via invite" flow + `connectToExistingCloud`
 * when the cloud URL is `postgres://...` (no HTTP teams server in
 * front). Opens the cloud Postgres directly, validates the invite
 * (token hash + email binding + expiry + un-redeemed), inserts the
 * joining user + member row + bearer token, and stamps the invite as
 * redeemed.
 *
 * Mirrors `handleRedeemInvite` in `src/teams/server/routes.ts` line
 * for line — same Lattice queries, same invariants. The token is only
 * compared by its SHA-256 hash; the raw form never gets stored.
 *
 * Caller is responsible for writing the returned `raw_token` to
 * `~/.lattice/keys/<label>.token` and calling `saveConnection()` so
 * the local `__lattice_team_connections` row is populated.
 */
export async function redeemInviteDirect(
  cloudUrl: string,
  inviteToken: string,
  email: string,
  name: string,
): Promise<RedeemResponse> {
  if (!isPostgresUrl(cloudUrl)) {
    throw new Error(
      `redeemInviteDirect: cloudUrl must be a postgres:// URL (got ${cloudUrl.slice(0, 12)}…)`,
    );
  }
  const db = new Lattice(cloudUrl);
  try {
    await db.init();
    for (const [table, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
      await db.defineLate(table, def);
    }

    const invites = (await db.query('__lattice_invitations', {
      filters: [
        { col: 'token_hash', op: 'eq', val: hashToken(inviteToken) },
        { col: 'redeemed_at', op: 'isNull' },
      ],
      limit: 1,
    })) as unknown as InvitationRow[];
    const invite = invites[0];
    if (!invite) {
      throw new Error('Invitation invalid or already used');
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      throw new Error('Invitation expired');
    }
    // Email binding — match the server's case-insensitive compare so
    // the same invite token works from either implementation.
    if (invite.invitee_email && invite.invitee_email.toLowerCase() !== email.toLowerCase()) {
      throw new Error('Invitation is addressed to a different email');
    }

    const team = (await db.get('__lattice_team', invite.team_id)) as {
      id: string;
      name: string;
      deleted_at: string | null;
    } | null;
    if (!team || team.deleted_at) {
      throw new Error('Team no longer exists');
    }

    const now = new Date().toISOString();
    const userId = await db.insert('__lattice_users', {
      email,
      name,
      created_at: now,
      updated_at: now,
    });
    await db.insert('__lattice_team_members', {
      team_id: invite.team_id,
      user_id: userId,
      role: 'member',
      joined_at: now,
    });
    const { raw, hash } = generateToken();
    await db.insert('__lattice_api_tokens', {
      user_id: userId,
      token_hash: hash,
      name: `invited:${team.name}`,
      created_at: now,
    });
    await db.update('__lattice_invitations', invite.id, {
      redeemed_at: now,
      redeemed_by_user_id: userId,
    });

    return {
      user: { id: userId, email, name },
      raw_token: raw,
      team: { id: team.id, name: team.name },
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
}
