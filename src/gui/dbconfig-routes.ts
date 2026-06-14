import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { Lattice } from '../lattice.js';
import { sendJson, readJson, tryHandler } from './http.js';
import {
  getDbCredential,
  saveDbCredential,
  listDbCredentials,
  getOrCreateMasterKey,
  getS3ConfigRaw,
  saveS3ConfigRaw,
} from '../framework/user-config.js';
import { activeWorkspaceLabel, mergeS3ConfigForSave } from '../framework/s3-config.js';
import { probeCloud, cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { secureCloud } from '../cloud/setup.js';
import {
  installCloudSettings,
  getCloudSettingStrict,
  setCloudSetting,
  CLOUD_SETTING_SYSTEM_PROMPT,
} from '../cloud/settings.js';

/** Generous upper bound on the stored chat system prompt — well past any real
 *  house-style/domain preamble, but it stops an accidental multi-MB paste from
 *  bloating every member's turn (and the model context). Owner-only input. */
const MAX_SYSTEM_PROMPT_CHARS = 100_000;
import {
  provisionMemberRole,
  generateMemberPassword,
  memberRoleName,
  setRowVisibility,
  grantCell,
  revokeCell,
  assertScopedMemberRole,
  revokeMemberRole,
} from '../cloud/members.js';
import { mintInviteToken, redeemInviteToken, poolerAwareUser } from '../cloud/invite.js';
import { slugify } from '../render/markdown.js';
import { MEMBER_GROUP } from '../cloud/rls.js';
import { getAsyncOrSync, runAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../framework/cloud-migration.js';
import { parseConfigFile } from '../config/parser.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import { getActiveWorkspace } from '../framework/workspace.js';
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
function updateActiveWorkspaceToCloud(configPath: string, displayName: string, key: string): void {
  const root = findLatticeRoot(dirname(configPath));
  if (!root) return;
  registerOrUpdateCloudWorkspace(root, {
    configPath,
    contextDir: resolveContextDirForConfig(configPath),
    displayName,
    // The credential key + ${LATTICE_DB:…} reference must be a SANITIZED,
    // space-free label (resolveDbPath rejects anything else); the human
    // displayName is separate.
    db: '${LATTICE_DB:' + key + '}',
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
  /**
   * Join a cloud as a NEW workspace: save the credential under `key`, scaffold a
   * new cloud workspace named `displayName` pointing at `${LATTICE_DB:key}`, then
   * open + activate it. Atomic (rolls back on failure). Returns the new workspace
   * id. Used by the member join/redeem path so it never repoints (hijacks) the
   * currently-open workspace.
   */
  createCloudWorkspace: (displayName: string, key: string, url: string) => Promise<string>;
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

/**
 * Join an existing Lattice cloud as a scoped member: probe the connection, then
 * persist the encrypted credential, point the workspace at it, and swap the
 * active DB. Shared by the manual `connect-existing` flow and the email-bound
 * `redeem-invite` flow so both take the IDENTICAL path (probe → save → swap) —
 * the member connects directly as their scoped role under RLS, exactly as today.
 */
async function joinCloudAsMember(
  ctx: DbConfigContext,
  res: ServerResponse,
  fields: { host: string; port: number; dbname: string; user: string; password: string },
  label: string,
): Promise<void> {
  const url = buildPostgresUrl(fields);
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
  // Create a NEW workspace for the cloud and switch to it — never repoint
  // (hijack) the currently-open workspace, which previously overwrote the user's
  // existing local workspace (wrong name, orphaned data, no switcher entry).
  // The credential key + ${LATTICE_DB:…} reference MUST be a sanitized,
  // space-free label or resolveDbPath rejects it (the default "Cloud workspace"
  // — with a space — never resolved, silently dropping the member on an empty
  // local DB). Sanitize the key; keep the human label as the display name.
  const key = slugify(label) || 'cloud';
  try {
    const workspaceId = await ctx.createCloudWorkspace(label, key, url);
    sendJson(res, { ok: true, label, isCloud: true, workspaceId });
  } catch (e) {
    sendJson(res, { ok: false, error: (e as Error).message }, 500);
  }
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
        // Owner-side cloud setup: the migrator's connection owns the cloud, so it
        // installs RLS + the observation substrate and stamps itself as owner of
        // every just-migrated row. Each member later sees only its own rows
        // (private by default) until the owner shares them; chat / secrets /
        // history are isolated the same way; per-viewer enrichment observations
        // are gated by source visibility.
        await secureCloud(target);
        target.close();
        const sourceDbPath = parseConfigFile(ctx.configPath).dbPath;
        const backupPath = archiveLocalSqlite(sourceDbPath);
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        // parsed.label already satisfies the ${LATTICE_DB:…} charset (it was
        // parsed from one), so it's a valid key + a fine display name.
        updateActiveWorkspaceToCloud(ctx.configPath, parsed.label, parsed.label);
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
      try {
        // Join = connect DIRECTLY with the scoped credentials the owner issued
        // (the "invite" is those credentials). joinCloudAsMember probes, saves,
        // and swaps; the member role can't (and needn't) run DDL.
        await joinCloudAsMember(
          ctx,
          res,
          {
            host: parsed.host,
            port: Number(parsed.port),
            dbname: parsed.dbname,
            user: parsed.user,
            password: parsed.password,
          },
          parsed.label,
        );
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        sendJson(res, { ok: false, error: (e as Error).message }, status);
      }
    });
    return true;
  }

  // GET /api/cloud/members — list the cloud's members (the owner + every role in
  // the member group). Owner-only enumeration; off a secured cloud returns []
  // (the panel then just shows the local single-user state).
  if (pathname === '/api/cloud/members' && method === 'GET') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { members: [] });
        return;
      }
      const me = (await getAsyncOrSync(ctx.db.adapter, `SELECT session_user AS u`)) as
        | { u?: string }
        | undefined;
      const ownerRole = me?.u ?? '';
      // The operator's own identity (mirrored into __lattice_user_identity on open)
      // — so the owner row shows a real name/email, not the bare Postgres role.
      const idRow = (await getAsyncOrSync(
        ctx.db.adapter,
        `SELECT display_name, email FROM "__lattice_user_identity" WHERE id = 'singleton'`,
      ).catch(() => undefined)) as { display_name?: string; email?: string } | undefined;
      const ownerName = (idRow?.display_name && idRow.display_name.trim()) || ownerRole;
      const ownerEmail = idRow?.email ?? '';

      // Only an owner can enumerate roles; a scoped member just sees itself.
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, {
          members: ownerRole
            ? [{ role: ownerRole, name: ownerName, email: ownerEmail, status: 'member', isYou: true }]
            : [],
        });
        return;
      }
      // Member-group roles — EXCLUDING the owner (it was double-counted: prepended
      // AND listed again from the group).
      const rows = (await allAsyncOrSync(
        ctx.db.adapter,
        `SELECT m.rolname AS role
           FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = ?
           JOIN pg_roles m ON m.oid = am.member
          WHERE m.rolname <> ?
          ORDER BY m.rolname`,
        [MEMBER_GROUP, ownerRole],
      )) as { role: string }[];
      // role → its latest non-revoked invite email, for human-readable display.
      const invites = (await allAsyncOrSync(
        ctx.db.adapter,
        `SELECT DISTINCT ON ("role") "role", "email"
           FROM "__lattice_member_invites"
          WHERE "revoked_at" IS NULL
          ORDER BY "role", "created_at" DESC`,
      ).catch(() => [])) as { role: string; email?: string }[];
      const emailByRole = new Map(invites.map((r) => [r.role, r.email ?? '']));
      const members = [
        { role: ownerRole, name: ownerName, email: ownerEmail, status: 'owner', isYou: true },
        ...rows.map((r) => {
          const email = emailByRole.get(r.role) ?? '';
          const name = email ? (email.split('@')[0] ?? r.role) : r.role;
          return { role: r.role, name, email, status: 'member', isYou: false };
        }),
      ];
      sendJson(res, { members });
    });
    return true;
  }

  // POST /api/cloud/invite — owner provisions a scoped member role and returns a
  // single email-bound, encrypted token carrying that scoped credential (the
  // member redeems it with their email in "Join a cloud"). Requires the connected
  // role to hold CREATEROLE (a cloud owner); members get a 403. No plaintext
  // credential leaves in the response except inside the opaque token.
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
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        sendJson(res, { error: 'A valid invitee email is required' }, 400);
        return;
      }
      const coords = activeCloudCoords(ctx.configPath);
      if (!coords) {
        sendJson(res, { error: 'Could not resolve the cloud connection coordinates' }, 500);
        return;
      }
      // Provision a fresh scoped role, then HARD-ASSERT it is non-privileged
      // before embedding it in a token (security non-regression — never a
      // superuser / CREATEROLE / BYPASSRLS / owner role).
      const role = memberRoleName(email);
      const password = generateMemberPassword();
      await provisionMemberRole(ctx.db, role, password);
      await assertScopedMemberRole(ctx.db, role);
      // Bake the pooler-correct user from the owner's CONNECTION-STRING username
      // (postgres.<ref>), NOT session_user — on the Supabase pooler session_user
      // is the bare role with no tenant ref, which yields an unconnectable member
      // username (ENOIDENTIFIER). coords.user carries the ref.
      const user = poolerAwareUser(coords.host, role, coords.user);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      // Stamp the owner's cloud (workspace) name so the member's new workspace is
      // named after the cloud, not a generic default (1.3a).
      const inviteRoot = findLatticeRoot(dirname(ctx.configPath));
      const ownerWs = inviteRoot ? getActiveWorkspace(inviteRoot) : null;
      const token = mintInviteToken({
        coords,
        user,
        password,
        role,
        email,
        expiresAt,
        ...(ownerWs?.displayName ? { workspaceName: ownerWs.displayName } : {}),
      });
      // Owner-only audit row. Plaintext email + password are NEVER stored — only a
      // hash of the email and the role name (for later revocation).
      await runAsyncOrSync(
        ctx.db.adapter,
        `INSERT INTO "__lattice_member_invites" ("id","role","email_hash","email","expires_at")
           VALUES (?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          role,
          createHash('sha256').update(email.trim().toLowerCase()).digest('hex'),
          // Plaintext email stored ONLY in this owner-only table so the owner's
          // Members list can show who each member is (the hash above stays for
          // tamper-evident audit; the password is still never stored anywhere).
          email.trim().toLowerCase(),
          expiresAt.toISOString(),
        ],
      );
      sendJson(res, { ok: true, token, role, email });
    });
    return true;
  }

  // POST /api/cloud/remove-member — owner-only: revoke a member's scoped role
  // (the GUI "Kick" control). Wires the previously-unreachable revokeMemberRole.
  if (pathname === '/api/cloud/remove-member' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can remove members' }, 403);
        return;
      }
      const body = await readJson(req);
      const role = typeof body.role === 'string' ? body.role : '';
      if (!role) {
        sendJson(res, { error: 'A member role is required' }, 400);
        return;
      }
      const me = (await getAsyncOrSync(ctx.db.adapter, `SELECT session_user AS u`)) as
        | { u?: string }
        | undefined;
      if (role === (me?.u ?? '')) {
        sendJson(res, { error: 'You cannot remove yourself (the owner)' }, 400);
        return;
      }
      // revokeMemberRole reassigns/drops the member's objects then the role and
      // SURFACES failures (Rule 16) — e.g. Supabase "permission denied to drop
      // objects" — instead of swallowing them; tryHandler turns a throw into a
      // 500 the GUI shows. If it succeeds, mark the audit invites revoked.
      await revokeMemberRole(ctx.db, role);
      await runAsyncOrSync(
        ctx.db.adapter,
        `UPDATE "__lattice_member_invites" SET "revoked_at" = now() WHERE "role" = ? AND "revoked_at" IS NULL`,
        [role],
      ).catch((e: unknown) => {
        // Best-effort audit only — the role IS already revoked; log, don't fail.
        console.error('[cloud] mark invite revoked failed:', (e as Error).message);
      });
      sendJson(res, { ok: true, role });
    });
    return true;
  }

  // POST /api/cloud/redeem-invite — the MEMBER side. Decrypt the email-bound
  // token locally with the invitee's email, reconstruct the SAME scoped
  // credential the owner minted, and join via the shared connect path. The UI
  // only ever handles email + token — never a postgres:// string.
  if (pathname === '/api/cloud/redeem-invite' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!email || !token) {
        sendJson(
          res,
          { ok: false, error: 'Enter the email this invite was sent to and the invite token.' },
          400,
        );
        return;
      }
      let payload;
      try {
        payload = redeemInviteToken(email, token);
      } catch (e) {
        sendJson(res, { ok: false, error: (e as Error).message }, 400);
        return;
      }
      // Name the new workspace from the cloud name stamped into the invite
      // (1.3a), else a client-supplied label, else a sane default (which now
      // resolves because joinCloudAsMember sanitizes the key).
      const label =
        (payload.workspace_name && payload.workspace_name.trim()) ||
        (typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '') ||
        'Cloud workspace';
      await joinCloudAsMember(
        ctx,
        res,
        {
          host: payload.host,
          port: payload.port,
          dbname: payload.dbname,
          user: payload.user,
          password: payload.password,
        },
        label,
      );
    });
    return true;
  }

  // POST /api/cloud/secure — the existing-cloud cutover. Secure an
  // already-populated Postgres in place: install RLS + the observation substrate
  // and make the connecting role the owner of every existing row. Idempotent.
  // Owner-only (needs CREATEROLE + table ownership). Use this when you already
  // have data in a Postgres database and want to turn it INTO a Lattice cloud
  // without migrating from a local SQLite store first.
  if (pathname === '/api/cloud/secure' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Only a Postgres database can be secured as a cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(
          res,
          { error: 'Securing a cloud requires a connection that can create roles' },
          403,
        );
        return;
      }
      const alreadyCloud = await cloudRlsInstalled(ctx.db);
      await secureCloud(ctx.db);
      await ctx.swap();
      sendJson(res, { ok: true, alreadyCloud, secured: true });
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

  // POST /api/cloud/cell-share — per-card audience override. The row owner grants
  // (or revokes) one member access to one masked cell (table + pk + column),
  // without changing the column's schema-level audience. Owner-only.
  if (pathname === '/api/cloud/cell-share' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const table = typeof body.table === 'string' ? body.table : '';
      const pk = typeof body.pk === 'string' ? body.pk : '';
      const column = typeof body.column === 'string' ? body.column : '';
      const grantee = typeof body.grantee === 'string' ? body.grantee : '';
      const revoke = body.revoke === true;
      if (!table || !pk || !column || !grantee) {
        sendJson(res, { error: 'table, pk, column and grantee are required' }, 400);
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Per-cell sharing requires a cloud (Postgres) database' }, 400);
        return;
      }
      if (revoke) await revokeCell(ctx.db, table, pk, column, grantee);
      else await grantCell(ctx.db, table, pk, column, grantee);
      sendJson(res, { ok: true, table, pk, column, grantee, revoked: revoke });
    });
    return true;
  }

  // GET/POST /api/cloud/s3-config — enable S3 file storage for this cloud
  // workspace. When on, uploaded file bytes go to S3 so other members can pull
  // them (access still gated by the files-row RLS at the serve route). Config is
  // stored per-member + machine-local (encrypted), NOT in the shared DB. Setting
  // it is owner-only; the secret is redacted on read.
  if (pathname === '/api/cloud/s3-config' && method === 'GET') {
    // Reads this member's machine-local config only (no DB/network), so the
    // handler is synchronous; return a resolved promise for tryHandler's signature.
    await tryHandler(res, () => {
      const label = activeWorkspaceLabel(ctx.configPath);
      const raw = label ? getS3ConfigRaw(label) : null;
      sendJson(res, {
        enabled: raw?.enabled === true,
        bucket: typeof raw?.bucket === 'string' ? raw.bucket : null,
        region: typeof raw?.region === 'string' ? raw.region : null,
        prefix: typeof raw?.prefix === 'string' ? raw.prefix : null,
        endpoint: typeof raw?.endpoint === 'string' ? raw.endpoint : null,
        // Never return the secret; just whether one is stored.
        accessKeyId: typeof raw?.accessKeyId === 'string' ? raw.accessKeyId : null,
        hasSecret: typeof raw?.secretAccessKey === 'string' && raw.secretAccessKey.length > 0,
      });
      return Promise.resolve();
    });
    return true;
  }
  if (pathname === '/api/cloud/s3-config' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can configure S3 file storage' }, 403);
        return;
      }
      const label = activeWorkspaceLabel(ctx.configPath);
      if (!label) {
        sendJson(res, { error: 'The active workspace is not a labelled cloud connection' }, 400);
        return;
      }
      const body = await readJson(req);
      // Merge over the existing stored config so a PARTIAL update (toggling
      // `enabled`, changing `prefix`) doesn't silently drop the stored secret — the
      // GET handler redacts secretAccessKey, so a UI round-trip never carries it
      // back. (See mergeS3ConfigForSave.)
      const toSave = mergeS3ConfigForSave(getS3ConfigRaw(label) ?? {}, body);
      if (toSave.enabled && (!toSave.bucket || !toSave.region)) {
        sendJson(res, { error: 'bucket and region are required to enable S3' }, 400);
        return;
      }
      saveS3ConfigRaw(label, toSave);
      sendJson(res, { ok: true, enabled: toSave.enabled, bucket: toSave.bucket || null });
    });
    return true;
  }

  // GET/POST /api/cloud/system-prompt — the workspace chat system prompt the cloud
  // OWNER bundles into every member's chat. Owner-only to VIEW and to EDIT: the GET
  // returns the text ONLY to an owner (a member gets canEdit:false and NO text), so
  // the prompt never crosses the product API to a member. Secrecy is app-mediated
  // (see src/cloud/settings.ts) — it's hidden from the UI + API, not cryptographic.
  if (pathname === '/api/cloud/system-prompt' && method === 'GET') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        // Not a cloud — no shared/secret prompt concept. Report unsupported so the
        // UI hides the control rather than showing an empty editor.
        sendJson(res, { supported: false, canEdit: false });
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        // A member: never return the prompt text through the product API.
        sendJson(res, { supported: true, canEdit: false });
        return;
      }
      // Owner: ensure the store exists (covers clouds secured before this feature),
      // then return the current prompt for editing. Use the STRICT reader: a real
      // read failure must surface (tryHandler → 500, the modal shows a load error)
      // rather than swallow to '' — a deceptive empty editor would invite a blind
      // overwrite of the live prompt (fail loudly, never silently). '' means genuinely unset.
      await installCloudSettings(ctx.db);
      const prompt = await getCloudSettingStrict(ctx.db, CLOUD_SETTING_SYSTEM_PROMPT);
      sendJson(res, { supported: true, canEdit: true, prompt: prompt ?? '' });
    });
    return true;
  }
  if (pathname === '/api/cloud/system-prompt' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can edit the chat system prompt' }, 403);
        return;
      }
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
        sendJson(
          res,
          { error: `prompt is too long (max ${String(MAX_SYSTEM_PROMPT_CHARS)} characters)` },
          400,
        );
        return;
      }
      await installCloudSettings(ctx.db);
      // The setter is owner-guarded inside Postgres too (RAISEs for a non-owner) —
      // the API gate above is defense in depth + a clean error.
      await setCloudSetting(ctx.db, CLOUD_SETTING_SYSTEM_PROMPT, prompt);
      sendJson(res, { ok: true, length: prompt.length });
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
): { host: string; port: number; dbname: string; user: string } | null {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);
  const url = labelMatch ? getDbCredential(labelMatch[1] ?? '') : dbLine;
  if (!url) return null;
  const parsed = parsePostgresUrl(url);
  // Keep `user` too: on the Supabase pooler the tenant ref lives ONLY in the
  // connection-string username (`postgres.<ref>`), never in session_user (which
  // returns the bare role). poolerAwareUser needs it to mint a connectable
  // member username.
  return parsed
    ? { host: parsed.host, port: parsed.port, dbname: parsed.dbname, user: parsed.user }
    : null;
}

// Re-export for tests that want to construct URLs without going through HTTP.
export { buildPostgresUrl, parsePostgresUrl };
