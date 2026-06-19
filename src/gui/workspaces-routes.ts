import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
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
  removeWorkspace,
  resolveWorkspacePaths,
  type WorkspaceRecord,
} from '../framework/workspace.js';
import { workspaceDir } from '../framework/lattice-root.js';
import { deleteDbCredential } from '../framework/user-config.js';

/**
 * Remove a workspace's owned files from disk after its registry record has been
 * dropped. Loud on failure (the caller surfaces it as a 500). Scaffolded local
 * workspace → delete its whole folder; cloud → forget only the LOCAL pointer
 * (its managed config + the saved credential when no other workspace uses it)
 * and never touch the shared remote; adopted-in-place local → leave the user's
 * files alone (non-destructive). Shared by the active-DB delete handler here and
 * the virgin-state delete route in server.ts so the two can never drift.
 */
export function cleanupWorkspaceFiles(root: string, ws: WorkspaceRecord): void {
  if (!ws.configPath && ws.kind === 'local') {
    rmSync(workspaceDir(root, ws.dir), { recursive: true, force: true });
  } else if (ws.kind === 'cloud') {
    if (ws.configPath && existsSync(ws.configPath)) {
      rmSync(ws.configPath, { force: true });
    }
    const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(ws.db.trim());
    const label = labelMatch?.[1];
    if (label) {
      const stillUsed = listWorkspaces(root).some((w) =>
        w.db.includes('${LATTICE_DB:' + label + '}'),
      );
      if (!stillUsed) {
        try {
          deleteDbCredential(label);
        } catch {
          // credential already gone — fine
        }
      }
    }
  }
  // Adopted local workspaces: leave the user's files in place (non-destructive).
}

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
    removeWorkspace(latticeRoot, ws.id);
    try {
      cleanupWorkspaceFiles(latticeRoot, ws);
    } catch (e) {
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
