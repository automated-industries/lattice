import {
  type DbConfigContext,
  buildPostgresUrl,
  parsePostgresUrl,
  parseSaveBody,
  rewriteDbLine,
  resolveRelativeToConfig,
} from './shared.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { Lattice } from '../../lattice.js';
import { sendJson, readJson, tryHandler } from '../http.js';
import { getDbCredential, saveDbCredential, listDbCredentials } from '../../framework/user-config.js';
import { cloudRlsInstalled, canManageRoles } from '../../framework/cloud-connect.js';
import { getCloudSetting, CLOUD_SETTING_WORKSPACE_LOGO_ETAG } from '../../cloud/settings.js';
import { findLatticeRoot } from '../../framework/lattice-root.js';
import { renameWorkspaceByConfigPath } from '../../framework/workspace.js';

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

export async function dispatchConnection(
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
      // `logoEtag` (null on local/unset) lets the SPA swap the topbar mark for the
      // owner's logo without a second fetch — and the etag cache-busts the blob.
      const logoEtag = await getCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO_ETAG);
      sendJson(res, {
        ...info,
        isOwner: info.state === 'cloud-owner',
        logoEtag,
        convergeWarnings: ctx.convergeWarnings,
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
