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
import { randomUUID } from 'node:crypto';
import { Lattice } from '../lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS, installCloudInternalTriggers } from './internal-tables.js';
import { applySchemaSpec, type SchemaSpec } from './schema-spec.js';
import { generateInviteToken, generateToken, hashToken } from './server/auth.js';
import { isPostgresUrl } from './register-direct.js';
import type {
  MemberSummary,
  InviteResponse,
  RedeemResponse,
  ShareObjectResponse,
  SharedObjectSummary,
  SyncStatus,
} from './client.js';

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
 *
 * The team creator is always surfaced (role `creator`), resolved from
 * `__lattice_team.created_by_user_id` — even when they have no
 * `__lattice_team_members` row (older teams recorded the creator only on
 * the team row + identity, not as an explicit member). A creator who
 * does have a member row is relabeled `creator` regardless of the stored
 * role, so the owner is never shown as a plain member.
 */
export async function listMembersDirect(db: Lattice, teamId: string): Promise<MemberSummary[]> {
  const members = (await db.query('__lattice_team_members', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as MemberRow[];
  const team = (await db.get('__lattice_team', teamId)) as {
    created_by_user_id?: string;
    created_at?: string;
  } | null;
  const creatorUserId = team?.created_by_user_id ?? null;

  const ids = new Set<string>(members.map((m) => m.user_id));
  if (creatorUserId) ids.add(creatorUserId);
  if (ids.size === 0) return [];

  const users = (await db.query('__lattice_users', {
    filters: [
      { col: 'id', op: 'in', val: [...ids] },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as UserRow[];
  const userById = new Map(users.map((u) => [u.id, u]));

  const out: MemberSummary[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const u = userById.get(m.user_id);
    if (!u) continue;
    out.push({
      user_id: m.user_id,
      email: u.email,
      name: u.name,
      role: m.user_id === creatorUserId ? 'creator' : m.role,
      joined_at: m.joined_at,
    });
    seen.add(m.user_id);
  }
  // Surface the creator even without a members row (not soft-deleted).
  if (creatorUserId && !seen.has(creatorUserId)) {
    const u = userById.get(creatorUserId);
    if (u) {
      out.unshift({
        user_id: creatorUserId,
        email: u.email,
        name: u.name,
        role: 'creator',
        joined_at: team?.created_at ?? '',
      });
    }
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
    await installCloudInternalTriggers(db);

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

// ─── Phase 3 / Phase 4 direct-Postgres equivalents ─────────────────────
//
// Each opens a fresh Lattice against the cloud Postgres URL, registers
// the team internal tables, performs the equivalent SQL, then closes.
// The pattern mirrors `redeemInviteDirect` above. Parameterized writes
// only — no template-string concatenation into SQL.

interface SharedObjectRow {
  team_id: string;
  table_name: string;
  schema_spec_json: string;
  schema_version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

async function openCloud(cloudUrl: string): Promise<Lattice> {
  if (!isPostgresUrl(cloudUrl)) {
    throw new Error(
      `direct-ops: cloudUrl must be a postgres:// URL (got ${cloudUrl.slice(0, 12)}…)`,
    );
  }
  const db = new Lattice(cloudUrl);
  await db.init();
  for (const [table, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(table, def);
  }
  await installCloudInternalTriggers(db);
  return db;
}

function closeQuiet(db: Lattice): void {
  try {
    db.close();
  } catch {
    // best-effort
  }
}

async function appendChangeEnvelopeDirect(
  db: Lattice,
  args: {
    team_id: string;
    table_name: string | null;
    pk: string | null;
    op: 'schema' | 'unshare' | 'link' | 'unlink' | 'upsert' | 'delete';
    payload_json: string | null;
    owner_user_id: string | null;
  },
): Promise<number> {
  // Sequence is monotonic per team — derive from the current max.
  const existing = (await db.query('__lattice_change_log', {
    filters: [{ col: 'team_id', op: 'eq', val: args.team_id }],
    orderBy: 'seq',
    orderDir: 'desc',
    limit: 1,
  })) as unknown as { seq: number }[];
  const nextSeq = (existing[0]?.seq ?? 0) + 1;
  await db.insert('__lattice_change_log', {
    id: randomUUID(),
    seq: nextSeq,
    team_id: args.team_id,
    table_name: args.table_name,
    pk: args.pk,
    op: args.op,
    payload_json: args.payload_json,
    owner_user_id: args.owner_user_id,
    created_at: new Date().toISOString(),
  });
  return nextSeq;
}

export async function shareObjectDirect(
  cloudUrl: string,
  teamId: string,
  inviterUserId: string,
  table: string,
  spec: SchemaSpec,
): Promise<ShareObjectResponse> {
  const db = await openCloud(cloudUrl);
  try {
    const existing = (await db.query('__lattice_shared_objects', {
      filters: [
        { col: 'team_id', op: 'eq', val: teamId },
        { col: 'table_name', op: 'eq', val: table },
      ],
      limit: 1,
    })) as unknown as SharedObjectRow[];
    const prior = existing[0];
    const now = new Date().toISOString();
    let schemaVersion: number;
    let outSpec: SchemaSpec;
    if (prior && !prior.deleted_at) {
      schemaVersion = prior.schema_version + 1;
      outSpec = { ...spec, schemaVersion };
      await db.upsert('__lattice_shared_objects', {
        team_id: teamId,
        table_name: table,
        schema_spec_json: JSON.stringify(outSpec),
        schema_version: schemaVersion,
        created_by_user_id: prior.created_by_user_id,
        created_at: prior.created_at,
        updated_at: now,
        deleted_at: null,
      });
    } else {
      schemaVersion = 1;
      outSpec = { ...spec, schemaVersion };
      await db.upsert('__lattice_shared_objects', {
        team_id: teamId,
        table_name: table,
        schema_spec_json: JSON.stringify(outSpec),
        schema_version: schemaVersion,
        created_by_user_id: inviterUserId,
        created_at: prior?.created_at ?? now,
        updated_at: now,
        deleted_at: null,
      });
    }
    await applySchemaSpec(db, table, outSpec);
    const seq = await appendChangeEnvelopeDirect(db, {
      team_id: teamId,
      table_name: table,
      pk: null,
      op: 'schema',
      payload_json: JSON.stringify(outSpec),
      owner_user_id: null,
    });
    return { table, schema_version: schemaVersion, seq, schema_spec: outSpec };
  } finally {
    closeQuiet(db);
  }
}

export async function listSharedObjectsDirect(
  cloudUrl: string,
  teamId: string,
): Promise<SharedObjectSummary[]> {
  const db = await openCloud(cloudUrl);
  try {
    const rows = (await db.query('__lattice_shared_objects', {
      filters: [
        { col: 'team_id', op: 'eq', val: teamId },
        { col: 'deleted_at', op: 'isNull' },
      ],
    })) as unknown as SharedObjectRow[];
    return rows.map((r) => ({
      table: r.table_name,
      schema_version: r.schema_version,
      created_by_user_id: r.created_by_user_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      schema_spec: JSON.parse(r.schema_spec_json) as SchemaSpec,
    }));
  } finally {
    closeQuiet(db);
  }
}

export async function unshareObjectDirect(
  cloudUrl: string,
  teamId: string,
  table: string,
): Promise<void> {
  const db = await openCloud(cloudUrl);
  try {
    const existing = (await db.query('__lattice_shared_objects', {
      filters: [
        { col: 'team_id', op: 'eq', val: teamId },
        { col: 'table_name', op: 'eq', val: table },
        { col: 'deleted_at', op: 'isNull' },
      ],
      limit: 1,
    })) as unknown as SharedObjectRow[];
    const row = existing[0];
    if (!row) return;
    await db.upsert('__lattice_shared_objects', {
      team_id: teamId,
      table_name: table,
      schema_spec_json: row.schema_spec_json,
      schema_version: row.schema_version,
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at,
      updated_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
    });
    await appendChangeEnvelopeDirect(db, {
      team_id: teamId,
      table_name: table,
      pk: null,
      op: 'unshare',
      payload_json: null,
      owner_user_id: null,
    });
  } finally {
    closeQuiet(db);
  }
}

/**
 * Direct-Postgres `me` — resolve the user identity from the cloud DB by
 * looking up the user whose `__lattice_api_tokens.token_hash` matches.
 * Bearer token is required so this is symmetric with the HTTP path.
 */
export async function meDirect(
  cloudUrl: string,
  bearerToken: string,
): Promise<{ user: { id: string; email: string | null; name: string | null } }> {
  const db = await openCloud(cloudUrl);
  try {
    const tokens = (await db.query('__lattice_api_tokens', {
      filters: [{ col: 'token_hash', op: 'eq', val: hashToken(bearerToken) }],
      limit: 1,
    })) as unknown as { user_id: string; revoked_at: string | null }[];
    const tok = tokens[0];
    if (!tok || tok.revoked_at) throw new Error('Unauthorized');
    const user = (await db.get('__lattice_users', tok.user_id)) as unknown as UserRow | null;
    if (!user || user.deleted_at) throw new Error('Unauthorized');
    return { user: { id: user.id, email: user.email, name: user.name } };
  } finally {
    closeQuiet(db);
  }
}

/**
 * Direct-Postgres status — local IS cloud, so there's no outbox-to-cloud
 * delivery to track. We just count the user's local-link rows for the
 * team and surface `last_change_seq = null` to signal "no pull cursor."
 */
export async function getStatusDirect(
  local: Lattice,
  teamId: string,
  teamName: string,
): Promise<SyncStatus> {
  const links = (await local.query('__lattice_local_links', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as unknown[];
  return {
    team_id: teamId,
    team_name: teamName,
    last_change_seq: null,
    outbox_depth: 0,
    outbox_failing: 0,
    dlq_depth: 0,
    local_links: links.length,
  };
}

/**
 * Direct-Postgres linkRow — records the link in both `__lattice_row_links`
 * on the cloud (already the same DB the operator's local Lattice reads)
 * and `__lattice_local_links` on the operator's local instance. The HTTP
 * path's "mirror the row into a separate team-shared table" step has no
 * analog in direct-mode — the table the user shared IS the team's table.
 */
export async function linkRowDirect(
  local: Lattice,
  cloudUrl: string,
  teamId: string,
  myUserId: string,
  table: string,
  pk: string,
): Promise<{ owner_user_id: string; seq: number }> {
  const cloud = await openCloud(cloudUrl);
  let seq: number;
  try {
    await cloud.upsert('__lattice_row_links', {
      team_id: teamId,
      table_name: table,
      pk,
      owner_user_id: myUserId,
      linked_at: new Date().toISOString(),
    });
    seq = await appendChangeEnvelopeDirect(cloud, {
      team_id: teamId,
      table_name: table,
      pk,
      op: 'link',
      payload_json: JSON.stringify({ owner_user_id: myUserId }),
      owner_user_id: myUserId,
    });
  } finally {
    closeQuiet(cloud);
  }
  await local.upsert('__lattice_local_links', {
    team_id: teamId,
    table_name: table,
    pk,
    owner_user_id: myUserId,
    linked_at: new Date().toISOString(),
  });
  return { owner_user_id: myUserId, seq };
}

export async function unlinkRowDirect(
  local: Lattice,
  cloudUrl: string,
  teamId: string,
  table: string,
  pk: string,
): Promise<void> {
  const cloud = await openCloud(cloudUrl);
  try {
    await cloud.delete('__lattice_row_links', { team_id: teamId, table_name: table, pk });
    await appendChangeEnvelopeDirect(cloud, {
      team_id: teamId,
      table_name: table,
      pk,
      op: 'unlink',
      payload_json: null,
      owner_user_id: null,
    });
  } finally {
    closeQuiet(cloud);
  }
  try {
    await local.delete('__lattice_local_links', { team_id: teamId, table_name: table, pk });
  } catch {
    // Already gone — fine.
  }
}

// ─── Per-table ownership (direct-Postgres) ──────────────────────────────
//
// Every team member connects to the same physical Postgres, so a table
// created by any member physically exists for everyone. Ownership +
// opt-in sharing is therefore enforced at the application layer: each
// table records an owner here, and the GUI shows a user only the tables
// they own PLUS tables in `__lattice_shared_objects` (shared to the
// team). These helpers run against the active GUI Lattice handle, which
// IS the cloud Postgres in direct mode — the internal tables must be
// registered on it first (see `registerTeamCloudTables` in the GUI).

interface ObjectOwnerRow {
  team_id: string;
  table_name: string;
  owner_user_id: string;
}

/**
 * Record `ownerUserId` as the owner of `tableName` for `teamId`.
 * First-writer-wins: if an owner row already exists it is left
 * untouched, so a later reconcile can't reassign a table away from the
 * member who created it.
 */
export async function recordObjectOwner(
  db: Lattice,
  teamId: string,
  tableName: string,
  ownerUserId: string,
): Promise<void> {
  const existing = (await db.query('__lattice_object_owners', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: tableName },
    ],
    limit: 1,
  })) as unknown as ObjectOwnerRow[];
  if (existing[0]) return;
  await db.upsert('__lattice_object_owners', {
    team_id: teamId,
    table_name: tableName,
    owner_user_id: ownerUserId,
    created_at: new Date().toISOString(),
  });
}

/** Map of table_name → owner_user_id for every owned table in `teamId`. */
export async function listObjectOwners(
  db: Lattice,
  teamId: string,
): Promise<Map<string, string>> {
  const rows = (await db.query('__lattice_object_owners', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as ObjectOwnerRow[];
  return new Map(rows.map((r) => [r.table_name, r.owner_user_id]));
}

/**
 * Assign any candidate table without an owner row to `creatorUserId`.
 * Backfills ownership for tables that predate the ownership registry
 * (or were created outside the GUI) so they default to the team
 * creator rather than being visible to everyone. Idempotent.
 */
export async function reconcileObjectOwners(
  db: Lattice,
  teamId: string,
  creatorUserId: string,
  candidateTables: string[],
): Promise<void> {
  if (!creatorUserId) return;
  const owners = await listObjectOwners(db, teamId);
  const now = new Date().toISOString();
  for (const table of candidateTables) {
    if (owners.has(table)) continue;
    await db.upsert('__lattice_object_owners', {
      team_id: teamId,
      table_name: table,
      owner_user_id: creatorUserId,
      created_at: now,
    });
  }
}

/** Resolve a non-deleted user's id by email (case-insensitive). */
export async function resolveUserIdByEmail(
  db: Lattice,
  email: string,
): Promise<string | null> {
  if (!email) return null;
  const users = (await db.query('__lattice_users', {
    filters: [{ col: 'deleted_at', op: 'isNull' }],
  })) as unknown as { id: string; email: string | null }[];
  const match = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
  return match?.id ?? null;
}
