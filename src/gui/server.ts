import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { dirname, resolve } from 'node:path';
import { sendJson, readJson } from './http.js';
import {
  type ActiveDb,
  changeVisibleToActiveRole,
  isDeleteOp,
  isFeedHiddenTable,
} from './active-db.js';
import { openConfig, startBackgroundRender, disposeActive } from './lifecycle.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  addWorkspace,
  removeWorkspace,
  resolveWorkspacePaths,
} from '../framework/workspace.js';
import { fileJunctions, entityDescriptions } from './data.js';
import { guiAppHtml } from './app.js';
import { feedOpForChange } from './realtime.js';
import { createUpdateService, type UpdateService } from './update-service.js';
import { createGuiRequestContext } from './request-context.js';
import { upsertTableMeta } from './column-descriptions.js';
import {
  createFileJunction,
  createUserJunction,
  createUserEntity,
  aiDeleteEntity,
  type DeleteResolution,
} from './schema-ops.js';
import { dispatchUserConfigRoute } from './userconfig-routes.js';
import { dispatchDbConfigRoute, redeemInvite } from './dbconfig-routes.js';
import { dispatchFilesRoute } from './files-routes.js';
import { dispatchAssistantRoute, getAggressiveness } from './assistant-routes.js';
import { dispatchChatRoute } from './chat-routes.js';
import { dispatchIngestRoute } from './ingest-routes.js';
import { handleReadRoutes, type ReadRoutesDeps } from './read-routes.js';
import { handleTablesRoutes, type TablesRoutesDeps } from './tables-routes.js';
import { handleSchemaRoutes, type SchemaRoutesDeps } from './schema-routes.js';
import { handleHistoryRoutes, type HistoryRoutesDeps } from './history-routes.js';
import { handleWorkspacesRoutes, type WorkspacesRoutesDeps } from './workspaces-routes.js';
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
   * Realtime backstop liveness-poll interval (ms) for the RealtimeBroker. A
   * managed-Postgres proxy (e.g. AWS RDS Proxy) can silently drop the LISTEN
   * without closing the socket; the poll re-delivers missed changes regardless.
   * Omitted ⇒ the broker's default (20s). 0 disables it.
   */
  realtimeWatchdogMs?: number;
  /**
   * Run the in-process auto-update poll: while the GUI is open, check npm for a
   * newer version and, when one lands on an installable copy, install it and
   * exit with the supervisor's restart code so it relaunches on the new version.
   * Set ONLY for a supervised child (`LATTICE_GUI_SUPERVISED=1`) — exiting to
   * apply an update is safe only when a supervisor is there to respawn it.
   * `GET /api/version` + `GET /api/update/status` are served regardless.
   */
  selfUpdate?: boolean;
}

export interface GuiServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
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

function openUrl(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
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
  const autoRender = options.autoRender ?? false;
  const guiVersion = options.version ?? '';
  // One id per GUI server process. Stamped on every audit entry so the header
  // undo/redo stack is scoped to THIS session's own actions (you undo what you
  // did, not another cloud user's edit). The per-entry Revert stays global.
  const sessionId = crypto.randomUUID();

  // Auto-update poll (supervised child only). Created after the WebSocket server
  // exists (so it can broadcast), started after the socket is listening, stopped
  // on close. The request handler reads it for `/api/update/status`.
  let updateService: UpdateService | null = null;

  // Mutable reference: switching DBs replaces this wholesale; NULL in the virgin
  // (zero-workspace) state until the first workspace is created or joined. The
  // request handler gates every data route behind a non-null check.
  let activeRef: ActiveDb | null =
    bootConfigPath && bootOutputDir
      ? await openConfig(bootConfigPath, bootOutputDir, autoRender, options.realtimeWatchdogMs)
      : null;
  // Discover the `.lattice` root (if the GUI was opened inside a workspace) so
  // the header workspace switcher can list + switch workspaces. `null` ⇒ the
  // GUI was opened on a plain config; the switcher stays hidden. In the virgin
  // state the root comes from the options (there's no config to discover from).
  const latticeRoot =
    (bootConfigPath ? findLatticeRoot(dirname(bootConfigPath)) : null) ??
    (options.latticeRoot ? resolve(options.latticeRoot) : null);
  // Which workspace is ACTUALLY being served (the open `active` DB). The header
  // switcher must reflect THIS, not the registry's stored activeWorkspaceId —
  // the two can drift apart (e.g. a relaunch whose --config points at a
  // different workspace than the last-switched one), which showed the wrong
  // workspace label sitting over a different workspace's data. Match the
  // launched config to its workspace and reconcile the registry to it at boot.
  let currentWorkspaceId: string | null = null;
  if (latticeRoot && bootConfigPath) {
    const launched = listWorkspaces(latticeRoot).find(
      (w) => resolve(resolveWorkspacePaths(latticeRoot, w).configPath) === resolve(bootConfigPath),
    );
    if (launched) {
      currentWorkspaceId = launched.id;
      if (getActiveWorkspace(latticeRoot)?.id !== launched.id) {
        setActiveWorkspace(latticeRoot, launched.id);
      }
    } else {
      currentWorkspaceId = getActiveWorkspace(latticeRoot)?.id ?? null;
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
      sendText(
        res,
        guiAppHtml.replace('<!--LATTICE_VERSION-->', guiVersion ? `v${guiVersion}` : ''),
        200,
        'text/html; charset=utf-8',
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
  const readDeps: ReadRoutesDeps = { host, guiVersion, guiAppHtml, sendText };
  const tablesDeps: TablesRoutesDeps = { host };
  const schemaDeps: SchemaRoutesDeps = { host, autoRender };
  const historyDeps: HistoryRoutesDeps = { host, autoRender };
  const workspacesDeps: WorkspacesRoutesDeps = { host, latticeRoot, autoRender };
  const databasesDeps: DatabasesRoutesDeps = { host, autoRender };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // Version + update status — answered in BOTH virgin and active states, and
        // independent of any workspace. The browser polls `/api/version` on each
        // `/api/stream` reconnect; a value newer than the page it loaded means the
        // server relaunched onto a new build, so the tab reloads itself.
        if (method === 'GET' && pathname === '/api/version') {
          sendJson(res, { version: guiVersion });
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
              checking: false,
              installing: false,
              lastError: null,
            },
          );
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

        // ── HTML + read-only data routes ──────────────────────────────────
        if (await handleReadRoutes(req, res, ctx, readDeps)) return;

        // Realtime change events, the activity feed, and background-render
        // progress are no longer three separate Server-Sent-Event streams. They
        // are multiplexed onto ONE WebSocket (`/api/stream`, handled via the HTTP
        // `upgrade` path below) so a browser tab holds a single persistent
        // connection instead of three. Three SSE streams per tab consumed the
        // whole HTTP/1.1 6-connections-per-host budget after just two tabs, which
        // starved every data request (entities/rows/switch) and froze the UI; a
        // WebSocket lives in a separate, far larger connection pool, so data
        // requests always keep the full HTTP budget free. See `handleEventStream`.

        // ── Schema create/alter/delete (extracted leaf — schema-routes.ts) ──
        if (await handleSchemaRoutes(req, res, ctx, schemaDeps)) return;

        // ── Version history: undo / redo / revert (extracted leaf — history-routes.ts) ──
        if (await handleHistoryRoutes(req, res, ctx, historyDeps)) return;

        // ── Workspaces: list / switch / create / delete (extracted leaf — workspaces-routes.ts) ──
        if (await handleWorkspacesRoutes(req, res, ctx, workspacesDeps)) return;

        // ── Databases: list / switch / create / delete (extracted leaf — databases-routes.ts) ──
        if (await handleDatabasesRoutes(req, res, ctx, databasesDeps)) return;

        // ── GUI-only metadata (per-entity icon overrides) ─────────────────
        if (method === 'PUT' && pathname.startsWith('/api/gui-meta/')) {
          const entityName = decodeURIComponent(pathname.slice('/api/gui-meta/'.length));
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown table: ${entityName}` }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { icon?: unknown; description?: unknown };
          const settingIcon = 'icon' in body;
          const settingDescription = 'description' in body;
          if (settingIcon && typeof body.icon !== 'string') {
            sendJson(res, { error: 'icon must be a string' }, 400);
            return;
          }
          if (!settingIcon && !settingDescription) {
            sendJson(res, { error: 'nothing to update (expected icon or description)' }, 400);
            return;
          }
          // Consolidated find-or-insert, shared with the set_definition AI tool.
          await upsertTableMeta(active.db, entityName, {
            ...(settingIcon ? { icon: body.icon as string } : {}),
            ...(settingDescription
              ? { description: typeof body.description === 'string' ? body.description : null }
              : {}),
          });
          sendJson(res, { ok: true });
          return;
        }

        // ── Row CRUD + junction link/unlink (extracted leaf — tables-routes.ts) ──
        if (await handleTablesRoutes(req, res, ctx, tablesDeps)) return;

        // ── User Config routes ───────────────────────────────────────────
        // Reads + writes machine-local user identity and the saved
        // cloud-DB credential catalog. Localhost-trust dev-tool routes.
        if (pathname.startsWith('/api/userconfig/')) {
          const handled = await dispatchUserConfigRoute(req, res, {
            db: active.db,
            configPath: active.configPath,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── AI assistant: credentials, OAuth, voice transcription ─────────
        // Local-only: the assistant rail is a single-user dev tool.
        // Subscription OAuth stays inert until ANTHROPIC_OAUTH_* is set.
        if (pathname.startsWith('/api/assistant/')) {
          const handled = await dispatchAssistantRoute(req, res, {
            db: active.db,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── Chat route ────────────────────────────────────────────────────
        // POST /api/chat — assistant tool loop, streamed as SSE. Executes
        // tool calls against the active DB via the shared mutation chokepoint.
        if (pathname.startsWith('/api/chat')) {
          const handled = await dispatchChatRoute(req, res, {
            db: active.db,
            feed: active.feed,
            validTables: active.validTables,
            junctionTables: active.junctionTables,
            softDeletable: active.softDeletable,
            // The assistant can create tables + relationships on request — same
            // audited, no-reopen primitives the Context Constructor uses.
            createEntity: (name, columns) => createUserEntity(active, name, columns, sessionId),
            createJunction: (a, b) => createUserJunction(active, a, b, sessionId),
            // Guarded, reversible table delete — empty tables go immediately;
            // non-empty ones come back as `needsResolution` so the assistant asks.
            deleteEntity: (name: string, resolution?: DeleteResolution) =>
              aiDeleteEntity(active, name, resolution, sessionId),
            configPath: active.configPath,
            outputDir: active.outputDir,
            // Stamp this GUI session so the assistant's writes share the user's
            // undo/redo stack (the user can undo what they asked it to do).
            sessionId,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── Ingest routes ─────────────────────────────────────────────────
        // Reference a local file / pasted text as a native `files` row and
        // summarize it. Writes via the shared mutation chokepoint (source=ingest).
        if (pathname.startsWith('/api/ingest/')) {
          const handled = await dispatchIngestRoute(req, res, {
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            fileJunctions: fileJunctions(active.configPath, active.outputDir),
            entityDescriptions: entityDescriptions(active.configPath, active.outputDir),
            createJunction: (otherTable) => createFileJunction(active, otherTable, sessionId),
            createEntity: (entity, columns) => createUserEntity(active, entity, columns, sessionId),
            aggressiveness: getAggressiveness(),

            latticeRoot: dirname(active.configPath),
            configPath: active.configPath,
            outputDir: active.outputDir,
            sessionId,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── Files: blob serving + open-in-finder ──────────────────────────
        if (pathname.startsWith('/api/files/')) {
          const handled = await dispatchFilesRoute(req, res, {
            db: active.db,
            latticeRoot: dirname(active.configPath),
            configPath: active.configPath,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── DB Config routes ─────────────────────────────────────────────
        // Project Config "Database" panel — read / save / connect / test.
        // The `swap` callback re-opens the active configPath so the
        // YAML rewrite written by `/save` takes effect.
        if (pathname.startsWith('/api/dbconfig') || pathname.startsWith('/api/cloud')) {
          const handled = await dispatchDbConfigRoute(req, res, {
            db: active.db,
            configPath: active.configPath,
            pathname,
            method,
            // Reopen the active config after an in-place edit; join a cloud as a
            // NEW workspace. Both go through the shared closures so the swap is
            // reflected in `activeRef` for the next request (not just the local
            // `active`), and so the same logic serves the virgin onboarding path.
            swap: reopenActive,
            createCloudWorkspace,
          });
          if (handled) return;
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

  if (options.selfUpdate && guiVersion) {
    updateService = createUpdateService({ currentVersion: guiVersion, emit: broadcast });
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
            const seen = recentSelf.get(key);
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
    if (pathname !== '/api/stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleEventStream(ws);
    });
  });

  const port = await listenWithPortFallback(server, startPort, host);
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
