import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { Lattice } from '../lattice.js';
import { getDbCredential, saveDbCredential, listDbCredentials } from '../framework/user-config.js';

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

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve_, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve_(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${(e as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

async function tryHandler(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 500);
  }
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

interface DbInfo {
  type: 'sqlite' | 'postgres';
  label?: string;
  dbFile?: string;
  host?: string;
  port?: number;
  dbname?: string;
  user?: string;
  teamEnabled: boolean;
}

/** Inspect the YAML's `db:` line + the active Lattice for the team-status flag. */
async function describeCurrent(configPath: string, db: Lattice): Promise<DbInfo> {
  const rawYaml = readFileSync(configPath, 'utf8');
  const doc = parseDocument(rawYaml);
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const teamEnabled = await detectTeamEnabled(db);
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);
  if (labelMatch) {
    const label = labelMatch[1] ?? '';
    const url = getDbCredential(label);
    if (url) {
      const parsed = parsePostgresUrl(url);
      if (parsed) {
        return {
          type: 'postgres',
          label,
          host: parsed.host,
          port: parsed.port,
          dbname: parsed.dbname,
          user: parsed.user,
          teamEnabled,
        };
      }
    }
    return { type: 'postgres', label, teamEnabled };
  }
  if (/^postgres(ql)?:\/\//i.test(dbLine)) {
    const parsed = parsePostgresUrl(dbLine);
    return parsed
      ? {
          type: 'postgres',
          host: parsed.host,
          port: parsed.port,
          dbname: parsed.dbname,
          user: parsed.user,
          teamEnabled,
        }
      : { type: 'postgres', teamEnabled };
  }
  return { type: 'sqlite', dbFile: basename(dbLine), teamEnabled };
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
      sendJson(res, info);
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
      const dbLine = rel.startsWith('..') ? abs : './' + rel;
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

  return false;
}

// Re-export for tests that want to construct URLs without going through HTTP.
export { buildPostgresUrl, parsePostgresUrl };
