import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  buildGuiGraph,
  getGuiEntities,
  getGuiEntityFiles,
  getGuiProject,
  previewDroppedFile,
} from './graph.js';
import { guiAppHtml } from './app.js';

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      resolveBody(body);
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

export async function startGuiServer(options: StartGuiServerOptions): Promise<GuiServerHandle> {
  const configPath = resolve(options.configPath);
  const outputDir = resolve(options.outputDir);
  const startPort = options.port ?? 4317;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/') {
          sendText(res, guiAppHtml, 200, 'text/html; charset=utf-8');
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/project') {
          sendJson(res, getGuiProject(configPath, outputDir));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/entities') {
          sendJson(res, getGuiEntities(configPath, outputDir));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/graph') {
          sendJson(res, buildGuiGraph(configPath, outputDir));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/files') {
          const table = url.searchParams.get('entity');
          const slug = url.searchParams.get('slug');
          if (!table || !slug) {
            sendJson(res, { error: 'Missing entity or slug query parameter' }, 400);
            return;
          }
          sendJson(res, getGuiEntityFiles(configPath, outputDir, table, slug));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/drop') {
          const parsed = JSON.parse(await readBody(req)) as {
            name?: unknown;
            content?: unknown;
            size?: unknown;
          };
          if (typeof parsed.name !== 'string') {
            sendJson(res, { error: 'Dropped file requires a name' }, 400);
            return;
          }
          sendJson(
            res,
            previewDroppedFile({
              name: parsed.name,
              ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
              ...(typeof parsed.size === 'number' ? { size: parsed.size } : {}),
            }),
          );
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
          resolveClose();
        });
      }),
  };
}
