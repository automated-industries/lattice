import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { sendJson, readJson } from './http.js';
import type { ActiveDb } from './active-db.js';
import type { GuiRequestContext } from './request-context.js';
import { openConfig, disposeActive } from './lifecycle.js';
import { parseConfigFile } from '../config/parser.js';
import {
  resolveOutputDirForConfig,
  friendlyConfigName,
  listConfigs,
  createBlankConfig,
  deleteDatabaseFiles,
} from './config-paths.js';

/**
 * Database (sibling-config) routes — list / switch / create / delete — extracted
 * from server.ts. A flat leaf mirroring the other route modules. Switching a
 * database swaps to a sibling YAML config WITHIN the same workspace, so these are
 * ctx.swapActive(next) WITHOUT a workspace id (the header label is the workspace,
 * which doesn't change). No virgin transition: deleting the only database errors
 * rather than going virgin. `active` is read once (the routes use it pre-swap for
 * dispose + config listing); each route reads the post-swap path off `next`.
 */
export interface DatabasesRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. */
  host: string;
  /** Workspace (autoRender) mode — passed to openConfig on switch/create/delete. */
  autoRender: boolean;
}

export async function handleDatabasesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: DatabasesRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const active = ctx.active();

  if (method === 'GET' && pathname === '/api/databases') {
    const parsedActive = parseConfigFile(active.configPath);
    // Friendly name comes from the YAML's optional `name:` key, falling
    // back to the config basename.
    const friendlyLabel = friendlyConfigName(parsedActive.name, active.configPath);
    const kind: 'local' | 'cloud' = active.realtime ? 'cloud' : 'local';
    sendJson(res, {
      current: {
        path: active.configPath,
        dbFile: basename(parsedActive.dbPath),
        label: friendlyLabel,
        kind,
      },
      configs: listConfigs(active.configPath),
    });
    return true;
  }
  if (method === 'POST' && pathname === '/api/databases/switch') {
    const body = (await readJson<unknown>(req)) as { path?: unknown };
    if (typeof body.path !== 'string') {
      sendJson(res, { error: 'path must be a string' }, 400);
      return true;
    }
    const newPath = resolve(body.path);
    if (!existsSync(newPath)) {
      sendJson(res, { error: `Config not found: ${newPath}` }, 400);
      return true;
    }
    // Try to open the new config first; only swap once it succeeds so a
    // bad config doesn't leave the server with no active DB. Common
    // failure mode: switching back to a cloud DB whose saved credential
    // was rotated or whose Postgres is now unreachable. Surface the
    // raw error verbatim so the UI's toast names the real cause.
    let next: ActiveDb;
    try {
      // Resolve the rendered-context root for THIS config (probing its
      // own directory), not the launch-wide outputDir. Reusing one
      // outputDir across every DB switch is what bled one DB's rendered
      // "files" view into another DB that had none of its own.
      next = await openConfig(newPath, resolveOutputDirForConfig(newPath), deps.autoRender);
    } catch (e) {
      const err = e as Error & { code?: string };
      console.error(`[dbconfig.switch] openConfig(${newPath}) failed:`, err);
      const codePrefix = err.code ? `[${err.code}] ` : '';
      sendJson(res, { error: `Failed to switch to ${newPath}: ${codePrefix}${err.message}` }, 500);
      return true;
    }
    await disposeActive(active);
    ctx.swapActive(next); // render kicks off-path; same workspace, so no id change
    sendJson(res, { ok: true, path: next.configPath });
    return true;
  }
  if (method === 'POST' && pathname === '/api/databases/create') {
    const body = (await readJson<unknown>(req)) as { name?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      sendJson(res, { error: 'name must be a non-empty string' }, 400);
      return true;
    }
    const newConfigPath = createBlankConfig(active.configPath, body.name.trim());
    const next = await openConfig(
      newConfigPath,
      resolveOutputDirForConfig(newConfigPath),
      deps.autoRender,
    );
    await disposeActive(active);
    ctx.swapActive(next);
    sendJson(res, { ok: true, path: next.configPath });
    return true;
  }
  if (method === 'POST' && pathname === '/api/databases/delete') {
    const body = (await readJson<unknown>(req)) as { path?: unknown };
    if (typeof body.path !== 'string' || !body.path.trim()) {
      sendJson(res, { error: 'path must be a non-empty string' }, 400);
      return true;
    }
    const target = resolve(body.path);
    // Only delete a config we actually list (same directory as the
    // active config). This stops the endpoint from being coaxed into
    // unlinking arbitrary files outside the database set.
    const known = listConfigs(active.configPath);
    const match = known.find((c) => resolve(c.path) === target);
    if (!match) {
      sendJson(res, { error: `Not a known database config: ${target}` }, 400);
      return true;
    }
    // When deleting the active database we must switch away first so the
    // SQLite file handle is released (and the server keeps an active DB).
    let switchedTo: string | null = null;
    if (resolve(active.configPath) === target) {
      const fallback = known.find((c) => resolve(c.path) !== target);
      if (!fallback) {
        sendJson(
          res,
          {
            error:
              'Cannot delete the only database. Create or add another database first, then delete this one.',
          },
          400,
        );
        return true;
      }
      let next: ActiveDb;
      try {
        next = await openConfig(
          fallback.path,
          resolveOutputDirForConfig(fallback.path),
          deps.autoRender,
        );
      } catch (e) {
        const err = e as Error & { code?: string };
        const codePrefix = err.code ? `[${err.code}] ` : '';
        sendJson(
          res,
          {
            error: `Cannot delete: failed to switch to ${fallback.path} first: ${codePrefix}${err.message}`,
          },
          500,
        );
        return true;
      }
      await disposeActive(active);
      ctx.swapActive(next); // render kicks off-path
      switchedTo = next.configPath;
    }
    // Surface any filesystem failure loudly rather than
    // half-deleting silently.
    let deleted: { deletedConfig: string; deletedDbFile: string | null };
    try {
      deleted = deleteDatabaseFiles(target);
    } catch (e) {
      sendJson(res, { error: `Failed to delete database files: ${(e as Error).message}` }, 500);
      return true;
    }
    sendJson(res, {
      ok: true,
      deletedConfig: deleted.deletedConfig,
      deletedDbFile: deleted.deletedDbFile,
      switchedTo,
    });
    return true;
  }

  return false;
}
