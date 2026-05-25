import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import {
  listDbCredentials,
  readIdentity,
  writeIdentity,
  type UserIdentity,
} from '../framework/user-config.js';
import { parseConfigFile } from '../config/parser.js';

/**
 * GUI-side endpoints that read and write `~/.lattice/*` plus the active
 * Lattice's mirrored identity row. The SPA's "User Config" view hits
 * these — `Identity` panel (display_name + email) and `Databases`
 * panel (catalog of project YAMLs + saved Postgres URLs).
 *
 * Auth model is the same as the rest of `lattice gui`: localhost-only,
 * filesystem trust. team-cloud mode does not mount this dispatcher.
 */

interface UserConfigContext {
  db: Lattice;
  /** Active config file path — used to scan its directory for sibling project YAMLs. */
  configPath: string;
  pathname: string;
  method: string;
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

async function tryHandler(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 500);
  }
}

async function upsertIdentityRow(db: Lattice, identity: UserIdentity): Promise<void> {
  const existing = (await db.get('__lattice_user_identity', 'singleton')) as
    | { id: string; display_name: string; email: string }
    | null;
  const updated_at = new Date().toISOString();
  if (existing) {
    await db.update('__lattice_user_identity', 'singleton', {
      display_name: identity.display_name,
      email: identity.email,
      updated_at,
    });
  } else {
    await db.insert('__lattice_user_identity', {
      id: 'singleton',
      display_name: identity.display_name,
      email: identity.email,
      updated_at,
    });
  }
}

/** Walk sibling YAMLs of the active config; return one entry per parseable lattice config. */
function listProjectConfigs(activeConfigPath: string): { path: string; name: string; dbFile: string }[] {
  const dir = dirname(activeConfigPath);
  const out: { path: string; name: string; dbFile: string }[] = [];
  if (!existsSync(dir)) return out;
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
    const full = join(dir, fname);
    try {
      const parsed = parseConfigFile(full);
      out.push({
        path: full,
        name: fname.replace(/\.(ya?ml)$/, ''),
        dbFile: basename(parsed.dbPath),
      });
    } catch {
      // skip non-lattice yamls
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Dispatch `/api/userconfig/*`. Returns true when a route matches —
 * the caller falls through to the GUI's existing 404 handler otherwise.
 */
export async function dispatchUserConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UserConfigContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  if (pathname === '/api/userconfig/identity' && method === 'GET') {
    await tryHandler(res, async () => {
      sendJson(res, readIdentity());
    });
    return true;
  }

  if (pathname === '/api/userconfig/identity' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const display_name = typeof body.display_name === 'string' ? body.display_name : '';
      const email = typeof body.email === 'string' ? body.email : '';
      const next: UserIdentity = { display_name, email };
      writeIdentity(next);
      await upsertIdentityRow(ctx.db, next);
      sendJson(res, next);
    });
    return true;
  }

  if (pathname === '/api/userconfig/databases' && method === 'GET') {
    await tryHandler(res, async () => {
      const projects = listProjectConfigs(ctx.configPath);
      const cloudLabels = listDbCredentials();
      sendJson(res, {
        local: projects.map((p) => ({
          label: p.name,
          type: 'sqlite' as const,
          configPath: p.path,
          dbFile: p.dbFile,
          active: p.path === ctx.configPath,
        })),
        cloud: cloudLabels.map((label) => ({ label, type: 'postgres' as const })),
      });
    });
    return true;
  }

  return false;
}
