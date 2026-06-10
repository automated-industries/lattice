import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { deleteDbCredential, saveDbCredentialForTeam } from '../framework/user-config.js';
import { parseConfigFile } from '../config/parser.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import {
  registerOrUpdateCloudWorkspace,
  removeWorkspaceByConfigPath,
} from '../framework/workspace.js';
import { resolveContextDirForConfig } from '../framework/gui-bootstrap.js';
import { sendJson, readJson } from './http.js';
import {
  TeamsClient,
  TeamsHttpError,
  DIRECT_CLOUD_DEPRECATION_MESSAGE,
  type TeamConnection,
} from '../teams/client.js';
import { isPostgresUrl } from '../teams/register-direct.js';
import { serializeSchema } from '../teams/schema-spec.js';

/**
 * Remove the local sibling YAML config (and its saved db-credential)
 * that points at `cloudUrl`, so a team the operator just left/was
 * removed from disappears from the header dropdown and can no longer be
 * switched to. Best-effort: a failure here must not fail the leave/kick
 * itself (the authoritative membership change already happened on the
 * cloud). Idempotent — does nothing if no matching config is found.
 */
function removeTeamConfigForCloud(ctx: TeamsGuiContext, cloudUrl: string): void {
  try {
    const dir = dirname(ctx.configPath);
    const root = findLatticeRoot(dir);
    for (const fname of readdirSync(dir)) {
      if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
      const full = join(dir, fname);
      let resolvedDb: string;
      try {
        resolvedDb = parseConfigFile(full).dbPath;
      } catch {
        continue; // unparseable or credential gone — skip
      }
      if (resolvedDb !== cloudUrl) continue;
      // Matched the team config. Pull the credential label from the raw
      // `db: ${LATTICE_DB:<label>}` line so we can drop the credential too.
      const raw = readFileSync(full, 'utf8');
      const labelMatch = /^\s*db:\s*\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}/m.exec(raw);
      if (labelMatch?.[1]) {
        try {
          deleteDbCredential(labelMatch[1]);
        } catch {
          // credential already gone — fine
        }
      }
      // Drop the registry record so the workspace leaves the header switcher.
      if (root) removeWorkspaceByConfigPath(root, full);
      rmSync(full, { force: true });
    }
  } catch {
    // Directory unreadable — leave the config in place; the membership
    // change on the cloud is what matters.
  }
}

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
  /** Absolute path to the currently-active YAML config. */
  configPath: string;
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
  /**
   * The active DB's Postgres URL when it IS a team cloud (direct mode),
   * else null. Used by {@link getConnection} to synthesize a connection
   * when there's no local `__lattice_team_connections` row — which is
   * the case when the team cloud itself is the active database.
   */
  cloudUrl: string | null;
  /** Resolved team identity/role for the active cloud DB, or null. */
  teamContext: { teamId: string; myUserId: string; isCreator: boolean; isMember: boolean } | null;
}

/**
 * Write a sibling YAML config that points at a saved db-credential
 * label. After this lands on disk, listConfigs() picks it up as a
 * dropdown entry and the user can switch databases without hand-editing
 * any YAML.
 *
 * Skips writing if a file already exists at the target path — the
 * credential save in saveDbCredentialForTeam disambiguates the label by
 * appending the short team id, so the YAML file follows suit.
 * Returns the path written (or the existing path if it was already
 * present).
 */
function writeTeamConfigYaml(
  activeConfigPath: string,
  credentialLabel: string,
  teamName: string,
): string {
  const projectDir = dirname(activeConfigPath);
  const yamlPath = join(projectDir, `${credentialLabel}.yml`);
  if (existsSync(yamlPath)) return yamlPath;
  const safeName = teamName.replace(/[\r\n]/g, ' ');
  const yaml =
    `# Joined-team config — managed by lattice gui. Edit entities: to add\n` +
    `# locally-projected tables of the team's shared data; the cloud DB at\n` +
    `# ${credentialLabel} is the authoritative source.\n` +
    `db: \${LATTICE_DB:${credentialLabel}}\n` +
    `\n` +
    // `name:` is the friendly label shown in the header dropdown + DB
    // settings. Writing the team name here lets listConfigs() resolve a
    // readable label without opening the cloud DB.
    `name: ${JSON.stringify(safeName)}\n` +
    `entities: {}\n`;
  writeFileSync(yamlPath, yaml, 'utf8');
  return yamlPath;
}

function requireString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim();
}

async function getConnection(ctx: TeamsGuiContext, teamId: string): Promise<TeamConnection | null> {
  const conns = await ctx.client.listConnections();
  const local = conns.find((c) => c.team_id === teamId);
  if (local) return local;
  // No local connection row — fall back to the active cloud DB when it
  // IS this team's cloud (direct-Postgres mode). The connection metadata
  // (cloud url + my user id) comes from the resolved team context; the
  // bearer token is unused on the direct-Postgres path.
  if (ctx.cloudUrl && ctx.teamContext?.teamId === teamId) {
    return {
      team_id: teamId,
      team_name: '',
      cloud_url: ctx.cloudUrl,
      my_user_id: ctx.teamContext.myUserId,
      api_token: '',
      joined_at: '',
    };
  }
  return null;
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
  const conn = await getConnection(ctx, teamId);
  if (!conn) {
    sendJson(res, { error: `No local connection for team-id "${teamId}"` }, 404);
    return;
  }

  // /api/teams-gui/teams/:id (DELETE = destroy) — creator only.
  if (subpath === '' && method === 'DELETE') {
    if (ctx.teamContext && !ctx.teamContext.isCreator) {
      sendJson(res, { error: 'Only the team owner can destroy the team' }, 403);
      return;
    }
    await ctx.client.destroyTeam(conn.cloud_url, conn.api_token);
    await ctx.client.deleteConnection(teamId);
    removeTeamConfigForCloud(ctx, conn.cloud_url);
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
  // /api/teams-gui/teams/:id/invitations (GET = list pending invitees)
  if (subpath === 'invitations' && method === 'GET') {
    const invitations = await ctx.client.listPendingInvitations(
      conn.cloud_url,
      conn.api_token,
      teamId,
    );
    sendJson(res, { invitations });
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
  // /api/teams-gui/teams/:id/members/:userId (DELETE = kick).
  // Removing another member requires the team owner; removing yourself
  // (leaving) is always allowed.
  const kickMatch = /^members\/([^/]+)$/.exec(subpath);
  if (kickMatch && method === 'DELETE') {
    const targetUserId = kickMatch[1] ?? '';
    const isSelf = targetUserId === conn.my_user_id;
    if (!isSelf && ctx.teamContext && !ctx.teamContext.isCreator) {
      sendJson(res, { error: 'Only the team owner can remove other members' }, 403);
      return;
    }
    await ctx.client.kickMember(conn.cloud_url, conn.api_token, teamId, targetUserId);
    // If the operator removed themselves, tear down their local pointer
    // to the cloud so it leaves the dropdown and is no longer accessible.
    if (isSelf) {
      await ctx.client.deleteConnection(teamId);
      removeTeamConfigForCloud(ctx, conn.cloud_url);
    }
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
  // Make the joined team's cloud DB switchable in the dropdown: save an
  // encrypted credential keyed by a sanitized label, then write a
  // sibling YAML config alongside the active project's config that
  // points at ${LATTICE_DB:<label>}. listConfigs() will pick it up on
  // the next /api/databases poll.
  const credentialLabel = saveDbCredentialForTeam({
    teamName: result.team.name,
    teamId: result.team.id,
    cloudUrl,
  });
  const configYamlPath = writeTeamConfigYaml(ctx.configPath, credentialLabel, result.team.name);
  // Register the joined cloud DB as a workspace so it appears in the header
  // switcher and is switchable. The registry is the single source of truth —
  // without this the joined workspace would only show in the legacy config
  // scan, never the workspace list (the bug this fixes).
  const workspaceId = registerJoinedCloudWorkspace(
    ctx.configPath,
    configYamlPath,
    credentialLabel,
    result.team.name,
  );
  sendJson(res, {
    ok: true,
    team: result.team,
    user: result.user,
    credential_label: credentialLabel,
    config_path: configYamlPath,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  });
}

/**
 * Register a joined/created cloud DB (behind a saved credential label) as a
 * workspace in the `.lattice` registry. Returns the workspace id, or null when
 * the GUI is not running inside a root (should not happen for `lattice gui`).
 */
function registerJoinedCloudWorkspace(
  activeConfigPath: string,
  configYamlPath: string,
  credentialLabel: string,
  teamName: string,
): string | null {
  const root = findLatticeRoot(dirname(activeConfigPath));
  if (!root) return null;
  const ws = registerOrUpdateCloudWorkspace(root, {
    configPath: configYamlPath,
    contextDir: resolveContextDirForConfig(configYamlPath),
    displayName: teamName,
    db: '${LATTICE_DB:' + credentialLabel + '}',
    makeActive: false,
  });
  return ws.id;
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
  // 2.2: creating a NEW direct postgres:// workspace is deprecated — it bypasses
  // the per-recipient sync filter and can't enforce row-level security. Reject it
  // here too (the TeamsClient dispatch blocks the same on join / upgrade), so the
  // GUI's two entry points are consistent. The hosted http(s):// register path is
  // unaffected.
  if (isPostgresUrl(cloudUrl)) {
    sendJson(res, { error: DIRECT_CLOUD_DEPRECATION_MESSAGE }, 400);
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
  // Persist the created cloud DB as a switchable workspace (parallel to join):
  // encrypted credential + managed sibling config + registry record.
  const credentialLabel = saveDbCredentialForTeam({
    teamName: reg.team.name,
    teamId: reg.team.id,
    cloudUrl,
  });
  const configYamlPath = writeTeamConfigYaml(ctx.configPath, credentialLabel, reg.team.name);
  const workspaceId = registerJoinedCloudWorkspace(
    ctx.configPath,
    configYamlPath,
    credentialLabel,
    reg.team.name,
  );
  sendJson(res, {
    ok: true,
    team: reg.team,
    user: reg.user,
    credential_label: credentialLabel,
    config_path: configYamlPath,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  });
}

async function handleLeave(
  res: ServerResponse,
  ctx: TeamsGuiContext,
  teamId: string,
): Promise<void> {
  const conn = await getConnection(ctx, teamId);
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
  removeTeamConfigForCloud(ctx, conn.cloud_url);
  sendJson(res, { ok: true });
}
