import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { Lattice } from '../lattice.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { sendJson, readJson, tryHandler } from './http.js';
import {
  getDbCredential,
  saveDbCredential,
  listDbCredentials,
  getOrCreateMasterKey,
} from '../framework/user-config.js';
import { probeCloud, cloudRlsInstalled } from '../framework/cloud-connect.js';
import { installCloudRls, enableRlsForTable, backfillOwnership } from '../cloud/rls.js';
import {
  provisionMemberRole,
  generateMemberPassword,
  memberRoleName,
  setRowVisibility,
} from '../cloud/members.js';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../framework/cloud-migration.js';
import { parseConfigFile } from '../config/parser.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import {
  registerOrUpdateCloudWorkspace,
  renameWorkspaceByConfigPath,
} from '../framework/workspace.js';
import { resolveContextDirForConfig } from '../framework/gui-bootstrap.js';

/**
 * After the active config's `db:` line is rewritten to point at a cloud
 * credential, flip its workspace registry record to cloud in place (same id) so
 * the header switcher + Settings reflect that this workspace is now cloud. No-op
 * when not running inside a `.lattice` root.
 */
function updateActiveWorkspaceToCloud(configPath: string, label: string): void {
  const root = findLatticeRoot(dirname(configPath));
  if (!root) return;
  registerOrUpdateCloudWorkspace(root, {
    configPath,
    contextDir: resolveContextDirForConfig(configPath),
    displayName: label,
    db: '${LATTICE_DB:' + label + '}',
    makeActive: true,
  });
}

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

// 1.16.3: the 'cloud-connected' state was removed when the "team" concept was
// deprecated — every cloud Postgres DB is a cloud workspace with members
// (auto-initialized), so there is no plain "connected but not a team" state.
// The 'team-cloud-*' keys are retained as internal plumbing names; the GUI
// renders them with neutral "cloud workspace" wording (no "team").
// A connected cloud Postgres workspace is, by definition, one you created (owner)
// or were invited into (member) — you cannot reach a team cloud without an
// invitation — so there is no "needs invite" settings state. Joining via an
// v3 cloud states. A "cloud" is a shared Postgres DB with Lattice RLS installed.
// You are the OWNER if your role can create other roles (CREATEROLE → you can
// invite members and you own the migrated rows); otherwise you're a scoped
// MEMBER. SQLite is always a private local store.
export type DbConfigState = 'local' | 'cloud-owner' | 'cloud-member';

interface DbInfo {
  type: 'sqlite' | 'postgres';
  state: DbConfigState;
  label?: string;
  dbFile?: string;
  host?: string;
  port?: number;
  dbname?: string;
  user?: string;
  /** True iff the active DB is an established cloud (Postgres with RLS installed). */
  isCloud: boolean;
}

/**
 * Whether the connected role may create other roles — the capability that
 * separates a cloud OWNER (can invite members, ran the migration, owns rows)
 * from a scoped MEMBER. Read from `pg_roles.rolcreaterole` for the live role.
 * Any error (or SQLite) → false.
 */
async function canManageRoles(db: Lattice): Promise<boolean> {
  if (db.getDialect() !== 'postgres') return false;
  try {
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    )) as { rolcreaterole?: boolean } | undefined;
    return !!row?.rolcreaterole;
  } catch {
    return false;
  }
}

/** Derive the cloud state from the live DB: local (sqlite) vs owner/member. */
async function computeState(db: Lattice): Promise<DbConfigState> {
  if (db.getDialect() !== 'postgres') return 'local';
  return (await canManageRoles(db)) ? 'cloud-owner' : 'cloud-member';
}

/** Inspect the YAML's `db:` line + the active Lattice to describe the active DB. */
async function describeCurrent(configPath: string, db: Lattice): Promise<DbInfo> {
  const rawYaml = readFileSync(configPath, 'utf8');
  const doc = parseDocument(rawYaml);
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);

  if (db.getDialect() === 'postgres') {
    const isCloud = await cloudRlsInstalled(db);
    const state = await computeState(db);
    const fields = (() => {
      if (labelMatch) {
        const label = labelMatch[1] ?? '';
        const url = getDbCredential(label);
        const parsed = url ? parsePostgresUrl(url) : null;
        return { label, parsed };
      }
      if (/^postgres(ql)?:\/\//i.test(dbLine)) {
        return { label: undefined, parsed: parsePostgresUrl(dbLine) };
      }
      return { label: undefined, parsed: null };
    })();
    return {
      type: 'postgres',
      state,
      isCloud,
      ...(fields.label !== undefined ? { label: fields.label } : {}),
      ...(fields.parsed
        ? {
            host: fields.parsed.host,
            port: fields.parsed.port,
            dbname: fields.parsed.dbname,
            user: fields.parsed.user,
          }
        : {}),
    };
  }
  return {
    type: 'sqlite',
    state: 'local',
    dbFile: basename(dbLine),
    isCloud: false,
  };
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
      // `isOwner` drives the SPA's owner-only affordances (invite a member,
      // rename). It's derived live from the connected role's CREATEROLE
      // capability — there is no team-identity row to consult.
      sendJson(res, { ...info, isOwner: info.state === 'cloud-owner' });
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
      // Probe first — refuse if unreachable or the target is already a
      // secured cloud (migrating into it would mix two owners' data).
      const probe = await probeCloud(url);
      if (!probe.reachable) {
        sendJson(res, { ok: false, error: probe.error ?? 'Cloud DB unreachable' }, 502);
        return;
      }
      if (probe.isCloud) {
        sendJson(
          res,
          {
            ok: false,
            error:
              'Target is already a Lattice cloud — migration aborts to avoid mixing data. Join it instead.',
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
        // Owner-side RLS setup: the migrator's connection owns the cloud, so it
        // installs RLS and stamps itself as owner of every just-migrated row.
        // Each member later sees only its own rows (private by default) until the
        // owner shares them; chat / secrets / history are isolated the same way.
        await installCloudRls(target);
        for (const t of target.getRegisteredTableNames()) {
          if (t.startsWith('__lattice_')) continue; // RLS bookkeeping is definer-managed
          const pk = target.getPrimaryKey(t);
          if (pk.length === 0) continue; // unkeyable table — no per-row RLS
          // Backfill ownership BEFORE forcing RLS: once FORCE ROW LEVEL SECURITY
          // is on, a non-superuser owner's own SELECT is filtered to rows it
          // already owns (none yet), so it could stamp nothing.
          await backfillOwnership(target, t, pk);
          await enableRlsForTable(target, t, pk);
        }
        target.close();
        const sourceDbPath = parseConfigFile(ctx.configPath).dbPath;
        const backupPath = archiveLocalSqlite(sourceDbPath);
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        updateActiveWorkspaceToCloud(ctx.configPath, parsed.label);
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
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      try {
        // Join = connect DIRECTLY with the scoped credentials the owner issued
        // (the "invite" is those credentials). The probe authenticates the role
        // and confirms the target is actually a Lattice cloud (RLS installed) —
        // there's nothing to provision here, the owner already created the role
        // and RLS confines it. openConfig opens it `introspectOnly` because the
        // member role can't (and needn't) run DDL.
        const probe = await probeCloud(url);
        if (!probe.reachable) {
          sendJson(res, { ok: false, error: probe.error ?? 'Cloud DB unreachable' }, 502);
          return;
        }
        if (!probe.isCloud) {
          sendJson(
            res,
            {
              ok: false,
              error:
                'That Postgres database is not a Lattice cloud yet. The owner must migrate a local Lattice into it first.',
            },
            409,
          );
          return;
        }
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        updateActiveWorkspaceToCloud(ctx.configPath, parsed.label);
        await ctx.swap();
        sendJson(res, { ok: true, label: parsed.label, isCloud: true });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        sendJson(res, { ok: false, error: (e as Error).message }, status);
      }
    });
    return true;
  }

  // POST /api/cloud/invite — owner provisions a scoped member role and returns
  // the connection details the new member pastes into "Join a cloud". The invite
  // IS those credentials (there is no server, no token redemption). Requires the
  // connected role to hold CREATEROLE (a cloud owner); members get a 403.
  if (pathname === '/api/cloud/invite' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can invite members' }, 403);
        return;
      }
      const body = await readJson(req);
      const label =
        typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'member';
      const role = memberRoleName(label);
      const password = generateMemberPassword();
      await provisionMemberRole(ctx.db, role, password);
      // Surface the connection coordinates of the active cloud so the owner can
      // hand the member a complete invite. Read from the saved credential of the
      // active label when present, else from the raw `db:` URL.
      const coords = activeCloudCoords(ctx.configPath);
      sendJson(res, {
        ok: true,
        invite: {
          host: coords?.host ?? null,
          port: coords?.port ?? null,
          dbname: coords?.dbname ?? null,
          user: role,
          password,
        },
      });
    });
    return true;
  }

  // POST /api/cloud/share — set a row's visibility (private | everyone) via the
  // owner-only RLS function. Only the row's owner may change its sharing; the
  // database raises for anyone else, which surfaces as a 403-ish error here.
  if (pathname === '/api/cloud/share' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const table = typeof body.table === 'string' ? body.table : '';
      const pk = typeof body.pk === 'string' ? body.pk : '';
      const visibility = typeof body.visibility === 'string' ? body.visibility : '';
      if (!table || !pk || !visibility) {
        sendJson(res, { error: 'table, pk and visibility are required' }, 400);
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Sharing requires a cloud (Postgres) database' }, 400);
        return;
      }
      await setRowVisibility(ctx.db, table, pk, visibility);
      sendJson(res, { ok: true, table, pk, visibility });
    });
    return true;
  }

  // POST /api/dbconfig/rename — set the friendly database name.
  //
  // The cloud has no shared name in v3 (no team-identity row); the name is the
  // operator's own workspace label. So rename always writes the local YAML
  // `name:` key + the workspace registry, for both local and cloud configs.
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
      // The cloud carries no shared name (no team-identity row); a workspace name
      // is the operator's own label. Write the local YAML `name:` key + mirror it
      // into the workspace registry (the header switcher's source) for every DB.
      const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'));
      doc.set('name', name);
      writeFileSync(ctx.configPath, doc.toString(), 'utf8');
      const root = findLatticeRoot(dirname(ctx.configPath));
      if (root) renameWorkspaceByConfigPath(root, ctx.configPath, name);
      const info = await describeCurrent(ctx.configPath, ctx.db);
      sendJson(res, { ok: true, kind: info.isCloud ? 'cloud' : 'local', name });
    });
    return true;
  }

  return false;
}

/** Host/port/dbname of the active cloud connection, read from the saved
 *  credential (label form) or the raw `db:` URL. null when the active DB isn't a
 *  Postgres URL. */
function activeCloudCoords(
  configPath: string,
): { host: string; port: number; dbname: string } | null {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);
  const url = labelMatch ? getDbCredential(labelMatch[1] ?? '') : dbLine;
  if (!url) return null;
  const parsed = parsePostgresUrl(url);
  return parsed ? { host: parsed.host, port: parsed.port, dbname: parsed.dbname } : null;
}

// Re-export for tests that want to construct URLs without going through HTTP.
export { buildPostgresUrl, parsePostgresUrl };
