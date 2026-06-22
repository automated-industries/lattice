import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { sendJson, readJson } from './http.js';
import {
  resolveDashboard,
  getConnectedDashboard,
  setConnectedDashboard,
} from '../connect/dashboard.js';

/**
 * Connect-a-dashboard routes. The GUI server is a thin ordered dispatcher; this
 * module is the connect feature's slice of it, invoked BEFORE the virgin gate so
 * the dashboard serves (and the control plane answers) even with no active
 * workspace. {@link createConnectRouter} owns the connected-dashboard state for
 * the server's lifetime; {@link ConnectRouter.handle} returns true when it
 * handled the request (caller short-circuits), false to fall through to the
 * normal routes.
 */

function sendText(
  res: ServerResponse,
  body: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/** Content types for a "bring your own dashboard" folder's static assets. */
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res: ServerResponse, absPath: string): void {
  const body = readFileSync(absPath);
  const type = STATIC_MIME[extname(absPath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// A small always-on "back to Lattice" pill injected into a CONNECTED dashboard's
// HTML so the admin shell (moved to `/lattice` when a dashboard takes over `/`)
// is never a dead end. Fixed, semi-transparent, inline-styled (no collision with
// the dashboard's own CSS), highest z-index. HTML only — never on JS/CSS/images.
const LATTICE_BADGE =
  '<a href="/lattice" title="Back to Lattice" ' +
  'style="position:fixed;bottom:14px;right:14px;z-index:2147483647;' +
  'font:600 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
  'color:#fff;background:rgba(18,22,27,.74);border:1px solid rgba(255,255,255,.2);' +
  'border-radius:999px;padding:8px 13px;text-decoration:none;-webkit-backdrop-filter:blur(6px);' +
  'backdrop-filter:blur(6px);box-shadow:0 2px 10px rgba(0,0,0,.25);opacity:.6;' +
  'transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">' +
  '↩ Lattice</a>';

/** Serve a connected-dashboard file. HTML gets the {@link LATTICE_BADGE} injected
 *  (so the user can always get back to `/lattice`); other assets are sent as-is. */
function sendDashboardFile(res: ServerResponse, absPath: string): void {
  if (!/\.html?$/i.test(absPath)) {
    sendFile(res, absPath);
    return;
  }
  let html = readFileSync(absPath, 'utf8');
  html = html.includes('</body>')
    ? html.replace('</body>', `${LATTICE_BADGE}</body>`)
    : html + LATTICE_BADGE;
  sendText(res, html, 200, 'text/html; charset=utf-8');
}

export interface ConnectRouterDeps {
  guiAppHtml: string;
  guiVersion: string | undefined;
  /** Explicit `--dashboard` flag (throws loudly if bad); else the persisted one. */
  dashboardPath?: string | null;
}

export interface ConnectRouter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createConnectRouter(deps: ConnectRouterDeps): ConnectRouter {
  let dashboardFile: string | null = null;
  let dashboardDir: string | null = null;
  function setDashboard(path: string | null): { path: string | null; mode: 'file' | 'dir' | null } {
    if (!path?.trim()) {
      dashboardFile = null;
      dashboardDir = null;
      return { path: null, mode: null };
    }
    const r = resolveDashboard(path);
    if (r.mode === 'dir') {
      dashboardDir = r.path;
      dashboardFile = null;
    } else {
      dashboardFile = r.path;
      dashboardDir = null;
    }
    return r;
  }
  if (deps.dashboardPath) {
    setDashboard(deps.dashboardPath); // explicit flag — throw loudly if it is bad
  } else {
    const persisted = getConnectedDashboard();
    if (persisted) {
      try {
        setDashboard(persisted);
      } catch {
        setConnectedDashboard(null); // stale persisted path — clear, never crash the GUI
      }
    }
  }

  const shell = (): string =>
    deps.guiAppHtml.replace('<!--LATTICE_VERSION-->', deps.guiVersion ? `v${deps.guiVersion}` : '');

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // ── Control plane: report / set / disconnect the connected dashboard ──
    if (pathname === '/api/connect/dashboard') {
      if (method === 'GET') {
        const mode = dashboardDir ? 'dir' : dashboardFile ? 'file' : null;
        sendJson(res, { path: dashboardDir ?? dashboardFile, mode });
        return true;
      }
      if (method === 'POST') {
        let body: { path?: unknown };
        try {
          body = await readJson<{ path?: unknown }>(req);
        } catch (e) {
          sendJson(res, { error: (e as Error).message }, 400);
          return true;
        }
        const raw = typeof body.path === 'string' ? body.path : '';
        if (!raw.trim()) {
          setDashboard(null);
          setConnectedDashboard(null);
          sendJson(res, { ok: true, path: null, mode: null });
          return true;
        }
        try {
          const result = setDashboard(raw); // throws on a missing/blank path
          setConnectedDashboard(result.path);
          sendJson(res, { ok: true, path: result.path, mode: result.mode });
        } catch (e) {
          sendJson(res, { error: (e as Error).message }, 400);
        }
        return true;
      }
    }

    // ── "Bring your own dashboard": serve it at `/` (shell moves to `/lattice`) ──
    if ((dashboardFile || dashboardDir) && method === 'GET' && !pathname.startsWith('/api/')) {
      if (pathname === '/lattice' || pathname === '/lattice/') {
        sendText(res, shell(), 200, 'text/html; charset=utf-8');
        return true;
      }
      if (dashboardFile && (pathname === '/' || pathname === '/index.html')) {
        sendDashboardFile(res, dashboardFile);
        return true;
      }
      if (dashboardDir) {
        const rel =
          pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
        const abs = resolve(dashboardDir, rel);
        // The lexical containment check blocks `../` and `%2e%2e` (resolve()
        // normalizes before the startsWith). But statSync + sendDashboardFile
        // FOLLOW symlinks, so a symlink placed inside the dashboard dir could
        // point anywhere on disk (e.g. the workspace DB or a secrets file) and
        // be served verbatim. Re-check containment against the REAL, symlink-
        // resolved path before serving; a missing file or broken/escaping
        // symlink throws or fails the check → fall through to 404.
        if (abs === dashboardDir || abs.startsWith(dashboardDir + sep)) {
          try {
            const realDir = realpathSync(dashboardDir);
            const real = realpathSync(abs);
            if ((real === realDir || real.startsWith(realDir + sep)) && statSync(real).isFile()) {
              sendDashboardFile(res, real);
              return true;
            }
          } catch {
            /* missing / broken / escaping symlink → fall through to 404 */
          }
        }
      }
      // Unknown dashboard path → fall through to the normal routes (404/409).
    }

    return false;
  }

  return { handle };
}
