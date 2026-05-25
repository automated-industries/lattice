import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Lattice } from '../lattice.js';
import { parseConfigFile } from '../config/parser.js';
import {
  buildGuiGraph,
  getGuiEntities,
  getGuiProject,
  isJunctionTable,
  type GuiEntitiesPayload,
} from './data.js';
import { guiAppHtml } from './app.js';
import type { Row } from '../types.js';

export interface StartGuiServerOptions {
  configPath: string;
  outputDir: string;
  port?: number;
  openBrowser?: boolean;
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

function listen(server: Server, port: number): Promise<number> {
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
    server.listen(port, '127.0.0.1');
  });
}

async function listenWithPortFallback(server: Server, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 50; port++) {
    try {
      return await listen(server, port);
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
    payload.tables.map(async (t) => ({ ...t, rowCount: await db.count(t.name) })),
  );
  return { ...payload, tables: enrichedTables };
}

const ROWS_PATH = /^\/api\/tables\/([^/]+)\/rows(?:\/(.+))?$/;
const LINK_PATH = /^\/api\/tables\/([^/]+)\/(link|unlink)$/;

export async function startGuiServer(options: StartGuiServerOptions): Promise<GuiServerHandle> {
  const configPath = resolve(options.configPath);
  const outputDir = resolve(options.outputDir);
  const startPort = options.port ?? 4317;

  // Ensure the DB's parent dir exists before opening — SQLiteAdapter does not
  // create it. parseConfigFile already resolves db: to an absolute path.
  const parsed = parseConfigFile(configPath);
  mkdirSync(dirname(parsed.dbPath), { recursive: true });

  const db = new Lattice({ config: configPath });
  await db.init();

  // Look up which tables actually exist in the config (and which are junctions)
  // so the CRUD routes can reject unknown tables loudly.
  const validTables = new Set(parsed.tables.map((t) => t.name));
  const junctionTables = new Set(
    getGuiEntities(configPath, outputDir)
      .tables.filter(isJunctionTable)
      .map((t) => t.name),
  );

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // ── HTML + read-only data routes ──────────────────────────────────
        if (method === 'GET' && pathname === '/') {
          sendText(res, guiAppHtml, 200, 'text/html; charset=utf-8');
          return;
        }
        if (method === 'GET' && pathname === '/api/project') {
          sendJson(res, getGuiProject(configPath, outputDir));
          return;
        }
        if (method === 'GET' && pathname === '/api/entities') {
          sendJson(res, await entitiesWithCounts(db, configPath, outputDir));
          return;
        }
        if (method === 'GET' && pathname === '/api/graph') {
          sendJson(res, buildGuiGraph(configPath, outputDir));
          return;
        }

        // ── Row CRUD: /api/tables/:table/rows[/:id] ───────────────────────
        const rowsMatch = ROWS_PATH.exec(pathname);
        if (rowsMatch) {
          const [, rawTable, rawId] = rowsMatch;
          const table = decodeURIComponent(rawTable ?? '');
          const id = rawId ? decodeURIComponent(rawId) : null;
          if (!validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }

          if (id === null) {
            if (method === 'GET') {
              const limit = Number(url.searchParams.get('limit') ?? '500');
              const offset = Number(url.searchParams.get('offset') ?? '0');
              const rows = await db.query(table, { limit, offset });
              sendJson(res, { rows });
              return;
            }
            if (method === 'POST') {
              const body = (await readJsonBody(req)) as Row;
              const newId = await db.insert(table, body);
              sendJson(res, { id: newId }, 201);
              return;
            }
          } else {
            if (method === 'GET') {
              const row = await db.get(table, id);
              if (row === null) {
                sendJson(res, { error: 'Row not found' }, 404);
                return;
              }
              sendJson(res, row);
              return;
            }
            if (method === 'PATCH') {
              const body = (await readJsonBody(req)) as Partial<Row>;
              await db.update(table, id, body);
              sendJson(res, { ok: true });
              return;
            }
            if (method === 'DELETE') {
              await db.delete(table, id);
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
          if (!junctionTables.has(table)) {
            sendJson(res, { error: `Not a junction table: ${table}` }, 400);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, { error: `Method ${method} not allowed` }, 405);
            return;
          }
          const body = (await readJsonBody(req)) as Row;
          if (op === 'link') {
            await db.link(table, body);
          } else {
            await db.unlink(table, body);
          }
          sendJson(res, { ok: true });
          return;
        }

        sendJson(res, { error: 'Not found' }, 404);
      } catch (err) {
        sendJson(res, { error: (err as Error).message }, 500);
      }
    })();
  });

  const port = await listenWithPortFallback(server, startPort);
  const url = `http://127.0.0.1:${String(port)}`;
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
          db.close();
          resolveClose();
        });
      }),
  };
}
