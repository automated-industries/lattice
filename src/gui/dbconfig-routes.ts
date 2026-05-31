import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { Lattice } from '../lattice.js';
import { sendJson, readJson, tryHandler } from './http.js';
import {
  getDbCredential,
  saveDbCredential,
  listDbCredentials,
  getOrCreateMasterKey,
  readIdentity,
  readToken,
} from '../framework/user-config.js';
import { probeCloud } from '../framework/cloud-connect.js';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../framework/cloud-migration.js';
import { TeamsClient } from '../teams/client.js';
import { parseConfigFile } from '../config/parser.js';

/**
 * Endpoints for the Project Config "Database" panel. They wrap three
 * operations:
 *
 *   - reading the currently-active DB shape (sqlite vs postgres + which
 *     label, with password redacted),
 *   - saving a new DB configuration (writes the encrypted credential to
 *     ~/.lattice/db-credentials.enc + updates the active YAML's `db:`
 *     line to `${LATTICE_DB:<label>}`),
 *   - testing a candidate connection without swapping the active DB,
 *   - swapping the active Lattice to the saved config (delegates to the
 *     caller-supplied `swap()` callback so the parent server's
 *     `active` reference stays the single source of truth).
 *
 * Auth model: localhost trust, identical to teams-routes / userconfig-routes.
 * team-cloud mode does not mount this dispatcher.
 */

interface DbConfigContext {
  db: Lattice;
  configPath: string;
  pathname: string;
  method: string;
  /**
   * Resolved team membership for the active DB (null for non-team DBs).
   * `joined` is true once the operator's identity resolves to a cloud
   * member — this is the authoritative "am I in the team?" signal,
   * replacing the fragile token-file probe that made already-joined
   * members render the "paste invite token" state. `isCreator` gates
   * owner-only actions like renaming the cloud DB.
   */
  teamMembership: { joined: boolean; isCreator: boolean; teamId: string; myUserId: string } | null;
  /**
   * Re-open the same configPath after the YAML has been updated.
   * Closes the current Lattice and replaces it. Caller-owned because
   * the parent server holds the mutable `active` reference.
   */
  swap: () => Promise<void>;
}

/** Build a Postgres URL from form fields. Percent-encodes user + password. */
function buildPostgresUrl(params: {
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
}): string {
  const u = encodeURIComponent(params.user);
  const p = encodeURIComponent(params.password);
  return `postgres://${u}:${p}@${params.host}:${String(params.port)}/${params.dbname}`;
}

/** Parse a Postgres URL back into its component fields (no password). */
function parsePostgresUrl(url: string): {
  host: string;
  port: number;
  dbname: string;
  user: string;
} | null {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/i.test(u.protocol)) return null;
    const dbname = u.pathname.replace(/^\//, '');
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      dbname,
      user: decodeURIComponent(u.username),
    };
  } catch {
    return null;
  }
}

export type DbConfigState =
  | 'local'
  | 'cloud-connected'
  | 'team-cloud-creator'
  | 'team-cloud-member'
  | 'team-cloud-needs-invite';

interface DbInfo {
  type: 'sqlite' | 'postgres';
  state: DbConfigState;
  label?: string;
  dbFile?: string;
  host?: string;
  port?: number;
  dbname?: string;
  user?: string;
  teamEnabled: boolean;
  teamName?: string;
}

/**
 * Read `__lattice_team_identity.creator_email` if the singleton is
 * present. Returns null when the table doesn't exist or the row is
 * absent — used to decide creator-vs-member when computing state.
 */
async function getCreatorEmail(db: Lattice): Promise<string | null> {
  try {
    const row = (await db.get('__lattice_team_identity', 'singleton')) as {
      creator_email?: string;
    } | null;
    return row?.creator_email ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute the panel's state. Combines the YAML's `db:` shape + the
 * active Lattice's `__lattice_team_identity` row + the operator's
 * `~/.lattice/keys/<label>.token` presence + `creator_email` match.
 */
function computeState(
  type: 'sqlite' | 'postgres',
  teamEnabled: boolean,
  label: string | undefined,
  creatorEmail: string | null,
): DbConfigState {
  if (type === 'sqlite') return 'local';
  if (!teamEnabled) return 'cloud-connected';
  // teamEnabled + postgres: need to disambiguate creator/member/needs-invite.
  if (!label) {
    // Postgres with team identity but no label in db-credentials.enc.
    // Operator pasted a raw URL; we can't look up a token by label,
    // so we conservatively report needs-invite.
    return 'team-cloud-needs-invite';
  }
  let token: string | null = null;
  try {
    token = readToken(label);
  } catch {
    token = null;
  }
  if (!token) return 'team-cloud-needs-invite';
  // Have a token + team is enabled. Distinguish creator vs member by
  // matching identity.email against __lattice_team_identity.creator_email.
  const identity = readIdentity();
  if (
    creatorEmail !== null &&
    identity.email.length > 0 &&
    creatorEmail.toLowerCase() === identity.email.toLowerCase()
  ) {
    return 'team-cloud-creator';
  }
  return 'team-cloud-member';
}

/**
 * Override the YAML-derived state with the operator's resolved team
 * membership. Membership is the authoritative "am I in this team?"
 * signal (the operator's identity resolves to a cloud member), so an
 * already-joined member never renders the "paste invite token" panel,
 * and a non-member pointed at a team cloud correctly does. Non-team /
 * local DBs (no membership, or non-postgres) keep their original state.
 *
 * Exported for unit testing — the live override needs a Postgres team
 * cloud, which CI can't spin up; this keeps the decision pure + covered.
 */
export function applyTeamMembershipState(
  info: { type?: string; teamEnabled?: boolean; state?: DbConfigState },
  membership: { joined: boolean; isCreator: boolean } | null,
): DbConfigState | undefined {
  if (!membership || info.type !== 'postgres' || !info.teamEnabled) return info.state;
  return membership.joined
    ? membership.isCreator
      ? 'team-cloud-creator'
      : 'team-cloud-member'
    : 'team-cloud-needs-invite';
}

/** Inspect the YAML's `db:` line + the active Lattice for the team-status flag. */
async function describeCurrent(configPath: string, db: Lattice): Promise<DbInfo> {
  const rawYaml = readFileSync(configPath, 'utf8');
  const doc = parseDocument(rawYaml);
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const teamEnabled = await detectTeamEnabled(db);
  const creatorEmail = teamEnabled ? await getCreatorEmail(db) : null;
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);

  let identityRow: { team_name?: string } | null = null;
  if (teamEnabled) {
    try {
      identityRow = (await db.get('__lattice_team_identity', 'singleton')) as {
        team_name?: string;
      } | null;
    } catch {
      identityRow = null;
    }
  }
  const teamName = identityRow?.team_name;

  if (labelMatch) {
    const label = labelMatch[1] ?? '';
    const url = getDbCredential(label);
    const state = computeState('postgres', teamEnabled, label, creatorEmail);
    if (url) {
      const parsed = parsePostgresUrl(url);
      if (parsed) {
        return {
          type: 'postgres',
          state,
          label,
          host: parsed.host,
          port: parsed.port,
          dbname: parsed.dbname,
          user: parsed.user,
          teamEnabled,
          ...(teamName !== undefined ? { teamName } : {}),
        };
      }
    }
    return {
      type: 'postgres',
      state,
      label,
      teamEnabled,
      ...(teamName !== undefined ? { teamName } : {}),
    };
  }
  if (/^postgres(ql)?:\/\//i.test(dbLine)) {
    const parsed = parsePostgresUrl(dbLine);
    const state = computeState('postgres', teamEnabled, undefined, creatorEmail);
    return parsed
      ? {
          type: 'postgres',
          state,
          host: parsed.host,
          port: parsed.port,
          dbname: parsed.dbname,
          user: parsed.user,
          teamEnabled,
          ...(teamName !== undefined ? { teamName } : {}),
        }
      : {
          type: 'postgres',
          state,
          teamEnabled,
          ...(teamName !== undefined ? { teamName } : {}),
        };
  }
  return {
    type: 'sqlite',
    state: 'local',
    dbFile: basename(dbLine),
    teamEnabled,
  };
}

/**
 * Probe the active Lattice for a populated `__lattice_team_identity`
 * row. Treats any error as "not enabled" rather than throwing — older
 * Lattices may not have the table at all.
 */
async function detectTeamEnabled(db: Lattice): Promise<boolean> {
  try {
    const row = await db.get('__lattice_team_identity', 'singleton');
    return row != null;
  } catch {
    return false;
  }
}

/** Replace the `db:` line in a YAML config while preserving comments + order. */
function rewriteDbLine(configPath: string, newValue: string): void {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  doc.set('db', newValue);
  writeFileSync(configPath, doc.toString(), 'utf8');
}

interface SavePostgres {
  type: 'postgres';
  label: string;
  host: string;
  port: number | string;
  dbname: string;
  user: string;
  password: string;
}

interface SaveSqlite {
  type: 'sqlite';
  path: string;
}

function parseSaveBody(body: Record<string, unknown>): SavePostgres | SaveSqlite | null {
  const type = body.type;
  if (type === 'sqlite') {
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '';
    if (!path) return null;
    return { type: 'sqlite', path };
  }
  if (type === 'postgres') {
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '';
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : '';
    const dbname = typeof body.dbname === 'string' && body.dbname.trim() ? body.dbname.trim() : '';
    const user = typeof body.user === 'string' ? body.user : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const port = typeof body.port === 'number' ? body.port : Number(body.port ?? 5432);
    if (!label || !host || !dbname || !user || Number.isNaN(port)) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(label)) return null;
    return { type: 'postgres', label, host, port, dbname, user, password };
  }
  return null;
}

/** Resolve `path` relative to the config file directory unless it's already absolute. */
function resolveRelativeToConfig(configPath: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(configPath, '..', candidate);
}

export async function dispatchDbConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DbConfigContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  if (pathname === '/api/dbconfig' && method === 'GET') {
    await tryHandler(res, async () => {
      const info = await describeCurrent(ctx.configPath, ctx.db);
      // The resolved membership is authoritative for the team-cloud
      // state — it reflects whether the operator's identity actually
      // resolves to a team member, not whether a token key-file happens
      // to be on disk. This is what stops an already-joined member from
      // rendering the "paste invite token to join" panel.
      info.state = applyTeamMembershipState(info, ctx.teamMembership) ?? info.state;
      sendJson(res, {
        ...info,
        isCreator: ctx.teamMembership?.isCreator ?? false,
        // Expose the resolved team identity so the SPA can drive member
        // admin / invite / leave directly off the active cloud DB,
        // without a local `__lattice_team_connections` row (which doesn't
        // exist when the team cloud itself is the active database).
        teamId: ctx.teamMembership?.teamId ?? null,
        myUserId: ctx.teamMembership?.myUserId ?? null,
      });
    });
    return true;
  }

  if (pathname === '/api/dbconfig/save' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (!parsed) {
        sendJson(res, { error: 'Invalid body — see /api/dbconfig docs' }, 400);
        return;
      }
      if (parsed.type === 'postgres') {
        const url = buildPostgresUrl({
          host: parsed.host,
          port: Number(parsed.port),
          dbname: parsed.dbname,
          user: parsed.user,
          password: parsed.password,
        });
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        sendJson(res, { ok: true, type: 'postgres', label: parsed.label });
        return;
      }
      // sqlite: write the path verbatim. Store relative form when the
      // candidate sits under the config-file's directory so the YAML
      // stays portable.
      const abs = resolveRelativeToConfig(ctx.configPath, parsed.path);
      const rel = relative(resolve(ctx.configPath, '..'), abs);
      // Always write a POSIX-separated relative path so the YAML is portable
      // and stable across platforms (path.relative yields backslashes on
      // Windows, which would otherwise leak into the committed config).
      const dbLine = rel.startsWith('..') ? abs : './' + rel.split(sep).join('/');
      rewriteDbLine(ctx.configPath, dbLine);
      sendJson(res, { ok: true, type: 'sqlite', path: dbLine });
    });
    return true;
  }

  if (pathname === '/api/dbconfig/connect' && method === 'POST') {
    await tryHandler(res, async () => {
      await ctx.swap();
      sendJson(res, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/dbconfig/test' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (!parsed) {
        sendJson(res, { error: 'Invalid body — see /api/dbconfig/test docs' }, 400);
        return;
      }
      let url: string;
      if (parsed.type === 'postgres') {
        url = buildPostgresUrl({
          host: parsed.host,
          port: Number(parsed.port),
          dbname: parsed.dbname,
          user: parsed.user,
          password: parsed.password,
        });
      } else {
        url = resolveRelativeToConfig(ctx.configPath, parsed.path);
      }
      try {
        const probe = new Lattice(url);
        await probe.init();
        probe.close();
        sendJson(res, { ok: true });
      } catch (e) {
        sendJson(res, { ok: false, error: (e as Error).message });
      }
    });
    return true;
  }

  if (pathname === '/api/dbconfig/labels' && method === 'GET') {
    await tryHandler(res, () => {
      sendJson(res, { labels: listDbCredentials() });
      return Promise.resolve();
    });
    return true;
  }

  // ── v1.13: state-machine endpoints (thin wrappers over the public API). ──

  if (pathname === '/api/dbconfig/probe' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      const result = await probeCloud(url);
      sendJson(res, result);
    });
    return true;
  }

  if (pathname === '/api/dbconfig/migrate-to-cloud' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      // Probe first — refuse if unreachable or target already has a team.
      const probe = await probeCloud(url);
      if (!probe.reachable) {
        sendJson(res, { ok: false, error: probe.error ?? 'Cloud DB unreachable' }, 502);
        return;
      }
      if (probe.teamEnabled) {
        sendJson(
          res,
          {
            ok: false,
            error: 'Target cloud DB already has a team — migration aborts to avoid mixing data',
          },
          409,
        );
        return;
      }
      // Open a target Lattice matching the source's schema, run the
      // copy, close, archive, rewrite YAML, swap.
      const encryptionKey = getOrCreateMasterKey();
      const target = await openTargetLatticeForMigration(ctx.configPath, url, encryptionKey);
      try {
        const result = await migrateLatticeData(ctx.db, target);
        target.close();
        const sourceDbPath = parseConfigFile(ctx.configPath).dbPath;
        const backupPath = archiveLocalSqlite(sourceDbPath);
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        await ctx.swap();
        sendJson(res, {
          ok: true,
          label: parsed.label,
          tablesCopied: result.tablesCopied,
          rowsCopied: result.rowsCopied,
          sourceBackupPath: backupPath,
        });
      } catch (e) {
        try {
          target.close();
        } catch {
          // best-effort
        }
        // Migration failed: do NOT touch YAML or rename the source.
        sendJson(res, { ok: false, error: (e as Error).message }, 500);
      }
    });
    return true;
  }

  if (pathname === '/api/dbconfig/connect-existing' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
      const inviteToken =
        typeof body.invite_token === 'string' && body.invite_token.trim()
          ? body.invite_token.trim()
          : undefined;
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      const identity = readIdentity();
      const client = new TeamsClient(ctx.db);
      try {
        const result = await client.connectToExistingCloud({
          label: parsed.label,
          cloudUrl: url,
          ...(inviteToken !== undefined ? { invite_token: inviteToken } : {}),
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.display_name ? { name: identity.display_name } : {}),
        });
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        await ctx.swap();
        sendJson(res, {
          ok: true,
          label: parsed.label,
          teamEnabled: result.probe.teamEnabled,
          ...(result.probe.teamName !== undefined ? { teamName: result.probe.teamName } : {}),
          ...(result.joinedAsMember !== undefined ? { joinedAsMember: result.joinedAsMember } : {}),
        });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        sendJson(res, { ok: false, error: (e as Error).message }, status);
      }
    });
    return true;
  }

  // POST /api/dbconfig/rename — set the friendly database name.
  //
  // Cloud: UPDATE __lattice_team_identity.team_name. The realtime
  // subscription notifies other members; their dropdowns refresh.
  // Local: write a top-level `name:` key into the active YAML. The
  // config parser already accepts it; future opens read it back.
  if (pathname === '/api/dbconfig/rename' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendJson(res, { error: 'name must be a non-empty string' }, 400);
        return;
      }
      if (name.length > 200) {
        sendJson(res, { error: 'name must be 200 characters or fewer' }, 400);
        return;
      }
      const info = await describeCurrent(ctx.configPath, ctx.db);
      if (info.type === 'postgres' && info.teamEnabled) {
        // Renaming a team cloud broadcasts to every member, so only the
        // team creator may do it. Members get a 403.
        if (ctx.teamMembership && !ctx.teamMembership.isCreator) {
          sendJson(res, { error: 'Only the team owner can rename this database' }, 403);
          return;
        }
        const updatedAt = new Date().toISOString();
        const existing = (await ctx.db.get('__lattice_team_identity', 'singleton')) as {
          id: string;
        } | null;
        if (!existing) {
          sendJson(res, { error: '__lattice_team_identity row missing — cannot rename' }, 500);
          return;
        }
        await ctx.db.update('__lattice_team_identity', 'singleton', {
          team_name: name,
          updated_at: updatedAt,
        });
        // Also update __lattice_team for the multi-team table — same
        // friendly name, mirrored so the cloud's per-team row is current.
        try {
          const teams = (await ctx.db.query('__lattice_team', { limit: 1 })) as {
            id: string;
          }[];
          if (teams[0]) {
            await ctx.db.update('__lattice_team', teams[0].id, {
              name,
              updated_at: updatedAt,
            });
          }
        } catch {
          // Older clouds may not have __lattice_team; tolerate.
        }
        sendJson(res, { ok: true, kind: 'cloud', name });
        return;
      }
      // Local YAML — write top-level name: key.
      const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'));
      doc.set('name', name);
      writeFileSync(ctx.configPath, doc.toString(), 'utf8');
      sendJson(res, { ok: true, kind: 'local', name });
    });
    return true;
  }

  if (pathname === '/api/dbconfig/upgrade-to-team' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const teamName =
        typeof body.team_name === 'string' && body.team_name.trim() ? body.team_name.trim() : '';
      if (!teamName) {
        sendJson(res, { error: 'team_name is required' }, 400);
        return;
      }
      const info = await describeCurrent(ctx.configPath, ctx.db);
      if (info.type !== 'postgres' || !info.label) {
        sendJson(
          res,
          {
            error:
              'upgrade-to-team requires the active project to be on a labeled cloud DB. Migrate to cloud first.',
          },
          400,
        );
        return;
      }
      if (info.teamEnabled) {
        sendJson(res, { error: 'Cloud DB is already a team DB' }, 409);
        return;
      }
      const cloudUrl = getDbCredential(info.label);
      if (!cloudUrl) {
        sendJson(res, { error: 'No saved credential for ' + info.label }, 500);
        return;
      }
      const identity = readIdentity();
      if (!identity.email || !identity.display_name) {
        sendJson(
          res,
          {
            error: 'Set your display name + email in User Config → Identity before creating a team',
          },
          400,
        );
        return;
      }
      const client = new TeamsClient(ctx.db);
      try {
        const reg = await client.upgradeToTeamCloud({
          label: info.label,
          cloudUrl,
          teamName,
          email: identity.email,
          displayName: identity.display_name,
        });
        await ctx.swap();
        sendJson(res, { ok: true, team: reg.team, user: reg.user });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        sendJson(res, { ok: false, error: (e as Error).message }, status);
      }
    });
    return true;
  }

  return false;
}

// Re-export for tests that want to construct URLs without going through HTTP.
export { buildPostgresUrl, parsePostgresUrl };
