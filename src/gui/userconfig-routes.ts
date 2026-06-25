import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import {
  analyticsEnabled,
  getOrCreateAnalyticsId,
  listDbCredentials,
  readIdentity,
  readPreferences,
  writeIdentity,
  writePreferences,
  type UserIdentity,
  type UserPreferences,
} from '../framework/user-config.js';
import { parseConfigFile } from '../config/parser.js';
import { sendJson, readJson, tryHandler } from './http.js';
import { localFileOpenEnabled } from './files-routes.js';

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

async function upsertIdentityRow(db: Lattice, identity: UserIdentity): Promise<void> {
  const existing = (await db.get('__lattice_user_identity', 'singleton')) as {
    id: string;
    display_name: string;
    email: string;
  } | null;
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
function listProjectConfigs(
  activeConfigPath: string,
): { path: string; name: string; dbFile: string }[] {
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
    await tryHandler(res, () => {
      // Include a stable, anonymized analytics client id (no PII) so the GUI can
      // pin GA's client_id to ONE value per machine — otherwise the webview
      // counts every reload/relaunch as a new user.
      sendJson(res, { ...readIdentity(), analyticsClientId: getOrCreateAnalyticsId() });
      return Promise.resolve();
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

  if (pathname === '/api/userconfig/preferences' && method === 'GET') {
    await tryHandler(res, () => {
      // analytics_effective folds the env opt-outs (DO_NOT_TRACK / SCARF_ANALYTICS)
      // onto the stored pref, so the GUI gates browser analytics on the SAME
      // resolved consent the server already uses for install pings.
      // local_open: whether the GUI may "Open in Finder" (so it can hide the
      // affordance when LATTICE_LOCAL_OPEN=0 instead of offering a dead button).
      sendJson(res, {
        ...readPreferences(),
        analytics_effective: analyticsEnabled(),
        local_open: localFileOpenEnabled(),
      });
      return Promise.resolve();
    });
    return true;
  }

  if (pathname === '/api/userconfig/preferences' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      // Partial update: keep current values for any key the body omits.
      const current = readPreferences();
      const next: UserPreferences = {
        // Preserve keys this endpoint doesn't manage (voice_provider,
        // aggressiveness — set via the assistant config routes).
        ...current,
        show_system_tables:
          typeof body.show_system_tables === 'boolean'
            ? body.show_system_tables
            : current.show_system_tables,
        analytics: typeof body.analytics === 'boolean' ? body.analytics : current.analytics,
      };
      writePreferences(next);
      sendJson(res, next);
    });
    return true;
  }

  if (pathname === '/api/userconfig/databases' && method === 'GET') {
    await tryHandler(res, () => {
      const projects = listProjectConfigs(ctx.configPath);
      const cloudLabels = listDbCredentials();
      sendJson(res, {
        local: projects.map((p) => ({
          label: p.name,
          type: 'sqlite' as const,
          configPath: p.path,
          dbFile: p.dbFile,
          active: p.path === ctx.configPath,
          // v1.13: state is 'local' for sibling SQLite configs. Cloud
          // labels could have any state, so they're reported separately
          // as 'unknown' below — probing every cloud entry on catalog
          // load is too expensive for v1.
          state: 'local' as const,
        })),
        cloud: cloudLabels.map((label) => ({
          label,
          type: 'postgres' as const,
          state: 'unknown' as const,
        })),
      });
      return Promise.resolve();
    });
    return true;
  }

  return false;
}
