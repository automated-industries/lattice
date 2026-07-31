import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { sendJson, readJson } from './http.js';
import type { ActiveDb } from './active-db.js';
import type { GuiRequestContext } from './request-context.js';
import {
  openConfig,
  openWithinTimeout,
  disposeActive,
  reopenSameConfig,
  SWITCH_OPEN_TIMEOUT_MS,
} from './lifecycle.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  getWorkspace,
  addWorkspace,
  resolveWorkspacePaths,
} from '../framework/workspace.js';
import { deleteWorkspace } from '../ops/workspace-lifecycle.js';
import { workspaceErrorCode } from '../ops/workspace-errors.js';

/**
 * Deciding which of a workspace's files to remove is product logic, not
 * transport, and it now lives in the capability module beside the delete that
 * uses it. Re-exported here because it was reachable at this path before the
 * move and importers should not have to care where it went.
 */
export { cleanupWorkspaceFiles } from '../ops/workspace-lifecycle.js';

/**
 * Workspace (header switcher) routes — list / switch / create / delete — extracted
 * from server.ts. A flat leaf mirroring the other route modules. These are the
 * third ctx.swapActive user, and the only one that swaps WITH a workspace id
 * (the header label follows the served DB) — and the only one that can go virgin
 * (deleting the last workspace clears the active DB via ctx.goVirgin()). The
 * old active DB is disposed before each swap; `active` is read once (pre-swap)
 * and never used after a swap, so it stays a const.
 *
 * Additive: when the GUI was not opened inside a `.lattice` root, these return
 * empty and the header switcher stays hidden.
 */
export interface WorkspacesRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. */
  host: string;
  /** The `.lattice` root, or null when the GUI was launched outside one. */
  latticeRoot: string | null;
  /** Workspace (autoRender) mode — passed to openConfig on switch/create/delete. */
  autoRender: boolean;
}

export async function handleWorkspacesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: WorkspacesRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const active = ctx.active();
  const latticeRoot = deps.latticeRoot;

  if (method === 'GET' && pathname === '/api/workspaces') {
    if (!latticeRoot) {
      sendJson(res, { current: null, workspaces: [] });
      return true;
    }
    const all = listWorkspaces(latticeRoot);
    const activeWs = getActiveWorkspace(latticeRoot);
    sendJson(res, {
      // The served workspace is the source of truth for the header label;
      // fall back to the registry only if we couldn't match the boot config.
      current: ctx.workspaceId() ?? (activeWs ? activeWs.id : null),
      workspaces: all.map((w) => ({
        id: w.id,
        label: w.displayName,
        dir: w.dir,
        kind: w.kind,
      })),
    });
    return true;
  }
  // Swap which workspace this server process has open. The DURABLE half is the
  // registry pointer written below — every later open with no explicit id resolves
  // to it, from a command, a job, or a library call — and that half is an ordinary
  // exported function. What stays here is the in-process handle swap, which a direct
  // caller does not need because it holds the handle it opened.
  // @capability workspace.set-active
  if (method === 'POST' && pathname === '/api/workspaces/switch') {
    if (!latticeRoot) {
      sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { id?: unknown };
    if (typeof body.id !== 'string') {
      sendJson(res, { error: 'id must be a string' }, 400);
      return true;
    }
    const ws = getWorkspace(latticeRoot, body.id);
    if (!ws) {
      sendJson(res, { error: `No workspace with id ${body.id}` }, 400);
      return true;
    }
    const paths = resolveWorkspacePaths(latticeRoot, ws);
    // Check if an adopted-in-place workspace's config file is gone.
    if (ws.configPath && !existsSync(ws.configPath)) {
      sendJson(
        res,
        {
          error:
            `Workspace "${ws.displayName}" can't be opened — its config file no longer exists (${ws.configPath}). ` +
            'Remove it from the workspace list or restore the file.',
        },
        410,
      );
      return true;
    }
    let opened: { db: ActiveDb } | { timedOut: true };
    try {
      opened = await openWithinTimeout(() =>
        openConfig(paths.configPath, paths.contextDir, deps.autoRender),
      );
    } catch (e) {
      const err = e as Error;
      sendJson(res, { error: `Failed to open workspace ${ws.displayName}: ${err.message}` }, 500);
      return true;
    }
    if ('timedOut' in opened) {
      // The open never completed within the cap — keep the current workspace
      // active (do NOT swap) and surface a clear error instead of hanging
      // the switcher forever.
      sendJson(
        res,
        {
          error:
            `Opening "${ws.displayName}" timed out after ${String(SWITCH_OPEN_TIMEOUT_MS / 1000)}s — ` +
            'the database may be slow or unreachable. Staying on the current workspace.',
        },
        504,
      );
      return true;
    }
    const next = opened.db;
    setActiveWorkspace(latticeRoot, ws.id);
    await disposeActive(active);
    ctx.swapActive(next, ws.id); // header now tracks the just-switched DB; render kicks off-path
    sendJson(res, { ok: true, id: ws.id });
    return true;
  }
  // Reload the CURRENT workspace's schema in place: re-read the config and
  // re-register entities (so a table added out-of-band surfaces) WITHOUT a full
  // process restart. Reuses reopenSameConfig — same connection target, fresh
  // schema registration + converge. Lighter than killing the server.
  // @gui-only session-state: re-opens the workspace this server process already has open, so
  // connected clients pick up an out-of-band change. A direct caller re-opens by calling
  // openConfig again; the concept only exists because the server holds one shared handle.
  if (method === 'POST' && pathname === '/api/workspaces/reload') {
    let next: ActiveDb;
    try {
      next = await reopenSameConfig(active, deps.autoRender);
    } catch (e) {
      sendJson(res, { error: `Reload failed: ${(e as Error).message}` }, 500);
      return true;
    }
    ctx.swapActive(next); // same workspace, in-place reload — no id change; render kicks off-path
    const tables = [...next.validTables].filter((t) => !t.startsWith('_') && !t.startsWith('__'));
    sendJson(res, { ok: true, tables, convergeWarnings: next.convergeWarnings });
    return true;
  }
  // @capability workspace.create
  if (method === 'POST' && pathname === '/api/workspaces/create') {
    if (!latticeRoot) {
      sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendJson(res, { error: 'name is required' }, 400);
      return true;
    }
    let created;
    try {
      created = addWorkspace(latticeRoot, { displayName: name, makeActive: false });
    } catch (e) {
      sendJson(res, { error: `Failed to create workspace: ${(e as Error).message}` }, 500);
      return true;
    }
    // Open + activate the new workspace (mirror the switch handler).
    const newPaths = resolveWorkspacePaths(latticeRoot, created);
    let newActive: ActiveDb;
    try {
      newActive = await openConfig(newPaths.configPath, newPaths.contextDir, deps.autoRender);
    } catch (e) {
      sendJson(
        res,
        {
          error: `Created but failed to open ${created.displayName}: ${(e as Error).message}`,
        },
        500,
      );
      return true;
    }
    setActiveWorkspace(latticeRoot, created.id);
    await disposeActive(active);
    ctx.swapActive(newActive, created.id); // header tracks the new, now-served DB
    sendJson(res, { ok: true, id: created.id });
    return true;
  }
  // Unregister a workspace and remove the files it owned. The DURABLE half is one
  // exported call, shared verbatim with the delete route that runs when nothing is
  // open — two copies of a rule about which files to destroy is exactly what drifts.
  // What stays here is the in-process handle swap: releasing the store this server
  // has open, and either following a sibling or going to the zero-workspace state.
  // @capability workspace.delete
  if (method === 'POST' && pathname === '/api/workspaces/delete') {
    if (!latticeRoot) {
      sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
      return true;
    }
    const body = (await readJson<unknown>(req)) as { id?: unknown };
    if (typeof body.id !== 'string') {
      sendJson(res, { error: 'id must be a string' }, 400);
      return true;
    }
    const ws = getWorkspace(latticeRoot, body.id);
    if (!ws) {
      sendJson(res, { error: `No workspace with id ${body.id}` }, 400);
      return true;
    }
    const wsPaths = resolveWorkspacePaths(latticeRoot, ws);
    const isActive = resolve(active.configPath) === resolve(wsPaths.configPath);
    // Switch away from the active workspace first so file handles release
    // and the server keeps a live DB.
    let switchedTo: string | null = null;
    if (isActive) {
      const fallback = listWorkspaces(latticeRoot).find((w) => w.id !== ws.id);
      if (fallback) {
        // Switch to a sibling first so the deleted DB's handle releases.
        const fbPaths = resolveWorkspacePaths(latticeRoot, fallback);
        let next: ActiveDb;
        try {
          next = await openConfig(fbPaths.configPath, fbPaths.contextDir, deps.autoRender);
        } catch (e) {
          const err = e as Error & { code?: string };
          const codePrefix = err.code ? `[${err.code}] ` : '';
          sendJson(
            res,
            {
              error: `Cannot delete: failed to switch to ${fallback.displayName} first: ${codePrefix}${err.message}`,
            },
            500,
          );
          return true;
        }
        setActiveWorkspace(latticeRoot, fallback.id);
        await disposeActive(active);
        ctx.swapActive(next, fallback.id); // deleted the served DB → header follows the fallback
        switchedTo = fallback.id;
      } else {
        // Deleting the LAST workspace → enter the virgin (zero-workspace)
        // state. Release the DB and leave the server with no active DB; the
        // client renders the welcome screen on the next /api/workspaces poll.
        await disposeActive(active);
        ctx.goVirgin();
        // `active` (the per-request local) is now stale, but the handler
        // returns immediately below — no further use this request.
      }
    }
    // Drop the registry record, then clean up files (loud on failure).
    try {
      deleteWorkspace({ root: latticeRoot, id: ws.id });
    } catch (e) {
      if (workspaceErrorCode(e)) {
        sendJson(res, { error: (e as Error).message }, 400);
        return true;
      }
      sendJson(
        res,
        { error: `Workspace unregistered but file cleanup failed: ${(e as Error).message}` },
        500,
      );
      return true;
    }
    sendJson(res, { ok: true, switchedTo });
    return true;
  }

  return false;
}
