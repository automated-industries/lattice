import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { sendJson, readJson } from './http.js';
import type { ActiveDb } from './active-db.js';
import type { GuiRequestContext } from './request-context.js';
import { openConfig, disposeActive } from './lifecycle.js';
import { parseConfigFile } from '../config/parser.js';
import { resolveOutputDirForConfig, friendlyConfigName, listConfigs } from './config-paths.js';
import { createDatabase, deleteDatabase, type DatabaseDeletion } from '../ops/databases.js';
import { workspaceErrorCode } from '../ops/workspace-errors.js';

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
  // @gui-only session-state: swaps which sibling database this server process has open.
  // Same reasoning as switching a workspace — a direct caller opens the config it wants.
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
  // Scaffolding the new database is the capability; opening it and making it the
  // one this process serves is session state a direct caller does not have.
  // @capability database.create
  if (method === 'POST' && pathname === '/api/databases/create') {
    const body = (await readJson<unknown>(req)) as { name?: unknown };
    if (typeof body.name !== 'string') {
      sendJson(res, { error: 'name must be a non-empty string' }, 400);
      return true;
    }
    let created;
    try {
      created = createDatabase({ configPath: active.configPath, name: body.name });
    } catch (e) {
      if (workspaceErrorCode(e)) {
        sendJson(res, { error: (e as Error).message }, 400);
        return true;
      }
      throw e; // an unusable name or a collision — reported by the shared handler
    }
    const next = await openConfig(
      created.path,
      resolveOutputDirForConfig(created.path),
      deps.autoRender,
    );
    await disposeActive(active);
    ctx.swapActive(next);
    sendJson(res, { ok: true, path: next.configPath });
    return true;
  }
  // Containment (only a database this workspace lists) and the rule that a
  // workspace keeps one are the capability's, so a script inherits both. What is
  // left here is the file handle: when the target is the database this process has
  // OPEN, it has to be released before the store can be unlinked, and this is the
  // only caller for which that is true.
  // @capability database.delete
  if (method === 'POST' && pathname === '/api/databases/delete') {
    const body = (await readJson<unknown>(req)) as { path?: unknown };
    if (typeof body.path !== 'string') {
      sendJson(res, { error: 'path must be a non-empty string' }, 400);
      return true;
    }
    const target = resolve(body.path);
    let switchedTo: string | null = null;
    let deleted: DatabaseDeletion;
    try {
      deleted = await deleteDatabase({
        configPath: active.configPath,
        target,
        releaseTarget: async (remaining) => {
          if (resolve(active.configPath) !== target) return;
          // Switching away releases the store's file handle AND keeps this server
          // with a live database. Throwing here aborts the delete untouched.
          const fallback = remaining[0];
          let next: ActiveDb;
          try {
            next = await openConfig(fallback, resolveOutputDirForConfig(fallback), deps.autoRender);
          } catch (e) {
            const err = e as Error & { code?: string };
            const codePrefix = err.code ? `[${err.code}] ` : '';
            throw new Error(
              `Cannot delete: failed to switch to ${fallback} first: ${codePrefix}${err.message}`,
              { cause: e },
            );
          }
          await disposeActive(active);
          ctx.swapActive(next); // render kicks off-path
          switchedTo = next.configPath;
        },
      });
    } catch (e) {
      // A refusal this layer chose is the caller's mistake; anything else — a
      // failed switch, a failed unlink — is a fault and reads as one.
      sendJson(res, { error: (e as Error).message }, workspaceErrorCode(e) ? 400 : 500);
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
