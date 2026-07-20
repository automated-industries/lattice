import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { dirname, resolve } from 'node:path';
import { sendJson, readJson, sendHtmlCompressed, sendCompressed } from './http.js';
import { chartLibJs } from './app/modules/chart-lib.js';
import { computeBoundAuthorities, isSameOriginRequest, isLoopbackHost } from './origin-guard.js';
import {
  type ActiveDb,
  changeVisibleToActiveRole,
  isDeleteOp,
  isFeedHiddenTable,
  isRegisteredTable,
} from './active-db.js';
import { openConfig, startBackgroundRender, disposeActive } from './lifecycle.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  getWorkspace,
  addWorkspace,
  removeWorkspace,
  resolveWorkspacePaths,
} from '../framework/workspace.js';
import { fileJunctions, entityDescriptions } from './data.js';
import { guiAppHtml } from './app.js';
import { feedOpForChange } from './realtime.js';
import { createUpdateService, type UpdateService } from './update-service.js';
import type { InstallContext } from '../update-context.js';
import { createGuiRequestContext, type GuiRequestContext } from './request-context.js';
import { upsertTableMeta } from './column-descriptions.js';
import {
  createFileJunction,
  createUserJunction,
  createUserEntity,
  addUserColumn,
  aiDeleteEntity,
  type DeleteResolution,
} from './schema-ops.js';
import { dispatchUserConfigRoute } from './userconfig-routes.js';
import { dispatchDbConfigRoute, redeemInvite } from './dbconfig-routes.js';
import { dispatchFilesRoute } from './files-routes.js';
import { dispatchAssistantRoute, getAggressiveness } from './assistant-routes.js';
import { dispatchChatRoute } from './chat-routes.js';
import { isCloudChat, resolveChatOwnerId, mayReceiveChat } from './chat-identity.js';
import type { ChatProgressEnvelope } from './chat-progress.js';
import { resolvedProviderKind } from './ai/provider.js';
import { getClaudeLimitState } from './ai/limit-state.js';
import { dispatchQuestionRoute } from './question-routes.js';
import { dispatchIngestRoute, ingestLocalFile, ingestMutationCtx } from './ingest-routes.js';
import { dispatchSourcesRoute } from './sources-routes.js';
import { dispatchImportRoute, readImportSourceFromFile } from './import-routes.js';
import { importDataFaithfully } from './import-auto.js';
import { dispatchConnectorsRoute } from './connectors-routes.js';
import { dispatchDbSourcesRoute } from './db-sources-routes.js';
import {
  builtinConnectors,
  resolveConnectorIdentity,
  describeConnectedSources,
} from '../connectors/index.js';
// Internal helper (not part of the public API surface) — the on-access-refresh connector set.
import { freshnessConnectors } from '../connectors/catalog.js';
import { handleReadRoutes, type ReadRoutesDeps } from './read-routes.js';
import { handleTablesRoutes, type TablesRoutesDeps } from './tables-routes.js';
import { handleSchemaRoutes, type SchemaRoutesDeps } from './schema-routes.js';
import { handleComputedRoutes, type ComputedRoutesDeps } from './computed-routes.js';
import {
  createComputedTable,
  updateComputedTable,
  deleteComputedTable,
  previewComputedTable,
  refreshComputedTable,
  listComputedTables,
} from './computed-ops.js';
import { handleHistoryRoutes, type HistoryRoutesDeps } from './history-routes.js';
import {
  handleWorkspacesRoutes,
  cleanupWorkspaceFiles,
  type WorkspacesRoutesDeps,
} from './workspaces-routes.js';
import { handleDatabasesRoutes, type DatabasesRoutesDeps } from './databases-routes.js';
import {
  readIdentity,
  writeIdentity,
  deleteDbCredential,
  saveDbCredential,
} from '../framework/user-config.js';

export interface StartGuiServerOptions {
  /**
   * Active workspace config to open. NULL/empty ⇒ boot into the zero-workspace
   * "virgin" state (no active DB): the server serves the shell + the
   * workspace-management & onboarding routes, and every data route 409s until a
   * workspace is created or joined. `latticeRoot` must be set in that case so the
   * onboarding routes can register the new workspace.
   */
  configPath?: string | null;
  /** Render output dir for the active workspace. NULL/empty in the virgin state. */
  outputDir?: string | null;
  /**
   * The `.lattice` root. Normally discovered from `configPath`, but MUST be passed
   * when booting virgin (no config to discover it from) so the management routes
   * can add the first workspace into the right registry.
   */
  latticeRoot?: string | null;
  port?: number;
  openBrowser?: boolean;
  /**
   * Bind address. Defaults to `127.0.0.1`. Use `0.0.0.0` (or a specific
   * interface) to expose the server outside localhost.
   */
  host?: string;
  /**
   * Workspace mode: derive canonical entity contexts for tables without one
   * and keep the rendered Context/ tree synced via auto-render on every write.
   * Set by `lattice gui` when opening a `.lattice` workspace. Off for a plain
   * `--config` GUI (which serves only externally-rendered context).
   */
  autoRender?: boolean;
  /**
   * Package version string (no leading `v`), stamped into the served GUI shell
   * at the `<!--LATTICE_VERSION-->` placeholder (shown left of the settings
   * gear). Passed in by `cli.ts` (`getVersion()`) so the version is resolved in
   * the ESM entrypoint — server.ts is bundled to both CJS and ESM, and reading
   * package.json via `import.meta.url` here would break the CJS bundle. Omitted
   * ⇒ the version chip stays hidden.
   */
  version?: string;
  /**
   * Absolute path to the built `dist/gui-assets/` directory (the on-device voice
   * worker + ONNX-Runtime WASM), served read-only at `GET /gui-assets/*`. Passed
   * by `cli.ts` (resolved against the package via `import.meta.url`, like
   * `version`) because server.ts is bundled to both CJS and ESM — reading the
   * path via `import.meta.url` here would break the CJS bundle. Omitted ⇒ a
   * best-effort default (sibling of the running CLI bundle, else `<cwd>/dist/
   * gui-assets`), so source/dev/test runs still serve the assets when present.
   */
  guiAssetsDir?: string;
  /**
   * Realtime backstop liveness-poll interval (ms) for the RealtimeBroker. A
   * managed-Postgres proxy (e.g. AWS RDS Proxy) can silently drop the LISTEN
   * without closing the socket; the poll re-delivers missed changes regardless.
   * Omitted ⇒ the broker's default (20s). 0 disables it.
   */
  realtimeWatchdogMs?: number;
  /**
   * Master switch for ALL auto-update behavior (default true). When false: the
   * in-process poll never runs (no registry/manifest fetch, no install, no
   * relaunch), `/api/update/status` reports `autoUpdate:false` / `action:'none'`,
   * and the desktop/CLI callers skip their own updaters too. Provided so the GUI
   * can be run pinned to its current version (testing, air-gapped, reproducible
   * demos). `GET /api/version` + `GET /api/update/status` still answer.
   */
  autoUpdate?: boolean;
  /**
   * Run the in-process auto-update poll: while the GUI is open, check for a
   * newer version and, when one lands on an installable copy, install it and
   * exit with the supervisor's restart code so it relaunches on the new version.
   * Set ONLY for a supervised child (`LATTICE_GUI_SUPERVISED=1`) — exiting to
   * apply an update is safe only when a supervisor is there to respawn it. This
   * is the npm install-and-relaunch SUB-behavior; it is forced off when
   * `autoUpdate` is false. `GET /api/version` + `GET /api/update/status` are
   * served regardless.
   */
  selfUpdate?: boolean;
  /**
   * Test seam: supply the update service instead of building one from the real
   * npm-backed install context. Lets tests exercise the update routes against a
   * deterministic fake (no real registry check, no real npm install). When set,
   * it overrides `selfUpdate`'s default factory.
   */
  updateServiceFactory?: (emit: (type: string, data: unknown) => void) => UpdateService;
  /**
   * Override the "is a newer version available?" probe. The desktop shell passes
   * a function that reads its release manifest (latest.json) — the same source
   * its bundled updater applies from — so the GUI surfaces a "restart to update"
   * hint without coupling the desktop to the npm registry. Omitted ⇒ the default
   * npm-registry check (web/CLI).
   */
  updateCheck?: (force: boolean) => Promise<string | null>;
  /**
   * Override the detected install context for the update service. The desktop
   * shell passes `{ kind:'desktop', installable:false, … }` so the status route
   * reports the desktop surface (→ `action:'restart-to-update'`) rather than
   * "unknown / not installable".
   */
  updateContext?: InstallContext;
  /**
   * Desktop shell only: apply a pending update via the bundled binary updater
   * (download + relaunch). Wired to `POST /api/update/apply` when the surface is
   * the desktop app, so the "Restart to update" pill triggers the real updater
   * instead of the npm install path (which the desktop can't use). Omitted ⇒ the
   * apply route uses the npm path / reports "not available".
   */
  desktopApplyUpdate?: () => void;
  /**
   * Desktop shell only: open an external URL in the OS default browser. The
   * embedded desktop webview has no tabs, so `target="_blank"` links are routed
   * to `GET /api/desktop/open` which calls this. Omitted for the web/CLI GUI —
   * the route then 404s, so a browser-served GUI can never trigger an OS open.
   */
  desktopOpenExternal?: (url: string) => void;
}

export interface GuiServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
  /**
   * Resolves when the active workspace's background owner-side convergence (cloud
   * RLS / member grants, incl. the `_lattice_gui_meta` read-grant) has settled.
   * Opening a cloud workspace returns immediately and convergence runs unawaited
   * (see {@link ActiveDb.converged}); a test that acts AS A MEMBER right after the
   * owner opens MUST await this, or the member render can race the grant and fail
   * with "permission denied for table _lattice_gui_meta". The GUI never needs it;
   * resolves immediately for a non-cloud / virgin workspace.
   */
  whenConverged: () => Promise<void>;
  /**
   * TEST-ONLY: publish a chat-progress envelope directly into the active workspace's bus so
   * the per-user `/api/stream` delivery gate can be exercised without a live model turn.
   * Never invoked in production.
   */
  publishChatProgressForTest: (env: ChatProgressEnvelope) => void;
}

/**
 * Best-effort default for the vendored GUI assets dir when the caller didn't pass
 * one. Used by dev/source/test runs (the CLI passes an explicit path resolved
 * against the package). Prefer a `gui-assets` sibling of the running bundle
 * (published layout: `dist/cli.js` + `dist/gui-assets/`), else `<cwd>/dist/
 * gui-assets` (source/test runs from the repo root). Returns the first that
 * exists, else the cwd guess — the route 404s when it's wrong, never crashes.
 */
function resolveDefaultGuiAssetsDir(): string {
  const bundleSibling = process.argv[1] ? resolve(dirname(process.argv[1]), 'gui-assets') : null;
  if (bundleSibling && existsSync(bundleSibling)) return bundleSibling;
  return resolve(process.cwd(), 'dist', 'gui-assets');
}

function sendText(
  res: ServerResponse,
  body: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

export function openUrl(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  // A missing opener (e.g. headless Linux without xdg-open) emits an async 'error'
  // EVENT on the child — with no listener Node turns it into a fatal unhandled
  // exception that takes the GUI server down right as it boots. Opening a browser
  // is a convenience: degrade to a console note, never a crash. (Same guarded
  // pattern as the reveal-in-file-manager spawn in files-routes.ts.)
  child.on('error', (err: Error) => {
    console.warn(`[lattice] could not open ${url} in a browser:`, err.message);
  });
  child.unref();
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      resolveListen(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithPortFallback(
  server: Server,
  startPort: number,
  host: string,
): Promise<number> {
  for (let port = startPort; port < startPort + 50; port++) {
    try {
      return await listen(server, port, host);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No available port found starting at ${String(startPort)}`);
}

// Schema create/alter/delete routes (incl. the SCHEMA_SYSTEM_COLUMNS /
// ALLOWED_COLUMN_TYPES guards and the columnRefTarget helper) live in
// schema-routes.ts.

// Row-CRUD + link/unlink routes (incl. the page-param + header helpers and the
// /rows + /link regexes) live in tables-routes.ts / route-paths.ts.

// Row-context reading (locator + file read) is shared with the AI assistant's
// `get_row_context` tool — see ./row-context.ts.

/** Everything tied to a single open lattice config / DB. Swapped wholesale when the user picks a different DB. */
/**
 * Live snapshot of the background render's progress for the active workspace.
 * Folded from the engine's {@link RenderProgress} events by
 * {@link startBackgroundRender} and served to the GUI over `/api/render/status`
 * (single-shot) + `render-progress` messages on the multiplexed `/api/stream`
 * WebSocket. A fresh one is constructed per {@link openConfig}, so a workspace
 * switch starts clean.
 */
// The ActiveDb value object + its read-side helpers now live in active-db.ts
// (the bottom of the GUI module graph). Re-exported here so existing importers
// of './server.js' (schema-ops.ts + tests) keep working post-extraction.
export type { ActiveDb, RenderStatusSnapshot } from './active-db.js';
export { changeVisibleToActiveRole } from './active-db.js';
export { sqliteFileForConfig, deleteDatabaseFiles } from './config-paths.js';
export { openConfig, disposeActive, openWithinTimeout } from './lifecycle.js';

export async function startGuiServer(options: StartGuiServerOptions): Promise<GuiServerHandle> {
  // Virgin (zero-workspace) boot ⇒ no config to open. configPath/outputDir are
  // null until a workspace is created or joined (the onboarding routes set them
  // via the registry, not from these boot values).
  const bootConfigPath = options.configPath ? resolve(options.configPath) : null;
  const bootOutputDir = options.outputDir ? resolve(options.outputDir) : null;
  const startPort = options.port ?? 4317;
  const host = options.host ?? '127.0.0.1';
  // The data routes (rows, ingest, connect/import) are UNAUTHENTICATED — that is
  // the accepted trust model only because the server defaults to loopback. Binding
  // to a non-loopback address (e.g. 0.0.0.0) exposes read/write/import to the
  // network with no auth layer, so say so loudly at startup. We do not block it —
  // an operator may do it deliberately behind their own network controls.
  const hostIsLoopback = isLoopbackHost(host);
  if (!hostIsLoopback) {
    console.warn(
      `[lattice] GUI is binding to a non-loopback address (${host}); its data ` +
        `routes are UNAUTHENTICATED and will be reachable from the network.`,
    );
  }
  const autoRender = options.autoRender ?? false;
  const guiVersion = options.version ?? '';
  const autoUpdate = options.autoUpdate ?? true;
  // Where the vendored GUI assets (on-device voice worker + ORT WASM) live. The
  // CLI passes this resolved against the package (it knows the package root via
  // import.meta.url). When omitted (dev/source/test runs), fall back to a sibling
  // of the running bundle, else `<cwd>/dist/gui-assets`. The route 404s if the dir
  // is absent (fail-soft asset build skipped), so a wrong guess just hides voice —
  // never crashes.
  const guiAssetsDir = options.guiAssetsDir ?? resolveDefaultGuiAssetsDir();
  const desktopOpenExternal = options.desktopOpenExternal;
  // One id per GUI server process. Stamped on every audit entry so the header
  // undo/redo stack is scoped to THIS session's own actions (you undo what you
  // did, not another cloud user's edit). The per-entry Revert stays global.
  const sessionId = crypto.randomUUID();

  // Auto-update poll (supervised child only). Created after the WebSocket server
  // exists (so it can broadcast), started after the socket is listening, stopped
  // on close. The request handler reads it for `/api/update/status`.
  let updateService: UpdateService | null = null;

  // Discover the `.lattice` root (if the GUI was opened inside a workspace) so the
  // header switcher can list + switch workspaces — and so a bad active workspace
  // can fall through to a working one at boot. `null` ⇒ opened on a plain config
  // (switcher hidden); in the virgin state the root comes from the options.
  const latticeRoot =
    (bootConfigPath ? findLatticeRoot(dirname(bootConfigPath)) : null) ??
    (options.latticeRoot ? resolve(options.latticeRoot) : null);

  // Mutable reference: switching DBs replaces this wholesale; NULL in the virgin
  // (zero-workspace) state until the first workspace is created or joined. The
  // request handler gates every data route behind a non-null check.
  let activeRef: ActiveDb | null = null;
  // Which workspace is ACTUALLY being served (the open `active` DB). The header
  // switcher must reflect THIS, not the registry's stored activeWorkspaceId — the
  // two can drift (a relaunch whose --config points elsewhere, or a fall-through
  // when the stored-active workspace can't open).
  let currentWorkspaceId: string | null = null;

  if (bootConfigPath && bootOutputDir) {
    try {
      activeRef = await openConfig(
        bootConfigPath,
        bootOutputDir,
        autoRender,
        options.realtimeWatchdogMs,
      );
      if (latticeRoot) {
        const launched = listWorkspaces(latticeRoot).find(
          (w) =>
            resolve(resolveWorkspacePaths(latticeRoot, w).configPath) === resolve(bootConfigPath),
        );
        currentWorkspaceId = launched?.id ?? getActiveWorkspace(latticeRoot)?.id ?? null;
        if (launched && getActiveWorkspace(latticeRoot)?.id !== launched.id) {
          setActiveWorkspace(latticeRoot, launched.id);
        }
      }
    } catch (err) {
      // The stored-active workspace can't open (e.g. its DB credential is missing).
      // Never brick the whole app: fall through to the first OTHER workspace that
      // opens, so the user lands in real data with the switcher listing the rest —
      // not a dead-end error dialog or a misleading zero-state welcome screen.
      console.error(
        `[gui] active workspace failed to open (${bootConfigPath}): ${(err as Error).message}`,
      );
      const launchedPath = resolve(bootConfigPath);
      const root = latticeRoot; // narrow once so the loop body needs no cast/assertion
      if (root) {
        for (const w of listWorkspaces(root)) {
          const paths = resolveWorkspacePaths(root, w);
          if (resolve(paths.configPath) === launchedPath) continue; // the one that just failed
          try {
            activeRef = await openConfig(
              paths.configPath,
              paths.contextDir,
              autoRender,
              options.realtimeWatchdogMs,
            );
            currentWorkspaceId = w.id;
            setActiveWorkspace(root, w.id);
            console.error(`[gui] opened the next working workspace instead: "${w.displayName}".`);
            break;
          } catch {
            // try the next workspace
          }
        }
      }
      if (!activeRef) {
        console.error('[gui] no workspace could be opened — showing the welcome screen.');
      }
    }
  }

  // Centralized active-DB swap: keeps `activeRef` + the served-workspace id in
  // lockstep and kicks off the background render off the response path. Used by
  // every create/switch/delete/onboarding transition (and the virgin → first
  // workspace transition). Passing null enters the virgin state.
  const setActive = (next: ActiveDb | null, workspaceId: string | null): void => {
    activeRef = next;
    currentWorkspaceId = workspaceId;
    if (next) startBackgroundRender(next);
  };

  const disposeActiveIfAny = async (): Promise<void> => {
    if (activeRef) await disposeActive(activeRef);
  };

  // Open + activate a cloud workspace joined/created via an invite or a migration.
  // Tolerates the virgin state (no prior active to dispose). Atomic: on open
  // failure it rolls back the half-created workspace + credential and rethrows.
  // Shared by the dbconfig dispatcher (redeem/connect) and the virgin onboarding.
  const createCloudWorkspace = async (
    displayName: string,
    key: string,
    url: string,
  ): Promise<string> => {
    if (!latticeRoot) throw new Error('No .lattice root — cannot create a cloud workspace');
    saveDbCredential(key, url);
    let created;
    try {
      created = addWorkspace(latticeRoot, {
        displayName,
        db: '${LATTICE_DB:' + key + '}',
        makeActive: false,
      });
    } catch (e) {
      deleteDbCredential(key);
      throw e;
    }
    const paths = resolveWorkspacePaths(latticeRoot, created);
    let next: ActiveDb;
    try {
      next = await openConfig(paths.configPath, paths.contextDir, autoRender);
    } catch (e) {
      removeWorkspace(latticeRoot, created.id);
      deleteDbCredential(key);
      throw e;
    }
    setActiveWorkspace(latticeRoot, created.id);
    await disposeActiveIfAny();
    setActive(next, created.id);
    return created.id;
  };

  // Reopen the currently-served config (after an in-place config edit). The
  // dbconfig dispatcher's `swap` callback; no-op in the virgin state.
  const reopenActive = async (): Promise<void> => {
    if (!activeRef) return;
    const prev = activeRef;
    const next = await openConfig(prev.configPath, prev.outputDir, autoRender);
    setActive(next, currentWorkspaceId);
    await disposeActive(prev);
  };

  // Create + activate a brand-new LOCAL workspace (the onboarding "Create →
  // Local" path; also reachable from the virgin state). No prior active needed.
  const createLocalWorkspace = async (name: string): Promise<string> => {
    if (!latticeRoot) throw new Error('No .lattice root — workspaces unavailable');
    const created = addWorkspace(latticeRoot, { displayName: name, makeActive: false });
    const paths = resolveWorkspacePaths(latticeRoot, created);
    let next: ActiveDb;
    try {
      next = await openConfig(paths.configPath, paths.contextDir, autoRender);
    } catch (e) {
      removeWorkspace(latticeRoot, created.id);
      throw e;
    }
    setActiveWorkspace(latticeRoot, created.id);
    await disposeActiveIfAny();
    setActive(next, created.id);
    return created.id;
  };

  // Routes that work WITHOUT an active workspace (the zero-workspace "virgin"
  // state): the shell, realtime status, identity, the registry list, and the
  // create/join onboarding routes. Returns true when it handled the request.
  // Everything else 409s (the caller surfaces that). The Cloud-create path is
  // create-local-then-migrate on the client, so migrate-to-cloud is NOT here.
  const handleVirginRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
  ): Promise<boolean> => {
    if (method === 'GET' && pathname === '/') {
      sendHtmlCompressed(
        req,
        res,
        guiAppHtml.replace('<!--LATTICE_VERSION-->', guiVersion ? `v${guiVersion}` : ''),
      );
      return true;
    }
    if (method === 'GET' && pathname === '/api/realtime/status') {
      sendJson(res, { mode: 'none', connected: false });
      return true;
    }
    if (method === 'GET' && pathname === '/api/workspaces') {
      // `virgin: true` is the authoritative signal that there is NO active DB
      // (the welcome screen). The client must gate on THIS, not on an empty
      // workspace list — a plain `--config` GUI has an active DB but no `.lattice`
      // registry, so its list is empty yet it is NOT virgin.
      sendJson(res, {
        virgin: true,
        current: latticeRoot ? (getActiveWorkspace(latticeRoot)?.id ?? null) : null,
        workspaces: latticeRoot ? listWorkspaces(latticeRoot) : [],
      });
      return true;
    }
    if (method === 'GET' && pathname === '/api/userconfig/identity') {
      sendJson(res, readIdentity());
      return true;
    }
    if (method === 'POST' && pathname === '/api/userconfig/identity') {
      const body = (await readJson<unknown>(req)) as { display_name?: unknown; email?: unknown };
      const next = {
        display_name: typeof body.display_name === 'string' ? body.display_name : '',
        email: typeof body.email === 'string' ? body.email : '',
      };
      // Machine-local file only — there is no active DB to mirror into yet.
      writeIdentity(next);
      sendJson(res, next);
      return true;
    }
    if (method === 'POST' && pathname === '/api/workspaces/create') {
      const body = (await readJson<unknown>(req)) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendJson(res, { error: 'name is required' }, 400);
        return true;
      }
      try {
        const id = await createLocalWorkspace(name);
        sendJson(res, { ok: true, id });
      } catch (e) {
        sendJson(res, { error: `Failed to create workspace: ${(e as Error).message}` }, 500);
      }
      return true;
    }
    if (method === 'POST' && pathname === '/api/workspaces/delete') {
      // Deletion operates on the registry, not the open DB, so it must work with
      // no active workspace too. Otherwise a workspace whose database fails to
      // open strands the GUI in the virgin state while the welcome screen still
      // lists it — and it could never be removed (the active-DB delete route
      // 409'd "No active workspace"). With nothing active there is no DB to
      // switch away from: just drop the record, then its files. Uses the same
      // cleanupWorkspaceFiles helper as the active-DB delete so the two can
      // never drift.
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
      sendJson(res, { ok: true, switchedTo: null });
      return true;
    }
    if (method === 'POST' && pathname === '/api/cloud/redeem-invite') {
      await redeemInvite(createCloudWorkspace, req, res);
      return true;
    }
    // Assistant credentials (API key + Claude subscription OAuth) live in the
    // machine-local store, not a workspace — config / key / OAuth all work with no
    // active DB. This is what lets "Connect with Claude" run from first-run
    // onboarding, before any workspace exists (the connect step precedes create).
    if (pathname.startsWith('/api/assistant/')) {
      return dispatchAssistantRoute(req, res, { db: null, pathname, method });
    }
    return false;
  };

  // Process-constant dependencies for the extracted read-route dispatcher
  // (host/guiVersion/guiAppHtml/sendText never change for the server's life),
  // built once here rather than per request.
  const readDeps: ReadRoutesDeps = {
    host,
    guiVersion,
    guiAppHtml,
    sendText,
    guiAssetsDir,
    // Freshness set (includes db_source), not just builtinConnectors — the on-access refresh in
    // read-routes must resolve an impl for external-DB tables too, or it silently never fires.
    connectors: freshnessConnectors(),
  };
  const tablesDeps: TablesRoutesDeps = { host };
  const schemaDeps: SchemaRoutesDeps = { host, autoRender };
  const computedDeps: ComputedRoutesDeps = { host };
  const historyDeps: HistoryRoutesDeps = { host, autoRender };
  const workspacesDeps: WorkspacesRoutesDeps = { host, latticeRoot, autoRender };
  const databasesDeps: DatabasesRoutesDeps = { host, autoRender };

  /**
   * One entry in the ordered dispatch registry built per request. `handle`
   * returns true when it handled the request (the dispatch loop short-circuits)
   * and false when its prefix/method guard doesn't match (the loop falls through
   * to the next entry) — folding the old `if (pathname.startsWith(...))` guards
   * into each closure. The prefix-match guards are part of `handle`; there is no
   * separate matcher, which keeps the chain behavior-identical to the prior
   * `if (...) return;` sequence.
   */
  type RouteEntry = {
    handle: (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: GuiRequestContext,
    ) => boolean | Promise<boolean>;
  };

  // CSRF / DNS-rebinding guard for the unauthenticated local server. A browser on
  // the same loopback is exactly the cross-site attacker's vehicle: any site the
  // user visits can POST to 127.0.0.1 as the local user. So every state-changing
  // request (and the WS upgrade) must be same-origin AND carry the Host we actually
  // bound. Set once the real port is known (below); before that no external request
  // can arrive. This adds NO auth layer — legitimate same-origin GUI requests pass.
  let boundAuthorities: Set<string> | null = null;
  function requestIsSameOrigin(req: IncomingMessage): boolean {
    const allowed = boundAuthorities;
    if (!allowed) return true; // not yet listening → unreachable
    return isSameOriginRequest(req.headers, allowed);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // Reject cross-site / rebound-Host state changes before any routing. GETs
        // are covered by the browser same-origin policy (we send no permissive
        // CORS), except side-effecting GETs which opt in explicitly below.
        const mutating =
          method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        if (mutating && !requestIsSameOrigin(req)) {
          sendJson(res, { error: 'cross-site request blocked' }, 403);
          return;
        }

        // Version + update status — answered in BOTH virgin and active states, and
        // independent of any workspace. The browser polls `/api/version` on each
        // `/api/stream` reconnect; a value newer than the page it loaded means the
        // server relaunched onto a new build, so the tab reloads itself.
        if (method === 'GET' && pathname === '/api/version') {
          sendJson(res, { version: guiVersion });
          return;
        }
        // The vendored Chart.js (~275 KB) used only by the HTML-file artifact
        // preview. Served on demand (fetched by dashboard.ts ensureChartLib) instead
        // of inlined into the client bundle, so it no longer weighs on every
        // startup's parse. Cacheable — a modest max-age avoids a stale-asset footgun
        // while keeping the rare re-fetch cheap.
        if (method === 'GET' && pathname === '/gui-assets/chart-lib.js') {
          sendCompressed(
            req,
            res,
            chartLibJs,
            'text/javascript; charset=utf-8',
            'public, max-age=86400',
          );
          return;
        }
        // Desktop shell only: open an external URL in the OS default browser.
        // The embedded webview has no tabs, so its injected link-interceptor
        // routes `target="_blank"` clicks here. 404s unless the desktop host
        // supplied an opener, so a web-served GUI can't trigger an OS open. Only
        // http(s) URLs are honored.
        if (method === 'GET' && pathname === '/api/desktop/open') {
          // Side-effecting GET (opens the OS browser) → same-origin only, so a
          // cross-site <img>/navigation can't drive an OS open to an arbitrary URL.
          if (!requestIsSameOrigin(req)) {
            sendJson(res, { error: 'cross-site request blocked' }, 403);
            return;
          }
          if (!desktopOpenExternal) {
            sendJson(res, { error: 'not found' }, 404);
            return;
          }
          const target = new URL(req.url ?? '', 'http://localhost').searchParams.get('url');
          if (!target || !/^https?:\/\//i.test(target)) {
            sendJson(res, { error: 'url must be http(s)' }, 400);
            return;
          }
          desktopOpenExternal(target);
          sendJson(res, { ok: true });
          return;
        }
        if (method === 'GET' && pathname === '/api/update/status') {
          sendJson(
            res,
            updateService?.status() ?? {
              current: guiVersion,
              latest: null,
              kind: 'unknown',
              installable: false,
              autoUpdate,
              action: 'none',
              checking: false,
              installing: false,
              lastError: null,
            },
          );
          return;
        }
        if (method === 'POST' && pathname === '/api/update/apply') {
          // Manual trigger behind the "update available" pill. The right action
          // depends on the surface (reported as `status.action`):
          //  - desktop (`restart-to-update`): run the bundled binary updater,
          //    which downloads + relaunches — the npm install path can't touch a
          //    compiled app.
          //  - npm (`upgrade-in-place`): force a check that installs the latest
          //    and restarts the GUI onto it. The install is slow (an npm
          //    install), so kick it off without blocking — `checkNow(true)`
          //    emits its own progress/errors (update-applied / update-error).
          //  - anything else (no update, auto-update disabled, or a surface that
          //    can't self-update): answer with a plain "can't", not a crash, so
          //    the client can tell the user how to upgrade by hand.
          const st = updateService?.status();
          if (st?.action === 'restart-to-update' && options.desktopApplyUpdate) {
            options.desktopApplyUpdate();
            sendJson(res, { ok: true, status: st });
          } else if (updateService && st?.action === 'upgrade-in-place') {
            void updateService.checkNow(true);
            sendJson(res, { ok: true, status: updateService.status() });
          } else {
            sendJson(res, {
              ok: false,
              error:
                st && !st.autoUpdate
                  ? 'Automatic update is disabled for this session.'
                  : 'Automatic update is not available for this install. ' +
                    'Reinstall from https://latticesql.com to get the latest version.',
            });
          }
          return;
        }

        // Zero-workspace "virgin" state: no active DB. Serve only the shell +
        // the workspace-management & onboarding routes; everything else 409s
        // (loud, never a crash). Creating/joining a workspace sets `activeRef`,
        // so the NEXT request falls through to the normal data routes below.
        if (!activeRef) {
          if (await handleVirginRoute(req, res, pathname, method)) return;
          sendJson(res, { error: 'No active workspace' }, 409);
          return;
        }
        // Non-null for the entire normal handler below. Reassigned in lockstep
        // with `activeRef` at every swap site so the next request sees the swap.
        let active: ActiveDb = activeRef;

        // Per-request handle the route modules will take as their third arg.
        // Closes over the handler's reassignable bindings (never their values) so
        // ctx.active() is always live and ctx.swapActive is the single write-back
        // path. Inline swap sites stay verbatim until the route modules move them.
        const ctx = createGuiRequestContext({
          getActiveRef: () => activeRef,
          setActiveRef: (next) => {
            activeRef = next;
          },
          setLocalActive: (next) => {
            active = next;
          },
          getWorkspaceId: () => currentWorkspaceId,
          setWorkspaceId: (next) => {
            currentWorkspaceId = next;
          },
          startBackgroundRender,
          sessionId,
        });

        // ── Ordered route registry ────────────────────────────────────────
        // The request dispatch is a single explicit, ORDERED list iterated by the
        // for-loop below. Each entry's `handle` self-filters: it returns true when
        // it handled the request (the loop then short-circuits, exactly like the
        // old `if (await handleX(...)) return;` chain) and false when its
        // prefix/method guard doesn't match (the loop falls through to the next
        // entry, exactly like the old `if (pathname.startsWith(...))` guard). The
        // order here IS the dispatch order — do not reorder.
        //
        // Each entry closes over THIS request's `ctx` and the per-request `active`
        // local. A route earlier in the list can swap the active workspace (schema
        // edit, dbconfig reopen) via `ctx.swapActive`, which reassigns the same
        // `active` `let` these closures read — so a later entry reading `active.db`
        // sees the post-swap value, identical to the prior inline chain.
        //
        // Realtime change events, the activity feed, and background-render progress
        // are NOT routes here: they are multiplexed onto ONE WebSocket
        // (`/api/stream`, handled via the HTTP `upgrade` path below) so a browser
        // tab holds a single persistent connection instead of three. Three SSE
        // streams per tab consumed the whole HTTP/1.1 6-connections-per-host budget
        // after just two tabs, which starved every data request (entities/rows/
        // switch) and froze the UI; a WebSocket lives in a separate, far larger
        // connection pool, so data requests always keep the full HTTP budget free.
        // See `handleEventStream`.
        const routes: RouteEntry[] = [
          // ── HTML + read-only data routes ──
          { handle: (req, res, ctx) => handleReadRoutes(req, res, ctx, readDeps) },
          // ── Schema create/alter/delete (extracted leaf — schema-routes.ts) ──
          { handle: (req, res, ctx) => handleSchemaRoutes(req, res, ctx, schemaDeps) },
          // ── Computed tables: CRUD + preview + refresh (computed-routes.ts) ──
          { handle: (req, res, ctx) => handleComputedRoutes(req, res, ctx, computedDeps) },
          // ── Version history: undo / redo / revert (extracted leaf — history-routes.ts) ──
          { handle: (req, res, ctx) => handleHistoryRoutes(req, res, ctx, historyDeps) },
          // ── Workspaces: list / switch / create / delete (extracted leaf — workspaces-routes.ts) ──
          { handle: (req, res, ctx) => handleWorkspacesRoutes(req, res, ctx, workspacesDeps) },
          // ── Databases: list / switch / create / delete (extracted leaf — databases-routes.ts) ──
          { handle: (req, res, ctx) => handleDatabasesRoutes(req, res, ctx, databasesDeps) },
          // ── GUI-only metadata (per-entity icon overrides) ──
          {
            handle: async (req, res) => {
              if (!(method === 'PUT' && pathname.startsWith('/api/gui-meta/'))) return false;
              const entityName = decodeURIComponent(pathname.slice('/api/gui-meta/'.length));
              if (!isRegisteredTable(active, entityName)) {
                sendJson(res, { error: `Unknown table: ${entityName}` }, 400);
                return true;
              }
              const body = (await readJson<unknown>(req)) as {
                icon?: unknown;
                description?: unknown;
              };
              const settingIcon = 'icon' in body;
              const settingDescription = 'description' in body;
              if (settingIcon && typeof body.icon !== 'string') {
                sendJson(res, { error: 'icon must be a string' }, 400);
                return true;
              }
              if (!settingIcon && !settingDescription) {
                sendJson(res, { error: 'nothing to update (expected icon or description)' }, 400);
                return true;
              }
              // Consolidated find-or-insert, shared with the set_definition AI tool.
              await upsertTableMeta(active.db, entityName, {
                ...(settingIcon ? { icon: body.icon as string } : {}),
                ...(settingDescription
                  ? { description: typeof body.description === 'string' ? body.description : null }
                  : {}),
              });
              sendJson(res, { ok: true });
              return true;
            },
          },
          // ── Row CRUD + junction link/unlink (extracted leaf — tables-routes.ts) ──
          { handle: (req, res, ctx) => handleTablesRoutes(req, res, ctx, tablesDeps) },
          // ── User Config routes ──
          // Reads + writes machine-local user identity and the saved
          // cloud-DB credential catalog. Localhost-trust dev-tool routes.
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/userconfig/')) return false;
              return await dispatchUserConfigRoute(req, res, {
                db: active.db,
                configPath: active.configPath,
                pathname,
                method,
              });
            },
          },
          // ── AI assistant: credentials, OAuth, voice transcription ──
          // Local-only: the assistant rail is a single-user dev tool.
          // Subscription OAuth stays inert until ANTHROPIC_OAUTH_* is set.
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/assistant/')) return false;
              return await dispatchAssistantRoute(req, res, {
                db: active.db,
                pathname,
                method,
              });
            },
          },
          // ── AI-auth gate ──────────────────────────────────────────────────
          // Claude access is mandatory: every AI-mutating route is refused when no
          // Claude subscription (or managed operator credential) is connected. This
          // is the server-side backstop behind the client connect wall — a hidden
          // button can't enforce it, and the AI routes are directly HTTP-reachable.
          // /api/assistant/* (matched above) + GET /api/assistant/config stay open
          // so Connect itself can always run.
          {
            handle: async (req, res) => {
              const gated =
                pathname.startsWith('/api/chat') ||
                pathname.startsWith('/api/ingest/') ||
                pathname.startsWith('/api/import/') ||
                (method === 'POST' && /^\/api\/questions\/[^/]+\/answer$/.test(pathname));
              if (!gated) return false;
              // ANY configured provider satisfies the gate — a connected Claude
              // subscription, the managed cloud key, OR a user-configured API provider
              // (an OpenAI-compatible endpoint or a Claude API key). Mirrors GET
              // /api/assistant/config's `connected` so the server gate and the client
              // wall agree — previously this checked Claude only, so a working
              // OpenAI-compatible backend was refused here with `claude_not_connected`
              // even though the client considered itself connected. The error code is
              // kept: the client treats it as "no AI connected → show the connect wall".
              const providerKind = await resolvedProviderKind(active.db);
              if (!providerKind) {
                sendJson(res, { error: 'claude_not_connected' }, 403);
                return true;
              }
              // Pre-flight usage-limit block applies ONLY to the Anthropic wire (a
              // subscription, the managed cloud key, or a Claude API key): once Claude
              // has reported a usage limit, refuse the AI-mutating routes up front with
              // the same message instead of firing a request we know will 429 (auto-
              // clears at resetAt). A BYO OpenAI-compatible endpoint has no
              // Claude-subscription limit, so it is never blocked on Claude's state.
              if (providerKind === 'anthropic') {
                const limit = getClaudeLimitState();
                if (limit) {
                  sendJson(
                    res,
                    {
                      error: 'claude_limit',
                      message: limit.message,
                      resetAt: new Date(limit.resetAt).toISOString(),
                    },
                    429,
                  );
                  return true;
                }
              }
              return false;
            },
          },
          // ── Chat route ──
          // POST /api/chat — assistant tool loop, streamed as SSE. Executes
          // tool calls against the active DB via the shared mutation chokepoint.
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/chat')) return false;
              // Tell the assistant which external sources are connected (scoped to
              // this member so a cloud never leaks another member's connections),
              // so "are you connected to X?" is answered from state, not guessed.
              const chatIdent = readIdentity();
              const chatConnectedBy = await resolveConnectorIdentity(
                active.db,
                chatIdent.email || chatIdent.display_name || 'local',
              );
              let connectedSources = '';
              let connectionsUnknown = false;
              try {
                connectedSources = await describeConnectedSources(active.db, chatConnectedBy);
              } catch (e) {
                // Surface, never swallow to '' (no silent failure). Critically, a FAILED
                // enumeration must not read as "nothing connected" — that would answer "are you
                // connected to X?" with a confident false "no". Flag it so the intent pass defers
                // the question to the tool loop instead of asserting a negative from missing data.
                console.error(
                  '[chat] could not enumerate connected data sources; connection questions will defer to the tool loop:',
                  e,
                );
                connectionsUnknown = true;
              }
              return await dispatchChatRoute(req, res, {
                db: active.db,
                feed: active.feed,
                ...(connectedSources ? { connectedSources } : {}),
                ...(connectionsUnknown ? { connectionsUnknown: true } : {}),
                // Async transport: the route acks 202 and runs the turn as a background
                // job, streaming each event to this per-workspace bus (the /api/stream
                // forwarder gates delivery per user). The FIFO serializes turns so a
                // second message waits for the first.
                chatProgress: active.chatProgress,
                enqueueChatJob: (job) => {
                  active.chatJobs = active.chatJobs.then(job).catch((err: unknown) => {
                    // The job already published an 'error'+'done' frame before throwing;
                    // this backstop keeps a stray rejection from going unhandled (which
                    // would fail the process) and keeps the FIFO alive for the next turn.
                    console.error(
                      '[chat] background turn job failed:',
                      err instanceof Error ? err.message : String(err),
                    );
                  });
                },
                validTables: active.validTables,
                junctionTables: active.junctionTables,
                softDeletable: active.softDeletable,
                // The assistant can create tables + relationships on request — same
                // audited, no-reopen primitives the Context Constructor uses.
                createEntity: (name, columns) => createUserEntity(active, name, columns, sessionId),
                addColumn: (table, column) => addUserColumn(active, table, column, sessionId),
                createJunction: (a, b) => createUserJunction(active, a, b, sessionId),
                // The files-side linker the shared enrichment engine uses — lets the
                // ingest_text tool run pasted content through the same enrichWithLlm
                // path a dropped file uses (auto-links it to related records).
                createFileJunction: (otherTable) =>
                  createFileJunction(active, otherTable, sessionId),
                // Guarded, reversible table delete — empty tables go immediately;
                // non-empty ones come back as `needsResolution` so the assistant asks.
                deleteEntity: (name: string, resolution?: DeleteResolution) =>
                  aiDeleteEntity(active, name, resolution, sessionId),
                // Faithfully import an attached spreadsheet by files id — read its retained
                // bytes + materialize every row via the deterministic importer (the
                // import_spreadsheet tool). Same read + materialize path as the apply route,
                // so a workbook lands ALL its rows, never the lossy LLM summary.
                importAttachment: (fileId: string) =>
                  readImportSourceFromFile(active.db, fileId, dirname(active.configPath)).then(
                    ({ data }) => importDataFaithfully(active.db, active.configPath, data),
                  ),
                // Computed tables: tagged read-only in the schema context, and
                // driven by the assistant's computed-table tools through the
                // same audited, revertible primitives as the builder routes.
                computedTables: active.computedTables,
                computedOps: {
                  list: () => listComputedTables(active),
                  preview: (def, limit) => previewComputedTable(active, def, limit),
                  create: (name, def) => createComputedTable(active, name, def, sessionId),
                  update: (name, def) => updateComputedTable(active, name, def, sessionId),
                  refresh: (name) => refreshComputedTable(active, name, { sessionId }),
                  delete: (name) => deleteComputedTable(active, name, sessionId),
                },
                configPath: active.configPath,
                outputDir: active.outputDir,
                // Stamp this GUI session so the assistant's writes share the user's
                // undo/redo stack (the user can undo what they asked it to do).
                sessionId,
                pathname,
                method,
              });
            },
          },
          // ── Clarification questions ──
          // Pending marginal-inference questions surfaced as cards in the chat
          // panel: list / answer / dismiss. Answering executes the deferred
          // action + enrichment writes through the shared mutation chokepoint.
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/questions')) return false;
              return await dispatchQuestionRoute(req, res, {
                db: active.db,
                feed: active.feed,
                softDeletable: active.softDeletable,
                // Stamp this GUI session so answer-driven writes share the
                // user's undo/redo stack (same as the chat route).
                sessionId,
                // Schema-creating answers (a confirmed import link's junction)
                // persist their table definition like the importer does, and
                // register it as servable without a reopen.
                configPath: active.configPath,
                validTables: active.validTables,
                pathname,
                method,
              });
            },
          },
          // ── Ingest routes ──
          // Reference a local file / pasted text as a native `files` row and
          // summarize it. Writes via the shared mutation chokepoint (source=ingest).
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/ingest/')) return false;
              return await dispatchIngestRoute(req, res, {
                db: active.db,
                feed: active.feed,
                softDeletable: active.softDeletable,
                fileJunctions: fileJunctions(active.configPath, active.outputDir),
                entityDescriptions: entityDescriptions(active.configPath, active.outputDir),
                createJunction: (otherTable) => createFileJunction(active, otherTable, sessionId),
                createObjectJunction: (a, b) => createUserJunction(active, a, b, sessionId),
                createEntity: (entity, columns) =>
                  createUserEntity(active, entity, columns, sessionId),
                aggressiveness: getAggressiveness(),

                latticeRoot: dirname(active.configPath),
                configPath: active.configPath,
                outputDir: active.outputDir,
                sessionId,
                pathname,
                method,
              });
            },
          },
          // ── Sources: local file/folder roots for the Sources sidebar ──
          // Local-only (gated by LATTICE_LOCAL_OPEN): register on-disk roots,
          // browse one directory level, and ingest a folder's files via a bounded
          // BFS over the shared ingest core (driving the brain-graph animation).
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/sources/')) return false;
              const ingestCtx = {
                db: active.db,
                feed: active.feed,
                softDeletable: active.softDeletable,
                fileJunctions: fileJunctions(active.configPath, active.outputDir),
                entityDescriptions: entityDescriptions(active.configPath, active.outputDir),
                createJunction: (otherTable: string) =>
                  createFileJunction(active, otherTable, sessionId),
                createObjectJunction: (a: string, b: string) =>
                  createUserJunction(active, a, b, sessionId),
                createEntity: (entity: string, columns: string[]) =>
                  createUserEntity(active, entity, columns, sessionId),
                aggressiveness: getAggressiveness(),
                latticeRoot: dirname(active.configPath),
                configPath: active.configPath,
                outputDir: active.outputDir,
                sessionId,
                pathname,
                method,
              };
              const mctx = ingestMutationCtx(ingestCtx);
              return await dispatchSourcesRoute(req, res, {
                db: active.db,
                ingestFile: (p: string) => ingestLocalFile(ingestCtx, mctx, p, false),
                configPath: active.configPath,
                pathname,
                method,
                feed: active.feed,
              });
            },
          },
          // ── Structured-source import (apply) ──
          // The importer is reachable only via dropping a file in the assistant
          // chat; this materializes the user-confirmed proposal, re-reading the
          // file's bytes from its `fileId` (its retained blob).
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/import/')) return false;
              return await dispatchImportRoute(req, res, {
                db: active.db,
                configPath: active.configPath,
                latticeRoot: dirname(active.configPath),
                validTables: active.validTables,
                softDeletable: active.softDeletable,
                feed: active.feed,
                // Opt-in computed-table proposals create through the same
                // audited op as the builder UI (view DDL + YAML + undo/redo).
                createComputed: (name, def) => createComputedTable(active, name, def, sessionId),
              });
            },
          },
          // ── Connectors: connect/refresh/disconnect external sources ──
          // Connected data types synced from external sources (Jira, …). Sync runs
          // on connect, on manual refresh, and on GUI load (/sync-if-stale).
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/connectors')) return false;
              const ident = readIdentity();
              const fallback = ident.email || ident.display_name || 'local';
              // On a cloud, key connectors on the member's session_user (the role
              // RLS ownership uses) so partitions + ownership agree; else fallback.
              const connectedBy = await resolveConnectorIdentity(active.db, fallback);
              return await dispatchConnectorsRoute(req, res, {
                db: active.db,
                connectors: builtinConnectors(),
                outputDir: active.outputDir,
                connectedBy,
              });
            },
          },
          // ── Databases as an Input: connect/list/refresh/disconnect external DBs ──
          // An external Postgres database imported as a data source. Distinct from
          // /api/databases (sibling Lattice config switching) — see db-sources-routes.
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/db-sources')) return false;
              const ident = readIdentity();
              const fallback = ident.email || ident.display_name || 'local';
              const connectedBy = await resolveConnectorIdentity(active.db, fallback);
              return await dispatchDbSourcesRoute(req, res, {
                db: active.db,
                outputDir: active.outputDir,
                connectedBy,
                feed: active.feed,
              });
            },
          },
          // ── Files: blob serving + open-in-finder ──
          {
            handle: async (req, res) => {
              if (!pathname.startsWith('/api/files/')) return false;
              return await dispatchFilesRoute(req, res, {
                db: active.db,
                latticeRoot: dirname(active.configPath),
                configPath: active.configPath,
                pathname,
                method,
              });
            },
          },
          // ── DB Config routes ──
          // Project Config "Database" panel — read / save / connect / test.
          // The `swap` callback re-opens the active configPath so the
          // YAML rewrite written by `/save` takes effect.
          {
            handle: async (req, res) => {
              if (!(pathname.startsWith('/api/dbconfig') || pathname.startsWith('/api/cloud')))
                return false;
              return await dispatchDbConfigRoute(req, res, {
                db: active.db,
                configPath: active.configPath,
                pathname,
                method,
                convergeWarnings: active.convergeWarnings,
                // Reopen the active config after an in-place edit; join a cloud as a
                // NEW workspace. Both go through the shared closures so the swap is
                // reflected in `activeRef` for the next request (not just the local
                // `active`), and so the same logic serves the virgin onboarding path.
                swap: reopenActive,
                createCloudWorkspace,
              });
            },
          },
        ];

        for (const route of routes) {
          if (await route.handle(req, res, ctx)) return;
        }

        sendJson(res, { error: 'Not found' }, 404);
      } catch (err) {
        // No silent failures. Any unhandled error in a GUI request
        // handler is logged loudly server-side (method, path, stack) BEFORE the
        // 500 goes out, so the real cause survives even when the client only
        // sees a transient toast. Previously this returned the message with no
        // server-side log, making ingest (and other) failures invisible.
        const e = err as Error & { code?: string };
        // Row-level permission denials are expected control flow, not server
        // faults: map them to 404 (hide existence) / 403 (owner-only) by the
        // stable `code`, rather than a 500.
        if (e.code === 'row_access_denied') {
          sendJson(res, { error: 'Row not found' }, 404);
          return;
        }
        if (e.code === 'row_owner_only') {
          sendJson(res, { error: e.message }, 403);
          return;
        }
        // #4.5 — an offline edit that can never replay (row gone / RLS-invisible /
        // write didn't land) is a 409 conflict, not a server fault, so the client
        // marks it failed + surfaces it instead of retrying it forever.
        if (e.code === 'row_write_conflict') {
          sendJson(res, { error: e.message }, 409);
          return;
        }
        console.error(
          `[gui] ${req.method ?? '?'} ${req.url ?? '?'} failed: ${e.message}\n${e.stack ?? ''}`,
        );
        sendJson(res, { error: e.message }, 500);
      }
    })();
  });

  // ── Multiplexed event stream (one WebSocket, replaces three SSE streams) ──
  // A browser tab opens a SINGLE WebSocket to `/api/stream` instead of three
  // long-lived SSE GETs. Every server-pushed event — realtime state/change, the
  // activity feed, and background-render progress — rides this one connection as
  // a typed `{ type, data }` message. WebSocket connections live in a separate,
  // far larger browser pool than HTTP/1.1 requests, so this keeps the entire
  // 6-connections-per-host HTTP budget free for data requests no matter how many
  // tabs are open (three SSE × two tabs used to exhaust it and freeze the GUI).
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast to EVERY connected `/api/stream` client. Update events are global
  // (not workspace-scoped), so they bypass the per-connection `bound` gating that
  // feed/realtime use. Backs the in-process update service's `emit`.
  const broadcast = (type: string, data: unknown): void => {
    const frame = JSON.stringify({ type, data });
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(frame);
      } catch {
        // socket closing — its own close handler tears down
      }
    }
  };

  if (options.updateServiceFactory) {
    updateService = options.updateServiceFactory(broadcast);
  } else if (guiVersion) {
    // Build the service on EVERY surface that knows its version (not only the
    // supervised npm child) so `/api/update/status` reports a real `latest` +
    // `action` — that is what lets the "update available" pill appear on the
    // desktop app and a dev build, where it was previously always invisible. The
    // service only *installs/relaunches* on the supervised npm surface
    // (`selfUpdate`), and does nothing at all when `autoUpdate` is off.
    updateService = createUpdateService({
      currentVersion: guiVersion,
      emit: broadcast,
      autoUpdate,
      selfUpdate: options.selfUpdate ?? false,
      ...(options.updateCheck ? { check: options.updateCheck } : {}),
      ...(options.updateContext ? { context: options.updateContext } : {}),
    });
  }

  // Wire one connection's subscriptions. Bound to the workspace open at connect
  // time (`bound`); a workspace switch flips `activeRef`, after which this socket
  // drops events (the client reconnects, rebinding to the new workspace). All the
  // per-recipient visibility gating, internal-table filtering, and self-echo
  // dedup that the old SSE endpoints did is preserved verbatim.
  const handleEventStream = (ws: WebSocket): void => {
    const bound = activeRef;
    const send = (type: string, data: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type, data }));
      } catch {
        // socket closing — the 'close' handler tears the subscriptions down
      }
    };

    const broker = bound?.realtime ?? null;
    // Initial paint: connection state + the current render snapshot, mirroring
    // what the old realtime/render SSE endpoints replayed on connect.
    send('realtime-state', { mode: broker ? 'cloud' : 'local', state: broker?.state() ?? 'local' });
    if (bound) send('render-snapshot', bound.renderState);

    const offs: (() => void)[] = [];
    if (bound) {
      if (broker) {
        offs.push(
          broker.subscribeState((state) => {
            send('realtime-state', { mode: 'cloud', state });
          }),
        );
        // Realtime row changes — forward only what the connected role may read;
        // strip the editor (owner_role) from deletes (unprobeable post-hoc).
        offs.push(
          broker.subscribePayload((payload) => {
            if (activeRef !== bound) return; // stale after a workspace switch
            void changeVisibleToActiveRole(bound.db, payload).then((visible) => {
              if (!visible) return;
              const out = isDeleteOp(payload.op) ? { ...payload, owner_role: null } : payload;
              send('realtime-change', out);
            });
          }),
        );
      }
      // Activity feed — local mutations from this server, merged with other
      // clients' changes on a shared cloud DB (deduped within a 5s window).
      const recentSelf = new Map<string, number>();
      offs.push(
        bound.feed.subscribe((e) => {
          if (e.table && isFeedHiddenTable(e.table)) return;
          recentSelf.set(`${e.table ?? ''}:${e.rowId ?? ''}:${e.op}`, Date.now());
          // A bulk/multi-row self-change (e.g. the assistant's bulk_update) emits
          // ONE summary with no rowId, but its realtime echo arrives per-row with
          // specific pks that wouldn't match the summary key — so the same change
          // would re-appear as a separate "CLI / another client" card. Record a
          // coarse table+op marker for these so the broker can suppress the echo.
          if (!e.rowId) recentSelf.set(`${e.table ?? ''}::${e.op}`, Date.now());
          send('feed', e);
        }),
      );
      if (broker) {
        offs.push(
          broker.subscribePayload((p) => {
            const op = feedOpForChange(p.op);
            if (!op || !p.table_name || isFeedHiddenTable(p.table_name)) return;
            const tableName = p.table_name;
            const key = `${tableName}:${p.pk ?? ''}:${op}`;
            // Match the exact row key OR the coarse table+op marker a bulk
            // self-change records, so a bulk change's per-row echoes are all
            // recognized as our own and not re-shown as another client.
            const seen = recentSelf.get(key) ?? recentSelf.get(`${tableName}::${op}`);
            if (seen && Date.now() - seen < 5000) return; // our own mutation, already shown
            if (activeRef !== bound) return; // stale after a workspace switch
            void changeVisibleToActiveRole(bound.db, p).then((visible) => {
              if (!visible) return;
              send('feed', {
                seq: p.seq,
                table: tableName,
                op,
                rowId: p.pk,
                source: 'cli',
                actor: isDeleteOp(p.op) ? undefined : (p.owner_role ?? undefined),
                ts: p.created_at || new Date().toISOString(),
                summary: `${op} on ${tableName} (another client)`,
              });
            });
          }),
        );
      }
      // Background-render per-table progress.
      offs.push(
        bound.renderProgress.subscribe((e) => {
          send('render-progress', e);
        }),
      );
      // Chat turn events — the async replacement for the held-open POST response.
      // The bus is per-PROCESS (shared by every socket), so delivery is gated per user:
      // on a cloud workspace one member must NEVER receive another's chat text, and RLS
      // does not help (the app connects BYPASSRLS). `connOwner` resolves asynchronously;
      // until it does (or if it can't) a cloud socket has an unresolved identity and
      // mayReceiveChat fails closed. On a local single-user DB there is no boundary.
      const connIsCloud = isCloudChat(bound.db);
      let connOwner: string | null = null;
      if (connIsCloud) {
        void resolveChatOwnerId(bound.db)
          .then((owner) => {
            connOwner = owner;
          })
          .catch(() => {
            // unresolved → connOwner stays null → mayReceiveChat fails closed
          });
      }
      // Stale-guard on the BUS identity, not the ActiveDb object: a same-config schema
      // reopen (add column / create entity / …) swaps in a fresh ActiveDb but CARRIES the
      // chatProgress bus across (so an in-flight turn keeps streaming), so `activeRef` no
      // longer equals `bound` even though this is still the same workspace + socket. A real
      // workspace SWITCH builds a NEW bus, which this correctly drops.
      const boundBus = bound.chatProgress;
      offs.push(
        bound.chatProgress.subscribe((env) => {
          if (activeRef?.chatProgress !== boundBus) return; // stale after a workspace switch
          if (!mayReceiveChat(connOwner, connIsCloud, env)) return;
          // Forward threadId + messageId so the client can route the event to the right
          // turn's bubble; ownerUserId (the internal cloud login role) is NEVER sent.
          send('chat-progress', {
            threadId: env.threadId,
            messageId: env.messageId,
            event: env.event,
          });
        }),
      );
    }

    // WebSocket has no SSE-style auto-reconnect, so a periodic ping keeps the
    // connection alive through any idle-timeout in the path (the browser answers
    // pongs automatically); the client reconnects with backoff if it ever drops.
    const keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        // socket closing
      }
    }, 25_000);

    const cleanup = (): void => {
      clearInterval(keepalive);
      for (const off of offs) {
        try {
          off();
        } catch {
          // best-effort unsubscribe
        }
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', `http://${host}`);
    // Same guard as mutating HTTP: a cross-site page must not open the realtime
    // change feed (it's readable cross-origin, unlike a fetch response), and a
    // rebound Host must not reach it.
    if (pathname !== '/api/stream' || !requestIsSameOrigin(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleEventStream(ws);
    });
  });

  const port = await listenWithPortFallback(server, startPort, host);
  // listen() removes its bind-failure 'error' listener once 'listening' fires, so from
  // here on the long-lived http.Server would have NO 'error' listener — a rare post-listen
  // socket-level error (e.g. an accept failure on an abruptly invalidated handle) would be
  // a fatal unhandled exception. Defensive: surface it and keep serving.
  server.on('error', (err: Error) => {
    console.warn('[lattice] GUI server error:', err.message);
  });
  // Now the real port is known — arm the CSRF/rebinding guard with the exact Host
  // authorities the server actually answers on.
  boundAuthorities = computeBoundAuthorities(host, port, hostIsLoopback);
  // Now that the server is accepting connections, render the initial workspace's
  // context tree in the background — `/` and `/api/entities` answer instantly
  // while it churns, and a render that finishes before any tab connects is
  // covered by the `render-snapshot` replay on the `/api/stream` WebSocket. No-op
  // when virgin (no workspace open yet — the welcome screen is showing).
  if (activeRef) startBackgroundRender(activeRef);
  // Begin the auto-update poll now that we're listening (no-op unless a
  // supervised child enabled it). The first tick checks immediately.
  updateService?.start();
  // For 0.0.0.0 bindings, advertise via 127.0.0.1 so the printed URL is
  // actually clickable; real external access uses the operator's known
  // hostname/IP, not the bind wildcard.
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${String(port)}`;
  if (options.openBrowser ?? true) openUrl(url);

  return {
    server,
    port,
    url,
    whenConverged: () => activeRef?.converged ?? Promise.resolve(),
    publishChatProgressForTest: (env: ChatProgressEnvelope) => {
      activeRef?.chatProgress.publish(env);
    },
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        // Stop the update poll first so its interval can't fire mid-teardown.
        updateService?.stop();
        // Terminate the multiplexed event-stream sockets first — an open
        // WebSocket would otherwise keep `server.close()` from completing.
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // best-effort
          }
        }
        wss.close();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          void disposeActiveIfAny().then(() => {
            resolveClose();
          });
        });
        // Force-drop lingering keep-alive connections so close() doesn't hang
        // waiting for a browser tab to disconnect.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  };
}
