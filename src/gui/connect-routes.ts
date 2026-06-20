import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import type { ActiveDb } from './active-db.js';
import { sendJson, readJson } from './http.js';
import {
  resolveDashboard,
  getConnectedDashboard,
  setConnectedDashboard,
} from '../connect/dashboard.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { materializeImport, type ImportMode } from '../import/materialize.js';
import { detectAsOfColumns } from '../import/asof-columns.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import { excelToRecords } from '../import/excel.js';
import { detectImportAsOf } from './import-detect.js';
import { referenceLocalFile } from '../framework/reference-store.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';

/**
 * Connect-a-dashboard + structured-import routes. In 4.0 the GUI server is a thin
 * ordered dispatcher; this module is the connect feature's slice of it, invoked
 * BEFORE the virgin gate so the dashboard serves (and the control plane answers)
 * even with no active workspace — the import routes themselves 409 until one
 * exists. {@link createConnectRouter} owns the connected-dashboard state for the
 * server's lifetime; {@link ConnectRouter.handle} returns true when it handled the
 * request (caller short-circuits), false to fall through to the normal routes.
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

/** A 400-carrying error so the handler answers a client mistake with 400. */
function badRequest(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}

/** Run an async handler, mapping a thrown error to its `statusCode` (default 500). */
async function tryHandler(res: ServerResponse, fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) console.error(`[gui] ${label} failed: ${err.message}\n${err.stack ?? ''}`);
    else console.warn(`[gui] ${label}: ${err.message}`);
    sendJson(res, { error: err.message }, status);
  }
}

function readImportJson(rawPath: string, dashboardDir: string | null): Record<string, unknown> {
  if (!rawPath.trim()) throw badRequest('A JSON file path is required.');
  let abs = resolve(rawPath);
  if (!existsSync(abs) && dashboardDir) abs = resolve(dashboardDir, rawPath);
  if (!existsSync(abs)) throw badRequest('File not found: ' + abs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    throw badRequest('Not valid JSON: ' + abs);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Expected a JSON object whose keys are record arrays.');
  }
  return parsed as Record<string, unknown>;
}

/** Read an import source by extension: `.xlsx`/`.xls` → sheets-as-records, else JSON. */
async function readImportSource(
  rawPath: string,
  dashboardDir: string | null,
): Promise<Record<string, unknown>> {
  if (!rawPath.trim()) throw badRequest('A file path is required.');
  if (/\.xlsx?$/i.test(rawPath)) {
    let abs = resolve(rawPath);
    if (!existsSync(abs) && dashboardDir) abs = resolve(dashboardDir, rawPath);
    if (!existsSync(abs)) throw badRequest('File not found: ' + abs);
    return excelToRecords(abs);
  }
  return readImportJson(rawPath, dashboardDir);
}

/** The workspace's importable data tables (registered, non-native), for matching. */
function existingDataTables(db: Lattice): ExistingTable[] {
  const native = new Set<string>(NATIVE_ENTITY_NAMES);
  const out: ExistingTable[] = [];
  for (const t of db.getRegisteredTableNames()) {
    if (native.has(t)) continue;
    const columns = Object.keys(db.getRegisteredColumns(t) ?? {});
    if (columns.length > 0) out.push({ name: t, columns });
  }
  return out;
}

/** Resolve an import path to an absolute path, or null if it doesn't exist. */
function resolveImportPath(rawPath: string, dashboardDir: string | null): string | null {
  if (!rawPath.trim()) return null;
  let abs = resolve(rawPath);
  if (!existsSync(abs) && dashboardDir) abs = resolve(dashboardDir, rawPath);
  return existsSync(abs) ? abs : null;
}

/** Read the raw request body into a Buffer (for binary uploads). */
function readRequestBuffer(req: IncomingMessage, maxBytes = 200_000_000): Promise<Buffer> {
  return new Promise((resolveBuf, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) reject(badRequest('Upload too large.'));
      else chunks.push(c);
    });
    req.on('end', () => {
      resolveBuf(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export interface ConnectRouterDeps {
  guiAppHtml: string;
  guiVersion: string | undefined;
  /** The current active workspace, or null in the virgin state. */
  getActive: () => ActiveDb | null;
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
        if (
          (abs === dashboardDir || abs.startsWith(dashboardDir + sep)) &&
          existsSync(abs) &&
          statSync(abs).isFile()
        ) {
          sendDashboardFile(res, abs);
          return true;
        }
      }
      // Unknown dashboard path → fall through to the normal routes (404/409).
    }

    // ── Structured-source import (the connect panel's "Import data model") ──
    if (method === 'GET' && pathname === '/api/connect/import/sources') {
      const sources: string[] = [];
      if (dashboardDir) {
        try {
          for (const f of readdirSync(dashboardDir)) {
            if (/\.(json|xlsx?)$/i.test(f)) sources.push(join(dashboardDir, f));
          }
        } catch {
          /* unreadable dir → no candidates */
        }
      }
      sendJson(res, { sources });
      return true;
    }

    const isImportWrite =
      method === 'POST' &&
      (pathname === '/api/connect/import/stage' ||
        pathname === '/api/connect/import/analyze' ||
        pathname === '/api/connect/import/apply');
    if (!isImportWrite) return false;

    // The import-write routes need an active workspace to materialize into.
    const active = deps.getActive();
    if (!active) {
      sendJson(res, { error: 'No active workspace' }, 409);
      return true;
    }

    if (pathname === '/api/connect/import/stage') {
      await tryHandler(
        res,
        async () => {
          const raw =
            typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : 'upload';
          let name = raw;
          try {
            name = decodeURIComponent(raw);
          } catch {
            /* keep raw if it isn't percent-encoded */
          }
          const buf = await readRequestBuffer(req);
          const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'upload';
          const dir = join(dirname(active.configPath), 'import-staging');
          mkdirSync(dir, { recursive: true });
          const dest = join(dir, randomUUID().slice(0, 8) + '-' + safe);
          writeFileSync(dest, buf);
          sendJson(res, { path: dest, name: safe });
        },
        '/api/connect/import/stage',
      );
      return true;
    }

    if (pathname === '/api/connect/import/analyze') {
      await tryHandler(
        res,
        async () => {
          const body = await readJson<{ path?: unknown }>(req);
          const rawPath = typeof body.path === 'string' ? body.path : '';
          const data = await readImportSource(rawPath, dashboardDir);
          const { plan, views } = dedupeAndDetectViews(inferSchema(data), data);
          const abs = resolveImportPath(rawPath, dashboardDir);
          const asOfCandidates = await detectImportAsOf(active.db, data, { abs });
          const asOfColumns = detectAsOfColumns(data, plan);
          const schemaMatch = matchSchemaToExisting(existingDataTables(active.db), plan);
          sendJson(res, {
            plan,
            asOf: asOfCandidates[0]?.date ?? null,
            asOfCandidates,
            asOfColumns,
            schemaMatch,
            views,
          });
        },
        '/api/connect/import/analyze',
      );
      return true;
    }

    // /api/connect/import/apply — stream the pipeline as newline-delimited JSON.
    const body: { path?: unknown; mode?: unknown; asOf?: unknown; asOfColumn?: unknown } =
      await readJson<{ path?: unknown; mode?: unknown; asOf?: unknown; asOfColumn?: unknown }>(
        req,
      ).catch(() => ({}));
    const rawPath = typeof body.path === 'string' ? body.path : '';
    const mode: ImportMode = body.mode === 'schema' || body.mode === 'contents' ? body.mode : 'both';
    const asOf =
      typeof body.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf.trim())
        ? body.asOf.trim()
        : null;
    const asOfColumn =
      typeof body.asOfColumn === 'string' && body.asOfColumn.trim() ? body.asOfColumn.trim() : null;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    });
    const emit = (p: Record<string, unknown>): void => {
      res.write(JSON.stringify(p) + '\n');
    };
    try {
      emit({ phase: 'parse', message: 'Reading source…' });
      const data = await readImportSource(rawPath, dashboardDir);
      emit({ phase: 'infer', message: 'Analyzing schema…' });
      const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
        inferSchema(data),
        data,
      );
      emit({
        phase: 'infer',
        message: `Found ${String(inferredPlan.entities.length)} entities, ${String(inferredPlan.dimensions.length)} dimensions, ${String(inferredPlan.linkages.length)} links`,
      });
      const match = matchSchemaToExisting(existingDataTables(active.db), inferredPlan);
      const { plan, views } = renameEntities(inferredPlan, inferredViews, match.rename);
      if (views.length > 0) {
        emit({
          phase: 'detect',
          message: `Detected ${String(views.length)} reconstructable views (no duplicated rows)`,
        });
      }
      if (match.isKnownDocument) {
        emit({
          phase: 'detect',
          message: `Recognized as a new period of an existing document — ${String(match.matchedCount)} of ${String(match.totalEntities)} tables matched`,
        });
      }
      if (asOfColumn) emit({ phase: 'infer', message: `Dating each row by its "${asOfColumn}" column` });
      else if (asOf) emit({ phase: 'infer', message: `Importing as a snapshot dated ${asOf}` });
      const result = await materializeImport(
        { db: active.db, configPath: active.configPath },
        data,
        plan,
        views,
        {
          mode,
          asOf,
          asOfColumn,
          onProgress: async (p) => {
            emit({ ...p });
            await new Promise((r) => setImmediate(r));
          },
        },
      );
      for (const t of result.tablesCreated) {
        active.validTables.add(t);
        const cols = active.db.getRegisteredColumns(t);
        if (cols && 'deleted_at' in cols) active.softDeletable.add(t);
      }
      const srcPath = resolveImportPath(rawPath, dashboardDir);
      if (srcPath) {
        try {
          const meta = referenceLocalFile(srcPath);
          if (/[/\\]import-staging[/\\]/.test(srcPath)) {
            meta.original_name = (meta.original_name ?? '').replace(/^[0-9a-f]{8}-/, '');
          }
          await active.db.insert('files', { id: randomUUID(), ...meta });
          emit({ phase: 'file', message: `Saved ${meta.original_name ?? basename(srcPath)} to Files` });
        } catch (e) {
          emit({ phase: 'file', message: `Imported, but saving the file to Files failed: ${(e as Error).message}` });
        }
      }
      emit({ phase: 'done', ok: true, result });
    } catch (e) {
      emit({ phase: 'error', message: (e as Error).message });
    }
    res.end();
    return true;
  }

  return { handle };
}
