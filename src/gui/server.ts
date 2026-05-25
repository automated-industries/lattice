import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Lattice } from '../lattice.js';
import { parseConfigFile } from '../config/parser.js';
import type { EntityContextDefinition } from '../schema/entity-context.js';
import {
  buildGuiGraph,
  getGuiEntities,
  getGuiProject,
  isJunctionTable,
  type GuiEntitiesPayload,
} from './data.js';
import { guiAppHtml } from './app.js';
import type { Row } from '../types.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from '../teams/internal-tables.js';
import { authenticate, type AuthContext } from '../teams/server/auth.js';
import { dispatchTeamRoute, UNAUTHENTICATED_TEAM_PATHS } from '../teams/server/routes.js';
import { TeamsClient } from '../teams/client.js';
import { dispatchTeamsGuiRoute } from './teams-routes.js';

export interface StartGuiServerOptions {
  configPath: string;
  outputDir: string;
  port?: number;
  openBrowser?: boolean;
  /**
   * Bind address. Defaults to `127.0.0.1`. Use `0.0.0.0` (or a specific
   * interface) to expose the server outside localhost — only meaningful in
   * combination with `teamCloud: true`, which adds the auth layer.
   */
  host?: string;
  /**
   * Enable team-cloud server mode: registers the Lattice Teams internal
   * tables via `defineLate()` after init, and requires a valid bearer
   * token on every API request. The DB-switcher endpoints are disabled
   * (they assume single-user filesystem trust).
   */
  teamCloud?: boolean;
}

export interface GuiServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${(e as Error).message}`));
      }
    });
    req.on('error', reject);
  });
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

/**
 * Augment the entities payload with row counts so the dashboard cards can
 * show "Meetings · 4" without a second round-trip. Junction tables get a
 * count too — the Data Model UI uses them, even though the Objects sidebar
 * filters them out.
 */
async function entitiesWithCounts(
  db: Lattice,
  configPath: string,
  outputDir: string,
): Promise<GuiEntitiesPayload> {
  const payload = getGuiEntities(configPath, outputDir);
  const enrichedTables = await Promise.all(
    payload.tables.map(async (t) => {
      // Only count live rows when the table has a `deleted_at` column.
      const rowCount = t.columns.includes('deleted_at')
        ? await db.count(t.name, { filters: [{ col: 'deleted_at', op: 'isNull' }] })
        : await db.count(t.name);
      return { ...t, rowCount };
    }),
  );
  return { ...payload, tables: enrichedTables };
}

const ROWS_PATH = /^\/api\/tables\/([^/]+)\/rows(?:\/(.+))?$/;
const CONTEXT_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/context$/;
const LINK_PATH = /^\/api\/tables\/([^/]+)\/(link|unlink)$/;

interface ContextFile {
  name: string;
  path: string;
  content: string;
}

/**
 * Read the Lattice-rendered context files for a single row. Returns the
 * declared files for the row's entity context (relative to `outputDir`),
 * with their content if they exist on disk. Files that haven't been
 * rendered yet come back with `content: ''` and `exists: false`-equivalent
 * (empty content; caller can infer from `path`).
 */
function readRowContext(
  outputDir: string,
  def: EntityContextDefinition,
  row: Record<string, unknown>,
): ContextFile[] {
  const slug = def.slug(row);
  const directoryRoot = def.directoryRoot ?? '';
  const entityDir = resolve(outputDir, directoryRoot, slug);
  // Defence in depth: the slug must not escape outputDir.
  const resolvedBase = resolve(outputDir);
  if (entityDir !== resolvedBase && !entityDir.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal detected: slug "${slug}" escapes output directory`);
  }
  return Object.keys(def.files).map((filename) => {
    const absPath = join(entityDir, filename);
    const relPath = join(directoryRoot, slug, filename);
    if (!existsSync(absPath)) return { name: filename, path: relPath, content: '' };
    return { name: filename, path: relPath, content: readFileSync(absPath, 'utf8') };
  });
}

/** Everything tied to a single open lattice config / DB. Swapped wholesale when the user picks a different DB. */
interface ActiveDb {
  configPath: string;
  outputDir: string;
  db: Lattice;
  validTables: Set<string>;
  junctionTables: Set<string>;
  entityContextByTable: Map<string, EntityContextDefinition>;
  softDeletable: Set<string>;
  /**
   * Cached `TeamsClient` so sync write-hooks registered via
   * `attachWriteHooks` persist across requests. Reuses the same Lattice
   * instance the GUI's CRUD endpoints write through, so a row update
   * via the GUI dashboard fires the same outbox-capture hook as a
   * write from outside.
   */
  teamsClient: TeamsClient;
}

async function openConfig(configPath: string, outputDir: string): Promise<ActiveDb> {
  const parsed = parseConfigFile(configPath);
  mkdirSync(dirname(parsed.dbPath), { recursive: true });
  const db = new Lattice({ config: configPath });
  // GUI-only meta table: per-entity icon overrides edited from the browser.
  // Defined dynamically (not in the user's YAML) so it never appears in
  // /api/entities or any user-facing list.
  db.define('_lattice_gui_meta', {
    columns: {
      entity_name: 'TEXT PRIMARY KEY',
      icon: 'TEXT',
      updated_at: "TEXT DEFAULT (datetime('now'))",
    },
    primaryKey: 'entity_name',
    render: () => '',
    outputFile: '.lattice-gui/meta.md',
  });
  await db.init();

  const validTables = new Set(parsed.tables.map((t) => t.name));
  const junctionTables = new Set(
    getGuiEntities(configPath, outputDir)
      .tables.filter(isJunctionTable)
      .map((t) => t.name),
  );
  const entityContextByTable = new Map<string, EntityContextDefinition>();
  for (const { table, definition } of parsed.entityContexts) {
    entityContextByTable.set(table, definition);
  }
  const softDeletable = new Set(
    parsed.tables
      .filter(({ definition }) => 'deleted_at' in definition.columns)
      .map(({ name }) => name),
  );
  const teamsClient = new TeamsClient(db);
  // Re-arm sync write-hooks for any tables that already have local
  // links (i.e. the user is part of teams + linked rows in a prior
  // session). Idempotent — safe to call on every openConfig.
  await teamsClient.attachWriteHooks();
  return {
    configPath,
    outputDir,
    db,
    teamsClient,
    validTables,
    junctionTables,
    entityContextByTable,
    softDeletable,
  };
}

/**
 * List sibling YAML configs in the same directory as the currently active
 * config. Each entry includes the parsed `db:` value when available so the
 * UI can show the underlying DB filename.
 */
function listConfigs(
  activeConfigPath: string,
): { path: string; name: string; dbFile: string; active: boolean }[] {
  const dir = dirname(activeConfigPath);
  const entries: { path: string; name: string; dbFile: string; active: boolean }[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
    const full = join(dir, fname);
    try {
      const parsed = parseConfigFile(full);
      entries.push({
        path: full,
        name: fname.replace(/\.(ya?ml)$/, ''),
        dbFile: basename(parsed.dbPath),
        active: full === activeConfigPath,
      });
    } catch {
      // Not a valid lattice config — skip silently.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write a starter YAML config + an empty SQLite DB. The schema is minimal —
 * one example `items` entity — so the user has something to play with
 * immediately. They can edit the YAML directly to add more entities.
 */
function createBlankConfig(activeConfigPath: string, dbName: string): string {
  const dir = dirname(activeConfigPath);
  // Slug the user-provided name into a safe filename.
  const slug = dbName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Database name must contain at least one alphanumeric character');
  const configPath = join(dir, `${slug}.config.yml`);
  if (existsSync(configPath)) throw new Error(`Config already exists: ${slug}.config.yml`);
  const yaml = `db: ./data/${slug}.db\n\nentities:\n  items:\n    fields:\n      id: { type: uuid, primaryKey: true }\n      name: { type: text, required: true }\n      notes: { type: text }\n      deleted_at: { type: text }\n    outputFile: ITEMS.md\n`;
  writeFileSync(configPath, yaml, 'utf8');
  // Ensure the data dir exists so opening the new config doesn't fail.
  mkdirSync(join(dir, 'data'), { recursive: true });
  return configPath;
}

async function registerTeamCloudTables(db: Lattice): Promise<void> {
  for (const [name, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(name, def);
  }
}

type RequestWithAuth = IncomingMessage & { authContext?: AuthContext };

export async function startGuiServer(options: StartGuiServerOptions): Promise<GuiServerHandle> {
  const configPath = resolve(options.configPath);
  const outputDir = resolve(options.outputDir);
  const startPort = options.port ?? 4317;
  const host = options.host ?? '127.0.0.1';
  const teamCloud = options.teamCloud ?? false;

  // Mutable reference: switching DBs replaces this wholesale.
  let active: ActiveDb = await openConfig(configPath, outputDir);
  if (teamCloud) {
    await registerTeamCloudTables(active.db);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // ── Team-cloud auth gate ──────────────────────────────────────────
        // Most routes require a valid bearer token. A small allowlist of
        // bootstrap/redemption endpoints (defined in routes.ts) is exempt
        // so a new operator can register and invitees can redeem invites
        // before they have a token.
        let authContext: AuthContext | null = null;
        if (teamCloud) {
          if (!UNAUTHENTICATED_TEAM_PATHS.has(pathname)) {
            authContext = await authenticate(req, active.db);
            if (!authContext) {
              sendJson(res, { error: 'Unauthorized' }, 401);
              return;
            }
            (req as RequestWithAuth).authContext = authContext;
          }
        }

        // ── Team-cloud route dispatch ─────────────────────────────────────
        if (teamCloud) {
          const handled = await dispatchTeamRoute(req, res, {
            db: active.db,
            authContext,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── HTML + read-only data routes ──────────────────────────────────
        if (method === 'GET' && pathname === '/') {
          sendText(res, guiAppHtml, 200, 'text/html; charset=utf-8');
          return;
        }
        if (method === 'GET' && pathname === '/api/project') {
          sendJson(res, getGuiProject(active.configPath, active.outputDir));
          return;
        }
        if (method === 'GET' && pathname === '/api/entities') {
          sendJson(res, await entitiesWithCounts(active.db, active.configPath, active.outputDir));
          return;
        }
        if (method === 'GET' && pathname === '/api/graph') {
          sendJson(res, buildGuiGraph(active.configPath, active.outputDir));
          return;
        }

        // ── Database switcher ─────────────────────────────────────────────
        // Disabled in team-cloud mode — switching the active DB out from
        // under other members would corrupt their session view and bypass
        // the team's auth + share contract.
        if (teamCloud && pathname.startsWith('/api/databases')) {
          sendJson(res, { error: 'Database switching is disabled in team-cloud mode' }, 403);
          return;
        }
        if (method === 'GET' && pathname === '/api/databases') {
          sendJson(res, {
            current: {
              path: active.configPath,
              dbFile: basename(parseConfigFile(active.configPath).dbPath),
            },
            configs: listConfigs(active.configPath),
          });
          return;
        }
        if (method === 'POST' && pathname === '/api/databases/switch') {
          const body = (await readJsonBody(req)) as { path?: unknown };
          if (typeof body.path !== 'string') {
            sendJson(res, { error: 'path must be a string' }, 400);
            return;
          }
          const newPath = resolve(body.path);
          if (!existsSync(newPath)) {
            sendJson(res, { error: `Config not found: ${newPath}` }, 400);
            return;
          }
          // Try to open the new config first; only swap once it succeeds so a
          // bad config doesn't leave the server with no active DB.
          const next = await openConfig(newPath, active.outputDir);
          active.db.close();
          active = next;
          sendJson(res, { ok: true, path: active.configPath });
          return;
        }
        if (method === 'POST' && pathname === '/api/databases/create') {
          const body = (await readJsonBody(req)) as { name?: unknown };
          if (typeof body.name !== 'string' || !body.name.trim()) {
            sendJson(res, { error: 'name must be a non-empty string' }, 400);
            return;
          }
          const newConfigPath = createBlankConfig(active.configPath, body.name.trim());
          const next = await openConfig(newConfigPath, active.outputDir);
          active.db.close();
          active = next;
          sendJson(res, { ok: true, path: active.configPath });
          return;
        }

        // ── GUI-only metadata (per-entity icon overrides) ─────────────────
        if (method === 'GET' && pathname === '/api/gui-meta') {
          const rows = (await active.db.query('_lattice_gui_meta', {})) as {
            entity_name: string;
            icon: string | null;
          }[];
          const out: Record<string, { icon: string }> = {};
          for (const r of rows) {
            if (r.icon) out[r.entity_name] = { icon: r.icon };
          }
          sendJson(res, out);
          return;
        }
        if (method === 'PUT' && pathname.startsWith('/api/gui-meta/')) {
          const entityName = decodeURIComponent(pathname.slice('/api/gui-meta/'.length));
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown table: ${entityName}` }, 400);
            return;
          }
          const body = (await readJsonBody(req)) as { icon?: unknown };
          if (typeof body.icon !== 'string') {
            sendJson(res, { error: 'icon must be a string' }, 400);
            return;
          }
          const existing = await active.db.get('_lattice_gui_meta', entityName);
          if (existing) {
            await active.db.update('_lattice_gui_meta', entityName, {
              icon: body.icon,
              updated_at: new Date().toISOString(),
            });
          } else {
            await active.db.insert('_lattice_gui_meta', {
              entity_name: entityName,
              icon: body.icon,
              updated_at: new Date().toISOString(),
            });
          }
          sendJson(res, { ok: true });
          return;
        }

        // ── Row context: /api/tables/:table/rows/:id/context ──────────────
        const ctxMatch = CONTEXT_PATH.exec(pathname);
        if (ctxMatch) {
          const [, rawCtxTable, rawCtxId] = ctxMatch;
          const ctxTable = decodeURIComponent(rawCtxTable ?? '');
          const ctxId = decodeURIComponent(rawCtxId ?? '');
          if (method !== 'GET') {
            sendJson(res, { error: `Method ${method} not allowed` }, 405);
            return;
          }
          if (!active.validTables.has(ctxTable)) {
            sendJson(res, { error: `Unknown table: ${ctxTable}` }, 400);
            return;
          }
          const def = active.entityContextByTable.get(ctxTable);
          if (!def) {
            sendJson(res, { files: [] });
            return;
          }
          const row = await active.db.get(ctxTable, ctxId);
          if (row === null) {
            sendJson(res, { error: 'Row not found' }, 404);
            return;
          }
          sendJson(res, { files: readRowContext(active.outputDir, def, row) });
          return;
        }

        // ── Row CRUD: /api/tables/:table/rows[/:id] ───────────────────────
        const rowsMatch = ROWS_PATH.exec(pathname);
        if (rowsMatch) {
          const [, rawTable, rawId] = rowsMatch;
          const table = decodeURIComponent(rawTable ?? '');
          const id = rawId ? decodeURIComponent(rawId) : null;
          if (!active.validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }

          if (id === null) {
            if (method === 'GET') {
              const limit = Number(url.searchParams.get('limit') ?? '500');
              const offset = Number(url.searchParams.get('offset') ?? '0');
              const deletedMode = url.searchParams.get('deleted');
              const queryOpts: Parameters<typeof active.db.query>[1] = { limit, offset };
              if (active.softDeletable.has(table) && deletedMode !== 'any') {
                queryOpts.filters = [
                  { col: 'deleted_at', op: deletedMode === 'only' ? 'isNotNull' : 'isNull' },
                ];
              }
              const rows = await active.db.query(table, queryOpts);
              sendJson(res, { rows });
              return;
            }
            if (method === 'POST') {
              const body = (await readJsonBody(req)) as Row;
              const newId = await active.db.insert(table, body);
              sendJson(res, { id: newId }, 201);
              return;
            }
          } else {
            if (method === 'GET') {
              const row = await active.db.get(table, id);
              if (row === null) {
                sendJson(res, { error: 'Row not found' }, 404);
                return;
              }
              sendJson(res, row);
              return;
            }
            if (method === 'PATCH') {
              const body = (await readJsonBody(req)) as Partial<Row>;
              await active.db.update(table, id, body);
              sendJson(res, { ok: true });
              return;
            }
            if (method === 'DELETE') {
              const hard = url.searchParams.get('hard') === 'true';
              if (!hard && active.softDeletable.has(table)) {
                await active.db.update(table, id, { deleted_at: new Date().toISOString() });
              } else {
                await active.db.delete(table, id);
              }
              sendJson(res, { ok: true });
              return;
            }
          }
          sendJson(res, { error: `Method ${method} not allowed` }, 405);
          return;
        }

        // ── Junction link / unlink: /api/tables/:table/(link|unlink) ───────
        const linkMatch = LINK_PATH.exec(pathname);
        if (linkMatch) {
          const [, rawTable, op] = linkMatch;
          const table = decodeURIComponent(rawTable ?? '');
          if (!active.junctionTables.has(table)) {
            sendJson(res, { error: `Not a junction table: ${table}` }, 400);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, { error: `Method ${method} not allowed` }, 405);
            return;
          }
          const body = (await readJsonBody(req)) as Row;
          if (op === 'link') {
            await active.db.link(table, body);
          } else {
            await active.db.unlink(table, body);
          }
          sendJson(res, { ok: true });
          return;
        }

        // ── Teams GUI routes ──────────────────────────────────────────────
        // Dev-tool surface that wraps the user's TeamsClient. Available
        // only in local GUI mode — team-cloud mode disables these (the
        // cloud is the server, not the client).
        if (!teamCloud && pathname.startsWith('/api/teams-gui/')) {
          const handled = await dispatchTeamsGuiRoute(req, res, {
            db: active.db,
            client: active.teamsClient,
            pathname,
            method,
            validTables: active.validTables,
          });
          if (handled) return;
        }

        sendJson(res, { error: 'Not found' }, 404);
      } catch (err) {
        sendJson(res, { error: (err as Error).message }, 500);
      }
    })();
  });

  const port = await listenWithPortFallback(server, startPort, host);
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
      new Promise((resolveClose, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          active.db.close();
          resolveClose();
        });
      }),
  };
}
