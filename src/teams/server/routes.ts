import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../../lattice.js';
import { generateToken, generateInviteToken, hashToken, type AuthContext } from './auth.js';
import type { SchemaSpec } from '../schema-spec.js';

/**
 * Lattice Teams cloud-side route handlers.
 *
 * Phase 2 adds team management on top of Phase 1's auth scaffolding:
 *   - `/api/auth/{register,redeem-invite,me,tokens}` (with /tokens/:id DELETE)
 *   - `/api/teams` (POST, GET)
 *   - `/api/teams/:id` (DELETE — soft-delete; creator only)
 *   - `/api/teams/:id/members` (GET — member-only)
 *   - `/api/teams/:id/members/:userId` (DELETE — creator only)
 *   - `/api/teams/:id/invitations` (POST — creator only)
 *
 * `dispatchTeamRoute()` is wired into `startGuiServer()` after the
 * auth gate (Phase 1) and returns true once a route has been handled.
 * If it returns false, the existing GUI dispatcher takes over.
 */

export const UNAUTHENTICATED_TEAM_PATHS = new Set<string>([
  '/api/auth/register',
  '/api/auth/redeem-invite',
]);

interface TeamRouteContext {
  db: Lattice;
  authContext: AuthContext | null;
  pathname: string;
  method: string;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  deleted_at?: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  created_by_user_id: string;
  deleted_at?: string | null;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

interface InvitationRow {
  id: string;
  team_id: string;
  expires_at: string | null;
  redeemed_at: string | null;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  revoked_at: string | null;
}

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

interface ChangeLogRow {
  id: string;
  seq: number;
  team_id: string;
  table_name: string | null;
  op: string;
  payload_json: string | null;
  created_at: string;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${(e as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function requireString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim();
}

async function getMembershipRole(
  db: Lattice,
  teamId: string,
  userId: string,
): Promise<string | null> {
  const rows = (await db.query('__lattice_team_members', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'user_id', op: 'eq', val: userId },
    ],
    limit: 1,
  })) as unknown as TeamMemberRow[];
  return rows[0]?.role ?? null;
}

/**
 * Dispatch a team-routes request. Returns `true` when the path matched
 * (regardless of the response status); `false` lets the GUI dispatcher
 * fall through to its own routes.
 */
export async function dispatchTeamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  if (pathname === '/api/auth/register' && method === 'POST') {
    await handleRegister(req, res, ctx);
    return true;
  }
  if (pathname === '/api/auth/redeem-invite' && method === 'POST') {
    await handleRedeemInvite(req, res, ctx);
    return true;
  }
  if (pathname === '/api/auth/me' && method === 'GET') {
    handleMe(res, ctx);
    return true;
  }
  if (pathname === '/api/auth/tokens' && method === 'POST') {
    await handleCreateToken(req, res, ctx);
    return true;
  }
  const tokenMatch = /^\/api\/auth\/tokens\/([^/]+)$/.exec(pathname);
  if (tokenMatch && method === 'DELETE') {
    await handleRevokeToken(res, ctx, tokenMatch[1] ?? '');
    return true;
  }

  if (pathname === '/api/teams') {
    if (method === 'POST') {
      await handleCreateTeam(req, res, ctx);
      return true;
    }
    if (method === 'GET') {
      await handleListTeams(res, ctx);
      return true;
    }
  }

  const teamMatch = /^\/api\/teams\/([^/]+)$/.exec(pathname);
  if (teamMatch && method === 'DELETE') {
    await handleDeleteTeam(res, ctx, teamMatch[1] ?? '');
    return true;
  }

  const membersMatch = /^\/api\/teams\/([^/]+)\/members$/.exec(pathname);
  if (membersMatch && method === 'GET') {
    await handleListMembers(res, ctx, membersMatch[1] ?? '');
    return true;
  }

  const memberMatch = /^\/api\/teams\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
  if (memberMatch && method === 'DELETE') {
    await handleKickMember(res, ctx, memberMatch[1] ?? '', memberMatch[2] ?? '');
    return true;
  }

  const invitationsMatch = /^\/api\/teams\/([^/]+)\/invitations$/.exec(pathname);
  if (invitationsMatch && method === 'POST') {
    await handleCreateInvitation(req, res, ctx, invitationsMatch[1] ?? '');
    return true;
  }

  const objectsListMatch = /^\/api\/teams\/([^/]+)\/objects$/.exec(pathname);
  if (objectsListMatch) {
    if (method === 'POST') {
      await handleShareObject(req, res, ctx, objectsListMatch[1] ?? '');
      return true;
    }
    if (method === 'GET') {
      await handleListSharedObjects(res, ctx, objectsListMatch[1] ?? '');
      return true;
    }
  }

  const objectMatch = /^\/api\/teams\/([^/]+)\/objects\/([^/]+)$/.exec(pathname);
  if (objectMatch && method === 'DELETE') {
    await handleUnshareObject(
      res,
      ctx,
      objectMatch[1] ?? '',
      decodeURIComponent(objectMatch[2] ?? ''),
    );
    return true;
  }

  const changesMatch = /^\/api\/teams\/([^/]+)\/changes$/.exec(pathname);
  if (changesMatch && method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    await handleListChanges(res, ctx, changesMatch[1] ?? '', url.searchParams);
    return true;
  }

  return false;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
): Promise<void> {
  const body = await readJson(req);
  const email = requireString(body, 'email');
  const name = requireString(body, 'name');
  if (!email) {
    sendJson(res, { error: 'email is required' }, 400);
    return;
  }
  if (!name) {
    sendJson(res, { error: 'name is required' }, 400);
    return;
  }

  // Bootstrap-only — register works only on a fresh cloud with no users.
  // Once at least one user exists, new accounts must come via invitations.
  const existing = await ctx.db.query('__lattice_users', {
    filters: [{ col: 'deleted_at', op: 'isNull' }],
    limit: 1,
  });
  if (existing.length > 0) {
    sendJson(res, { error: 'Registration is disabled. Use an invitation token to join.' }, 403);
    return;
  }

  const now = new Date().toISOString();
  const userId = await ctx.db.insert('__lattice_users', {
    email,
    name,
    created_at: now,
    updated_at: now,
  });
  const { raw, hash } = generateToken();
  await ctx.db.insert('__lattice_api_tokens', {
    user_id: userId,
    token_hash: hash,
    name: 'bootstrap',
    created_at: now,
  });

  sendJson(res, { user: { id: userId, email, name }, raw_token: raw }, 201);
}

async function handleRedeemInvite(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
): Promise<void> {
  const body = await readJson(req);
  const inviteToken = requireString(body, 'invite_token');
  const email = requireString(body, 'email');
  const name = requireString(body, 'name');
  if (!inviteToken) {
    sendJson(res, { error: 'invite_token is required' }, 400);
    return;
  }
  if (!email) {
    sendJson(res, { error: 'email is required' }, 400);
    return;
  }
  if (!name) {
    sendJson(res, { error: 'name is required' }, 400);
    return;
  }

  const invites = (await ctx.db.query('__lattice_invitations', {
    filters: [
      { col: 'token_hash', op: 'eq', val: hashToken(inviteToken) },
      { col: 'redeemed_at', op: 'isNull' },
    ],
    limit: 1,
  })) as unknown as InvitationRow[];
  const invite = invites[0];
  if (!invite) {
    sendJson(res, { error: 'Invitation invalid or already used' }, 401);
    return;
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    sendJson(res, { error: 'Invitation expired' }, 410);
    return;
  }

  const team = (await ctx.db.get('__lattice_team', invite.team_id)) as unknown as TeamRow | null;
  if (!team || team.deleted_at) {
    sendJson(res, { error: 'Team no longer exists' }, 410);
    return;
  }

  // v1 simplification: every redemption creates a fresh user record on
  // this cloud. A single human joining two teams ends up with two cloud
  // user_ids — documented as a known limitation. Email-based identity
  // merging is a later refinement.
  const now = new Date().toISOString();
  const userId = await ctx.db.insert('__lattice_users', {
    email,
    name,
    created_at: now,
    updated_at: now,
  });
  await ctx.db.insert('__lattice_team_members', {
    team_id: invite.team_id,
    user_id: userId,
    role: 'member',
    joined_at: now,
  });
  const { raw, hash } = generateToken();
  await ctx.db.insert('__lattice_api_tokens', {
    user_id: userId,
    token_hash: hash,
    name: `invited:${team.name}`,
    created_at: now,
  });
  await ctx.db.update('__lattice_invitations', invite.id, {
    redeemed_at: now,
    redeemed_by_user_id: userId,
  });

  sendJson(
    res,
    {
      user: { id: userId, email, name },
      raw_token: raw,
      team: { id: team.id, name: team.name },
    },
    201,
  );
}

function handleMe(res: ServerResponse, ctx: TeamRouteContext): void {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  sendJson(res, { user: ctx.authContext.user });
}

async function handleCreateToken(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name : null;
  const now = new Date().toISOString();
  const { raw, hash } = generateToken();
  const id = await ctx.db.insert('__lattice_api_tokens', {
    user_id: ctx.authContext.user.id,
    token_hash: hash,
    name,
    created_at: now,
  });
  sendJson(res, { id, raw_token: raw, name }, 201);
}

async function handleRevokeToken(
  res: ServerResponse,
  ctx: TeamRouteContext,
  tokenId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const row = (await ctx.db.get('__lattice_api_tokens', tokenId)) as unknown as ApiTokenRow | null;
  if (row?.user_id !== ctx.authContext.user.id) {
    sendJson(res, { error: 'Token not found' }, 404);
    return;
  }
  if (!row.revoked_at) {
    await ctx.db.update('__lattice_api_tokens', tokenId, {
      revoked_at: new Date().toISOString(),
    });
  }
  sendJson(res, { ok: true });
}

async function handleCreateTeam(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const body = await readJson(req);
  const name = requireString(body, 'name');
  if (!name) {
    sendJson(res, { error: 'name is required' }, 400);
    return;
  }
  const now = new Date().toISOString();
  const teamId = await ctx.db.insert('__lattice_team', {
    name,
    created_by_user_id: ctx.authContext.user.id,
    created_at: now,
    updated_at: now,
  });
  await ctx.db.insert('__lattice_team_members', {
    team_id: teamId,
    user_id: ctx.authContext.user.id,
    role: 'creator',
    joined_at: now,
  });
  sendJson(res, { id: teamId, name, role: 'creator' }, 201);
}

async function handleListTeams(res: ServerResponse, ctx: TeamRouteContext): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const memberships = (await ctx.db.query('__lattice_team_members', {
    filters: [{ col: 'user_id', op: 'eq', val: ctx.authContext.user.id }],
  })) as unknown as TeamMemberRow[];
  if (memberships.length === 0) {
    sendJson(res, { teams: [] });
    return;
  }
  const teamIds = memberships.map((m) => m.team_id);
  const teams = (await ctx.db.query('__lattice_team', {
    filters: [
      { col: 'id', op: 'in', val: teamIds },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as TeamRow[];
  const roleByTeam = new Map(memberships.map((m) => [m.team_id, m.role]));
  sendJson(res, {
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      role: roleByTeam.get(t.id) ?? 'member',
    })),
  });
}

async function handleDeleteTeam(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (role !== 'creator') {
    sendJson(res, { error: 'Only the team creator can delete the team' }, 403);
    return;
  }
  const team = (await ctx.db.get('__lattice_team', teamId)) as unknown as TeamRow | null;
  if (!team || team.deleted_at) {
    sendJson(res, { error: 'Team not found' }, 404);
    return;
  }
  await ctx.db.update('__lattice_team', teamId, {
    deleted_at: new Date().toISOString(),
  });
  sendJson(res, { ok: true });
}

async function handleListMembers(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!role) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const members = (await ctx.db.query('__lattice_team_members', {
    filters: [{ col: 'team_id', op: 'eq', val: teamId }],
  })) as unknown as TeamMemberRow[];
  if (members.length === 0) {
    sendJson(res, { members: [] });
    return;
  }
  const userIds = members.map((m) => m.user_id);
  const users = (await ctx.db.query('__lattice_users', {
    filters: [
      { col: 'id', op: 'in', val: userIds },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as UserRow[];
  const userById = new Map(users.map((u) => [u.id, u]));
  sendJson(res, {
    members: members
      .map((m) => {
        const u = userById.get(m.user_id);
        if (!u) return null;
        return {
          user_id: m.user_id,
          email: u.email,
          name: u.name,
          role: m.role,
          joined_at: m.joined_at,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null),
  });
}

async function handleKickMember(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
  userId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const callerRole = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!callerRole) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const isSelf = userId === ctx.authContext.user.id;
  // Self-kick is the "leave team" action. Members can always leave;
  // creators must use DELETE /api/teams/:id (destroy) instead.
  if (callerRole === 'creator' && isSelf) {
    sendJson(
      res,
      {
        error: 'Creator cannot kick themselves — use DELETE /api/teams/:id to destroy the team',
      },
      400,
    );
    return;
  }
  if (callerRole !== 'creator' && !isSelf) {
    sendJson(res, { error: 'Only the team creator can kick other members' }, 403);
    return;
  }
  // 404 if the target isn't currently a member — keeps the semantic clean.
  const targetRole = await getMembershipRole(ctx.db, teamId, userId);
  if (!targetRole) {
    sendJson(res, { error: 'User is not a member of this team' }, 404);
    return;
  }
  // Composite-PK delete via the {team_id, user_id} lookup form. Phase 4
  // will extend this handler to also auto-unlink the kicked user's owned
  // rows; for now it just removes the membership row.
  await ctx.db.delete('__lattice_team_members', { team_id: teamId, user_id: userId });
  sendJson(res, { ok: true });
}

async function handleCreateInvitation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (role !== 'creator') {
    sendJson(res, { error: 'Only the team creator can invite members' }, 403);
    return;
  }
  const team = (await ctx.db.get('__lattice_team', teamId)) as unknown as TeamRow | null;
  if (!team || team.deleted_at) {
    sendJson(res, { error: 'Team not found' }, 404);
    return;
  }
  const body = await readJson(req);
  const expiresInHours =
    typeof body.expires_in_hours === 'number' && body.expires_in_hours > 0
      ? body.expires_in_hours
      : 7 * 24; // default: 7 days
  const expiresAt = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
  const { raw, hash } = generateInviteToken();
  const id = await ctx.db.insert('__lattice_invitations', {
    team_id: teamId,
    token_hash: hash,
    invited_by_user_id: ctx.authContext.user.id,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  sendJson(res, { id, raw_token: raw, expires_at: expiresAt, team_name: team.name }, 201);
}

// ── Object sharing + change feed (Phase 3) ─────────────────────────────────

/**
 * Compute the next monotonic sequence number for the change log.
 *
 * Phase 3 cloud is single-writer (one Lattice process per cloud), so a
 * MAX(seq) + 1 lookup is safe under the single-event-loop-at-a-time
 * invariant Node enforces between awaits. Phase 4 raises the concurrency
 * floor via the local-side outbox queueing model; if that ever pushes
 * multiple concurrent /api/... inserts on the cloud side, this helper
 * will need a transaction-scoped advisory lock.
 */
async function nextChangeSeq(db: Lattice): Promise<number> {
  const rows = (await db.query('__lattice_change_log', {
    orderBy: 'seq',
    orderDir: 'desc',
    limit: 1,
  })) as unknown as { seq: number }[];
  return (rows[0]?.seq ?? 0) + 1;
}

async function appendChangeEnvelope(
  db: Lattice,
  entry: { team_id: string; table_name: string | null; op: string; payload_json: string | null },
): Promise<number> {
  const seq = await nextChangeSeq(db);
  await db.insert('__lattice_change_log', {
    seq,
    team_id: entry.team_id,
    table_name: entry.table_name,
    op: entry.op,
    payload_json: entry.payload_json,
    created_at: new Date().toISOString(),
  });
  return seq;
}

async function handleShareObject(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!role) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const body = await readJson(req);
  const tableName = requireString(body, 'table');
  if (!tableName) {
    sendJson(res, { error: 'table is required' }, 400);
    return;
  }
  const rawSpec = body.schema_spec;
  if (!rawSpec || typeof rawSpec !== 'object') {
    sendJson(res, { error: 'schema_spec must be an object' }, 400);
    return;
  }
  const rawRecord = rawSpec as Record<string, unknown>;
  if (!rawRecord.columns || typeof rawRecord.columns !== 'object') {
    sendJson(res, { error: 'schema_spec.columns is required' }, 400);
    return;
  }
  if (rawRecord.primaryKey === undefined) {
    sendJson(res, { error: 'schema_spec.primaryKey is required' }, 400);
    return;
  }
  const spec = rawSpec as SchemaSpec;
  const now = new Date().toISOString();
  // Upsert by composite key: re-sharing the same table bumps schema_version
  // and updates spec_json. New entry → version 1.
  const existing = (await ctx.db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: tableName },
    ],
    limit: 1,
  })) as unknown as SharedObjectRow[];
  const prior = existing[0];
  let schemaVersion: number;
  let outSpec: SchemaSpec;
  if (prior && !prior.deleted_at) {
    schemaVersion = prior.schema_version + 1;
    outSpec = { ...spec, schemaVersion };
    await ctx.db.upsert('__lattice_shared_objects', {
      team_id: teamId,
      table_name: tableName,
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
    await ctx.db.upsert('__lattice_shared_objects', {
      team_id: teamId,
      table_name: tableName,
      schema_spec_json: JSON.stringify(outSpec),
      schema_version: schemaVersion,
      created_by_user_id: ctx.authContext.user.id,
      created_at: prior?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
    });
  }
  const seq = await appendChangeEnvelope(ctx.db, {
    team_id: teamId,
    table_name: tableName,
    op: 'schema',
    payload_json: JSON.stringify(outSpec),
  });
  sendJson(
    res,
    { table: tableName, schema_version: schemaVersion, seq, schema_spec: outSpec },
    prior && !prior.deleted_at ? 200 : 201,
  );
}

async function handleListSharedObjects(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!role) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const rows = (await ctx.db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'deleted_at', op: 'isNull' },
    ],
  })) as unknown as SharedObjectRow[];
  const objects = rows.map((r) => ({
    table: r.table_name,
    schema_version: r.schema_version,
    created_by_user_id: r.created_by_user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    schema_spec: JSON.parse(r.schema_spec_json) as SchemaSpec,
  }));
  sendJson(res, { objects });
}

async function handleUnshareObject(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
  tableName: string,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!role) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const existing = (await ctx.db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: tableName },
    ],
    limit: 1,
  })) as unknown as SharedObjectRow[];
  const prior = existing[0];
  if (!prior || prior.deleted_at) {
    sendJson(res, { error: 'Object not currently shared' }, 404);
    return;
  }
  // Only the original sharer or the team creator can unshare.
  if (prior.created_by_user_id !== ctx.authContext.user.id && role !== 'creator') {
    sendJson(
      res,
      { error: 'Only the original sharer or the team creator can unshare this object' },
      403,
    );
    return;
  }
  const now = new Date().toISOString();
  await ctx.db.update(
    '__lattice_shared_objects',
    { team_id: teamId, table_name: tableName },
    { deleted_at: now, updated_at: now },
  );
  await appendChangeEnvelope(ctx.db, {
    team_id: teamId,
    table_name: tableName,
    op: 'unshare',
    payload_json: null,
  });
  sendJson(res, { ok: true });
}

async function handleListChanges(
  res: ServerResponse,
  ctx: TeamRouteContext,
  teamId: string,
  params: URLSearchParams,
): Promise<void> {
  if (!ctx.authContext) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  const role = await getMembershipRole(ctx.db, teamId, ctx.authContext.user.id);
  if (!role) {
    sendJson(res, { error: 'Not a member of this team' }, 403);
    return;
  }
  const sinceRaw = params.get('since');
  const limitRaw = params.get('limit');
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : 0;
  const limitParsed = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 500;
  const limit = Math.min(Math.max(limitParsed, 1), 1000);
  const rows = (await ctx.db.query('__lattice_change_log', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'seq', op: 'gt', val: since },
    ],
    orderBy: 'seq',
    orderDir: 'asc',
    limit,
  })) as unknown as ChangeLogRow[];
  const envelopes = rows.map((r) => ({
    seq: r.seq,
    table_name: r.table_name,
    op: r.op,
    payload: r.payload_json ? (JSON.parse(r.payload_json) as unknown) : null,
    created_at: r.created_at,
  }));
  const hasMore = envelopes.length === limit;
  sendJson(res, { envelopes, has_more: hasMore });
}
