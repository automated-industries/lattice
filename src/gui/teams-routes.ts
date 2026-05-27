import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { TeamsClient, TeamsHttpError, type TeamConnection } from '../teams/client.js';
import { serializeSchema } from '../teams/schema-spec.js';

/**
 * GUI-side HTTP routes that wrap the local user's `TeamsClient`. These
 * are the endpoints the SPA's Project Config / User Config views call.
 *
 * Auth model: these routes run inside `lattice gui` (the localhost dev
 * GUI), which is unauthenticated by design — the user has filesystem
 * access to the lattice DB anyway. `teamCloud` mode never invokes
 * this dispatcher (it disables the GUI's other dev-tool endpoints
 * too — see `startGuiServer`).
 *
 * Each handler resolves the user's team connection by `team_id`,
 * extracts the cloud URL + bearer token, and forwards the operation
 * to TeamsClient. Errors from the upstream cloud surface as JSON with
 * the original status code.
 */

interface TeamsGuiContext {
  db: Lattice;
  client: TeamsClient;
  pathname: string;
  method: string;
  /**
   * Mutable reference to the parent server's `validTables` set. The
   * GUI's `/api/tables/*` CRUD routes gate on this; without sync-time
   * refresh, tables added via `defineLate` (from cloud schema envelopes)
   * stay invisible to the SPA's table viewer. We mutate this set
   * after every sync.
   */
  validTables: Set<string>;
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

async function getConnection(client: TeamsClient, teamId: string): Promise<TeamConnection | null> {
  const conns = await client.listConnections();
  return conns.find((c) => c.team_id === teamId) ?? null;
}

/**
 * Wrap a handler with a uniform try/catch so upstream TeamsHttpError
 * surfaces as the same status the cloud returned, while everything
 * else 500s with the message.
 */
async function tryHandler(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TeamsHttpError) {
      sendJson(res, { error: e.message, status: e.status }, e.status);
      return;
    }
    sendJson(res, { error: (e as Error).message }, 500);
  }
}

/**
 * Dispatch GUI-side teams API. Returns true once a route matches —
 * caller falls through to the GUI's existing 404 handler otherwise.
 */
export async function dispatchTeamsGuiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamsGuiContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  if (pathname === '/api/teams-gui/connections' && method === 'GET') {
    await tryHandler(res, async () => {
      const conns = await ctx.client.listConnections();
      sendJson(res, {
        connections: conns.map((c) => ({
          team_id: c.team_id,
          team_name: c.team_name,
          cloud_url: c.cloud_url,
          my_user_id: c.my_user_id,
          joined_at: c.joined_at,
        })),
      });
    });
    return true;
  }

  if (pathname === '/api/teams-gui/connections/join' && method === 'POST') {
    await tryHandler(res, () => handleJoin(req, res, ctx));
    return true;
  }

  if (pathname === '/api/teams-gui/connections/register-and-create' && method === 'POST') {
    await tryHandler(res, () => handleRegisterAndCreate(req, res, ctx));
    return true;
  }

  if (pathname === '/api/teams-gui/links' && method === 'GET') {
    await tryHandler(res, async () => {
      const links = await ctx.db.query('__lattice_local_links', {});
      sendJson(res, { links });
    });
    return true;
  }

  const teamIdMatch = /^\/api\/teams-gui\/teams\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (teamIdMatch) {
    const teamId = teamIdMatch[1] ?? '';
    const subpath = teamIdMatch[2] ?? '';
    await tryHandler(res, () => dispatchTeamSubroute(req, res, ctx, teamId, subpath));
    return true;
  }

  const connDelMatch = /^\/api\/teams-gui\/connections\/([^/]+)$/.exec(pathname);
  if (connDelMatch && method === 'DELETE') {
    const teamId = connDelMatch[1] ?? '';
    await tryHandler(res, () => handleLeave(res, ctx, teamId));
    return true;
  }

  return false;
}

async function dispatchTeamSubroute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamsGuiContext,
  teamId: string,
  subpath: string,
): Promise<void> {
  const { method } = ctx;
  const conn = await getConnection(ctx.client, teamId);
  if (!conn) {
    sendJson(res, { error: `No local connection for team-id "${teamId}"` }, 404);
    return;
  }

  // /api/teams-gui/teams/:id (DELETE = destroy)
  if (subpath === '' && method === 'DELETE') {
    await ctx.client.destroyTeam(conn.cloud_url, conn.api_token);
    await ctx.client.deleteConnection(teamId);
    sendJson(res, { ok: true });
    return;
  }
  // /api/teams-gui/teams/:id/sync (POST)
  if (subpath === 'sync' && method === 'POST') {
    const pull = await ctx.client.pullChanges(conn);
    const push = await ctx.client.drainOutbox(conn);
    // Pull may have registered new tables via defineLate (schema envelopes).
    // Refresh the GUI's validTables so the table viewer can see them.
    for (const t of ctx.db.getRegisteredTableNames()) ctx.validTables.add(t);
    sendJson(res, { pull, push });
    return;
  }
  // /api/teams-gui/teams/:id/status (GET)
  if (subpath === 'status' && method === 'GET') {
    sendJson(res, await ctx.client.getStatus(conn));
    return;
  }
  // /api/teams-gui/teams/:id/members (GET)
  if (subpath === 'members' && method === 'GET') {
    const members = await ctx.client.listMembers(conn.cloud_url, conn.api_token, teamId);
    sendJson(res, { members });
    return;
  }
  // /api/teams-gui/teams/:id/invitations (POST)
  if (subpath === 'invitations' && method === 'POST') {
    const body = await readJson(req);
    const inviteeEmail = requireString(body, 'invitee_email');
    if (!inviteeEmail) {
      sendJson(res, { error: 'invitee_email is required' }, 400);
      return;
    }
    const hours = typeof body.expires_in_hours === 'number' ? body.expires_in_hours : undefined;
    // Pass conn.my_user_id as the inviter so the direct-Postgres path
    // can stamp `invited_by_user_id` correctly. The HTTP path ignores
    // this — the cloud server resolves the inviter from the bearer.
    const invite = await ctx.client.invite(
      conn.cloud_url,
      conn.api_token,
      teamId,
      inviteeEmail,
      hours,
      conn.my_user_id,
    );
    sendJson(res, invite);
    return;
  }
  // /api/teams-gui/teams/:id/members/:userId (DELETE = kick)
  const kickMatch = /^members\/([^/]+)$/.exec(subpath);
  if (kickMatch && method === 'DELETE') {
    await ctx.client.kickMember(conn.cloud_url, conn.api_token, teamId, kickMatch[1] ?? '');
    sendJson(res, { ok: true });
    return;
  }
  // /api/teams-gui/teams/:id/shared (GET)
  if (subpath === 'shared' && method === 'GET') {
    const objects = await ctx.client.listSharedObjects(conn.cloud_url, conn.api_token, teamId);
    sendJson(res, { objects });
    return;
  }
  // /api/teams-gui/teams/:id/shared (POST = share)
  if (subpath === 'shared' && method === 'POST') {
    const body = await readJson(req);
    const table = requireString(body, 'table');
    if (!table) {
      sendJson(res, { error: 'table is required' }, 400);
      return;
    }
    const cols = ctx.db.getRegisteredColumns(table);
    if (!cols) {
      sendJson(res, { error: `Table "${table}" is not registered locally` }, 404);
      return;
    }
    const spec = serializeSchema(
      { columns: cols, render: () => '', outputFile: '' },
      ctx.db.getPrimaryKey(table),
    );
    const result = await ctx.client.shareObject(
      conn.cloud_url,
      conn.api_token,
      teamId,
      table,
      spec,
      conn.my_user_id,
    );
    sendJson(res, result);
    return;
  }
  // /api/teams-gui/teams/:id/shared/:table (DELETE = unshare)
  const unshareMatch = /^shared\/(.+)$/.exec(subpath);
  if (unshareMatch && method === 'DELETE') {
    const table = decodeURIComponent(unshareMatch[1] ?? '');
    await ctx.client.unshareObject(conn.cloud_url, conn.api_token, teamId, table);
    sendJson(res, { ok: true });
    return;
  }
  // /api/teams-gui/teams/:id/links (POST = link a row)
  if (subpath === 'links' && method === 'POST') {
    const body = await readJson(req);
    const table = requireString(body, 'table');
    const pk = requireString(body, 'pk');
    if (!table || !pk) {
      sendJson(res, { error: 'table + pk required' }, 400);
      return;
    }
    const result = await ctx.client.linkRow(conn, table, pk);
    sendJson(res, result);
    return;
  }
  // /api/teams-gui/teams/:id/links/:table/:pk (DELETE = unlink)
  const linkDelMatch = /^links\/([^/]+)\/(.+)$/.exec(subpath);
  if (linkDelMatch && method === 'DELETE') {
    const table = decodeURIComponent(linkDelMatch[1] ?? '');
    const pk = decodeURIComponent(linkDelMatch[2] ?? '');
    await ctx.client.unlinkRow(conn, table, pk);
    sendJson(res, { ok: true });
    return;
  }

  sendJson(res, { error: `Unknown team subroute "${subpath}"` }, 404);
}

async function handleJoin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamsGuiContext,
): Promise<void> {
  const body = await readJson(req);
  const cloudUrl = requireString(body, 'cloud_url');
  const inviteToken = requireString(body, 'invite_token');
  const email = requireString(body, 'email');
  const name = requireString(body, 'name');
  if (!cloudUrl || !inviteToken || !email || !name) {
    sendJson(res, { error: 'cloud_url, invite_token, email, name required' }, 400);
    return;
  }
  const result = await ctx.client.redeemInvite(cloudUrl, inviteToken, email, name);
  await ctx.client.saveConnection({
    team_id: result.team.id,
    team_name: result.team.name,
    cloud_url: cloudUrl,
    my_user_id: result.user.id,
    api_token: result.raw_token,
  });
  sendJson(res, { ok: true, team: result.team, user: result.user });
}

async function handleRegisterAndCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TeamsGuiContext,
): Promise<void> {
  const body = await readJson(req);
  const cloudUrl = requireString(body, 'cloud_url');
  const email = requireString(body, 'email');
  const userName = requireString(body, 'user_name');
  const teamName = requireString(body, 'team_name');
  if (!cloudUrl || !email || !userName || !teamName) {
    sendJson(res, { error: 'cloud_url, email, user_name, team_name required' }, 400);
    return;
  }
  const reg = await ctx.client.register(cloudUrl, email, userName, teamName);
  await ctx.client.saveConnection({
    team_id: reg.team.id,
    team_name: reg.team.name,
    cloud_url: cloudUrl,
    my_user_id: reg.user.id,
    api_token: reg.raw_token,
  });
  sendJson(res, { ok: true, team: reg.team, user: reg.user });
}

async function handleLeave(
  res: ServerResponse,
  ctx: TeamsGuiContext,
  teamId: string,
): Promise<void> {
  const conn = await getConnection(ctx.client, teamId);
  if (!conn) {
    sendJson(res, { error: `No local connection for team-id "${teamId}"` }, 404);
    return;
  }
  try {
    // Self-kick on the cloud (leaves the team). Creators get 400 — they
    // must destroy via DELETE /teams-gui/teams/:id.
    await ctx.client.kickMember(conn.cloud_url, conn.api_token, teamId, conn.my_user_id);
  } catch (e) {
    if (e instanceof TeamsHttpError && e.status === 400) {
      sendJson(
        res,
        {
          error:
            'You are the creator of this team. Use DELETE /api/teams-gui/teams/:id to destroy it.',
        },
        400,
      );
      return;
    }
    throw e;
  }
  await ctx.client.deleteConnection(teamId);
  sendJson(res, { ok: true });
}
