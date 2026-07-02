import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { sendJson, readJson, parsePageParam, sendHtmlCompressed } from './http.js';
import { Lattice } from '../lattice.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { GuiRequestContext } from './request-context.js';
import {
  buildGuiGraph,
  getGuiEntities,
  loadGuiData,
  getGuiProject,
  isJunctionTable,
  type GuiEntitiesPayload,
  type GuiTableSummary,
} from './data.js';
import { fullTextSearch } from '../search/fts.js';
import { buildProvenanceGraph } from './provenance.js';
import { ASSISTANT_HIDDEN_TABLES } from './ai/dispatch.js';
import { resolveColumnDescription, resolveTableDescription } from './column-descriptions.js';
import { parseAudit, updateRow } from './mutations.js';
import { deriveUpdatesFromFile } from '../reverse-sync/default-reverse-sync.js';
import {
  listNativeBindings,
  isNativeEntity,
  isInternalNativeEntity,
  NATIVE_INTERNAL_NAMES,
} from '../framework/native-entities.js';
import { countManyPostgres, exactCountMany } from './count-many.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { getAllTablePolicies } from '../cloud/table-policy.js';
import { buildRowContextLocator, readRowContext } from './row-context.js';
import { CONTEXT_PATH, ROW_HISTORY_PATH, LAST_EDITED_PATH } from './route-paths.js';

/**
 * Server-process constants the read routes need that are NOT part of the
 * per-request active-DB state (so they are threaded here rather than hung off
 * GuiRequestContext). `sendText` in particular is server-local (not exported
 * from http.ts), so it MUST be passed by reference to keep the GET / shell
 * response byte-identical.
 */
export interface ReadRoutesDeps {
  /** Bind host, for `new URL(req.url, http://${host})`. Closure const in server.ts. */
  host: string;
  /** Package version string (no leading v), for the GET / shell placeholder. */
  guiVersion: string;
  /** The SPA shell HTML. Imported in server.ts from ./app.js; threaded so this leaf need not import app.js. */
  guiAppHtml: string;
  /** server.ts-local sendText (NOT exported from http.ts). Threaded by reference so GET / stays byte-identical. */
  sendText: (res: ServerResponse, body: string, status?: number, contentType?: string) => void;
  /**
   * Absolute path to the built `dist/gui-assets/` directory, served read-only at
   * `GET /gui-assets/*` (the on-device voice worker + ONNX-Runtime WASM). Resolved
   * once in server.ts. When the fail-soft asset build skipped (the dir or a file
   * is absent), the route 404s and the GUI degrades — voice falls back or hides.
   */
  guiAssetsDir: string;
}

/** Static MIME types for the vendored GUI assets. Defaults to octet-stream. */
const GUI_ASSET_MIME: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Tables the live Lattice schema manager knows about that the YAML
 * config doesn't declare — native entities (`files`/`secrets`) and
 * team-shared tables auto-registered via `applyCloudSchemaLocally`
 * (defineLate) on open. Internal `__lattice_*` / `_lattice_*`
 * bookkeeping tables stay hidden. Shared by the entity-card list and
 * the Data Model graph so both surface the same set.
 */
function registeredExtraTables(db: Lattice, yamlNames: Set<string>): GuiTableSummary[] {
  return db
    .getRegisteredTableNames()
    .filter((name) => !yamlNames.has(name))
    .filter((name) => !name.startsWith('__lattice_'))
    .filter((name) => !name.startsWith('_lattice_'))
    .map((name) => {
      const cols = db.getRegisteredColumns(name) ?? {};
      return {
        name,
        columns: Object.keys(cols),
        outputFile: `.schema-only/${name}.md`,
        relations: {},
      };
    });
}

/**
 * Enrich a base set of table summaries with per-table row counts and (cloud
 * owner) sharing policy — the heavy, DB-touching part of the Objects list. Shared
 * by the full {@link entitiesWithCounts} path and the no-disk-scan
 * {@link entitiesSummary} path so both render an identical Objects list.
 */
async function enrichEntityTables(
  db: Lattice,
  baseTables: GuiTableSummary[],
): Promise<GuiTableSummary[]> {
  const yamlNames = new Set(baseTables.map((t) => t.name));
  // Internal native entities (chat_threads/chat_messages) back the assistant's
  // conversation storage — they're real tables but must never surface in the
  // Objects list / dashboard cards. Drop them from the display payload here
  // (they stay registered + queryable for the chat route).
  const allTables = [...baseTables, ...registeredExtraTables(db, yamlNames)].filter(
    (t) => !isInternalNativeEntity(t.name),
  );

  // Postgres: collapse the per-table COUNT(*) fan-out to one query against
  // pg_class. The naive Promise.all path below issues N parallel COUNTs through
  // the connection pool; on a session pooler with a small slot budget (e.g.
  // Supabase's 15-slot session pooler), N > slots locks up the pool the moment
  // two clients refresh at once.
  //
  // `reltuples` is approximate (maintained by ANALYZE / autovacuum). For
  // the entity-list view that's the right tradeoff — operators are
  // picking which table to open, not auditing row counts. The trade is
  // that tables with a `deleted_at` column now include soft-deleted rows
  // in this number; per-table drill-in still shows the filtered count.
  const adapter = (db as unknown as { _adapter: StorageAdapter })._adapter;
  const useBatched = adapter.dialect === 'postgres' && typeof adapter.allAsync === 'function';
  const approxCounts = useBatched
    ? await countManyPostgres(
        adapter,
        allTables.map((t) => t.name),
      )
    : new Map<string, number>();
  // Correct the stale-stat blind spot: pg_class.reltuples reads 0 for a table
  // under autovacuum's ANALYZE threshold (~50 changes), so a freshly
  // bulk-loaded table shows 0 on the dashboard even though drill-in lists its
  // rows. For exactly that suspicious subset (approx count null or 0) issue ONE
  // extra aggregated round-trip of real COUNTs — healthy tables keep the fast
  // approximate path, so the pooler-exhausting fan-out the batched path avoids
  // is never reintroduced.
  let exactCounts = new Map<string, number>();
  if (useBatched) {
    const suspicious = allTables.map((t) => t.name).filter((n) => (approxCounts.get(n) ?? 0) === 0);
    if (suspicious.length > 0) {
      const softDeleteTables = new Set(
        allTables.filter((t) => t.columns.includes('deleted_at')).map((t) => t.name),
      );
      exactCounts = await exactCountMany(adapter, suspicious, softDeleteTables);
    }
  }

  const enrichedTables = await Promise.all(
    allTables.map(async (t): Promise<GuiTableSummary> => {
      let rowCount: number | null;
      if (useBatched) {
        // Postgres: prefer an exact count for the suspicious subset (computed
        // in one extra round-trip above); otherwise the fast approximate stat.
        // Still `null` when neither is available so the SPA renders "—".
        rowCount = exactCounts.get(t.name) ?? approxCounts.get(t.name) ?? null;
      } else {
        // SQLite: in-process, no pool. Keep the exact, soft-delete-aware
        // count we've always shipped.
        rowCount = t.columns.includes('deleted_at')
          ? await db.count(t.name, { filters: [{ col: 'deleted_at', op: 'isNull' }] })
          : await db.count(t.name);
      }
      const base: GuiTableSummary = { ...t, rowCount, native: isNativeEntity(t.name) };
      // Connected data type → expose its toolkit so the Objects list can badge it.
      const connectedSource = db.getConnectedSource(t.name);
      if (connectedSource) base.connectorToolkit = connectedSource.toolkit;
      // Column → SQL type, for the Data Model schema cards (name : type).
      const colTypes = db.getRegisteredColumns(t.name);
      if (colTypes) base.columnTypes = colTypes;
      // Canonical field types (text/uuid/datetime/…) — preferred for display
      // over the lossy SQL spec above. Absent for code-defined tables.
      const fieldTypes = db.getRegisteredFieldTypes(t.name);
      if (fieldTypes) base.fieldTypes = fieldTypes;
      return base;
    }),
  );

  // Cloud (Postgres) owner only: stamp each table's owner-controlled policy
  // (default new-row visibility + never-share) so the Data Model panel can show
  // and edit it. Members don't need it (the panel is owner-only) and SQLite has
  // no such policy, so both skip these per-table reads entirely.
  if (
    db.getDialect() === 'postgres' &&
    (await cloudRlsInstalled(db)) &&
    (await canManageRoles(db))
  ) {
    const policies = await getAllTablePolicies(db); // one query, not one-per-table
    for (const t of enrichedTables) {
      const policy = policies[t.name];
      t.defaultRowVisibility = policy?.defaultRowVisibility ?? 'private';
      t.neverShare = policy?.neverShare ?? false;
      // Re-light the Data Model sharing UI (regressed in the 3.0 RLS rewrite,
      // which stopped setting these). The connecting role is the cloud owner
      // (canManageRoles above), so it can manage every table's sharing → show the
      // controls + the share-state border. Under the 3.1 RLS model "shared" maps
      // to the table's rows defaulting to everyone-visible (vs owner-private).
      t.ownedByMe = true;
      t.shared = t.defaultRowVisibility === 'everyone';
    }
  }

  return enrichedTables;
}

async function entitiesWithCounts(
  db: Lattice,
  configPath: string,
  outputDir: string,
): Promise<GuiEntitiesPayload> {
  const payload = getGuiEntities(configPath, outputDir);
  return { ...payload, tables: await enrichEntityTables(db, payload.tables) };
}

/**
 * Same as {@link entitiesWithCounts} but WITHOUT the O(files) rendered-file scan
 * (collectEntities). The Objects list / Tables / sidebar only read `tables`, so
 * the workspace-switch hot path serves this and stays fast on a large workspace;
 * the `entities` (rendered-file summaries) field is intentionally empty.
 */
async function entitiesSummary(
  db: Lattice,
  configPath: string,
  outputDir: string,
): Promise<GuiEntitiesPayload> {
  const data = loadGuiData(configPath, outputDir, false); // skip the disk scan
  return {
    tables: await enrichEntityTables(db, data.tables),
    entities: [],
    hasManifest: data.manifest !== null,
  };
}

const FRESHNESS_COLS = ['updated_at', 'created_at', 'ts'];
const DASHBOARD_STALE_DAYS = 14;

/**
 * Per-table "last touched" timestamp — the MAX of the first present freshness
 * column (`updated_at` / `created_at` / `ts`). Postgres runs ONE `UNION ALL`
 * query to stay pool-safe (same concern that drove the batched count in
 * {@link entitiesWithCounts}); SQLite runs in-process. Tables with none of
 * those columns are omitted (no freshness signal). Table/column names come from
 * the registered schema (introspected), not user input, so they are safe to
 * interpolate as identifiers.
 */
async function tableFreshness(
  adapter: StorageAdapter,
  tables: { name: string; columns: string[] }[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const withCol = tables
    .map((t) => ({ name: t.name, col: FRESHNESS_COLS.find((c) => t.columns.includes(c)) }))
    .filter((t): t is { name: string; col: string } => t.col !== undefined);
  if (withCol.length === 0) return out;
  if (adapter.dialect === 'postgres' && typeof adapter.allAsync === 'function') {
    const sql = withCol
      .map((t) => `SELECT '${t.name}' AS t, MAX("${t.col}")::text AS m FROM "${t.name}"`)
      .join(' UNION ALL ');
    const rows = (await adapter.allAsync(sql)) as { t: string; m: string | null }[];
    for (const r of rows) out.set(r.t, r.m);
  } else {
    for (const t of withCol) {
      const rows = adapter.all(`SELECT MAX("${t.col}") AS m FROM "${t.name}"`) as {
        m: string | null;
      }[];
      out.set(t.name, rows[0]?.m ?? null);
    }
  }
  return out;
}

interface DashboardEntity extends GuiTableSummary {
  lastUpdatedAt: string | null;
  stale: boolean;
}

interface DashboardPayload {
  generatedAt: string;
  staleDays: number;
  totals: { entities: number; rows: number; stale: number };
  entities: DashboardEntity[];
}

/**
 * Workspace overview: per-entity counts (reusing {@link entitiesWithCounts}) +
 * a freshness timestamp. This is a read-only, GUI-only composition — it adds no
 * core write-path behavior and does not affect a library consumer of Lattice.
 */
async function dashboardPayload(
  db: Lattice,
  configPath: string,
  outputDir: string,
): Promise<DashboardPayload> {
  const entityList = await entitiesWithCounts(db, configPath, outputDir);
  // First-class entities only (skip junctions + system tables) — same set the
  // dashboard cards show.
  const firstClass = entityList.tables.filter(
    (t) => !isJunctionTable(t) && !t.name.startsWith('_'),
  );
  const adapter = (db as unknown as { _adapter: StorageAdapter })._adapter;
  const freshness = await tableFreshness(adapter, firstClass);
  const nowMs = Date.now();
  const staleMs = DASHBOARD_STALE_DAYS * 86_400_000;
  let totalRows = 0;
  let staleCount = 0;
  const entities: DashboardEntity[] = firstClass.map((t) => {
    const lastUpdatedAt = freshness.get(t.name) ?? null;
    const stale = lastUpdatedAt !== null && nowMs - new Date(lastUpdatedAt).getTime() > staleMs;
    if (typeof t.rowCount === 'number') totalRows += t.rowCount;
    if (stale) staleCount += 1;
    return { ...t, lastUpdatedAt, stale };
  });
  return {
    generatedAt: new Date().toISOString(),
    staleDays: DASHBOARD_STALE_DAYS,
    totals: { entities: entities.length, rows: totalRows, stale: staleCount },
    entities,
  };
}

/**
 * First-match dispatcher for the read-only GUI routes extracted from
 * server.ts's request handler. Mirrors the boolean-handled return convention of
 * the other src/gui/*-routes.ts dispatchers (a handled branch sends its response
 * and returns true; an unmatched request falls through to `return false`). It
 * takes the shared {@link GuiRequestContext} plus a typed {@link ReadRoutesDeps}
 * fourth arg, and re-parses url/pathname/method from the request itself rather
 * than receiving a pre-parsed bespoke context — an intentional divergence from
 * the (req, res, ctx) signature of the sibling dispatchers.
 *
 * On a false return, server.ts continues to its surviving schema / CRUD /
 * sub-dispatcher groups (including the ROWS_PATH CRUD body). Because this tests
 * CONTEXT_PATH / ROW_HISTORY_PATH before returning true, they stay globally
 * ahead of server.ts's ROWS_PATH test — the overlap-ordering invariant is
 * preserved by construction.
 *
 * No moved route body is wrapped in a new try/catch: the CONTEXT_PATH route can
 * throw row_access_denied / row_owner_only, and those must propagate to
 * server.ts's existing outer catch (which maps them to 404 / 403).
 */
/** One node in the lazy rendered-context tree (folder or .md file). */
interface ContextTreeEntry {
  name: string;
  /** Path relative to the output dir, POSIX-joined. */
  path: string;
  kind: 'dir' | 'file';
}

/**
 * List the IMMEDIATE children (sub-folders + `.md` files) of `outputDir/rel` for
 * the Outputs > Markdown tree. Lazy by design — a large workspace's Context tree
 * has tens of thousands of files, so each level is fetched on demand and bounded
 * (Rule of thumb: never an unbounded recursive scan). Internal dot-dirs are
 * skipped; the path is containment-guarded (normalize + prefix + realpath) like
 * the /gui-assets route. Returns null when the dir is missing or escapes the root.
 */
function listContextChildren(
  outputDir: string,
  rel: string,
): { entries: ContextTreeEntry[]; truncated: boolean } | null {
  const base = outputDir.replace(/[/\\]+$/, '');
  const dir = rel ? normalize(join(base, rel)) : base;
  const within = dir === base || dir.startsWith(base + sep);
  if (!within || !existsSync(dir) || !statSync(dir).isDirectory()) return null;
  try {
    const real = realpathSync(dir);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
  } catch {
    return null;
  }
  const CAP = 1000;
  const all = readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'));
  const dirs = all
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const files = all
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const mk = (name: string, kind: 'dir' | 'file'): ContextTreeEntry => ({
    name,
    path: rel ? `${rel}/${name}` : name,
    kind,
  });
  // Folders first, then files; the tree mirrors the on-disk Context/ layout.
  const combined = [...dirs.map((n) => mk(n, 'dir')), ...files.map((n) => mk(n, 'file'))];
  return { entries: combined.slice(0, CAP), truncated: combined.length > CAP };
}

export async function handleReadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: ReadRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  // Non-null: server.ts only calls this past the virgin guard. No moved route
  // reassigns active, so binding it once here is referentially equivalent to the
  // handler's inline `let active = activeRef` for the whole call.
  const active = ctx.active();

  // ── HTML + read-only data routes ──────────────────────────────────
  if (method === 'GET' && pathname === '/') {
    sendHtmlCompressed(
      req,
      res,
      deps.guiAppHtml.replace(
        '<!--LATTICE_VERSION-->',
        deps.guiVersion ? `v${deps.guiVersion}` : '',
      ),
    );
    return true;
  }

  // ── Vendored GUI assets: on-device voice worker + ONNX-Runtime WASM ──
  // GET /gui-assets/<path> serves read-only from dist/gui-assets/ with the right
  // MIME (text/javascript for .mjs, application/wasm for .wasm) and a long-lived
  // immutable cache header (content-addressed, vendored bytes). Same-origin
  // localhost, no CDN. When the fail-soft asset build skipped these files the
  // route 404s and the GUI degrades (voice hides / falls back) — never a 500.
  if (method === 'GET' && pathname.startsWith('/gui-assets/')) {
    const rel = decodeURIComponent(pathname.slice('/gui-assets/'.length));
    // Resolve under the assets dir and reject any path that escapes it (`..`,
    // absolute, symlink-ish). `normalize` collapses `..`; the prefix check is the
    // traversal guard.
    // Strip any trailing separator so the `base + sep` containment check below
    // can't form a double-separator that never matches (some callers pass a
    // dir resolved from a URL ending in "/").
    const base = deps.guiAssetsDir.replace(/[/\\]+$/, '');
    const target = normalize(join(base, rel));
    const within = target === base || target.startsWith(base + sep);
    if (!within || !existsSync(target) || !statSync(target).isFile()) {
      sendJson(res, { error: 'asset not found' }, 404);
      return true;
    }
    // Defense-in-depth against symlinks: `normalize` is text-only and doesn't
    // follow links, and `statSync` DOES follow them — so a symlink under the
    // assets dir could otherwise read a file outside it. Resolve the real path
    // (and the real base) and re-confirm containment.
    try {
      const real = realpathSync(target);
      const realBase = realpathSync(base);
      if (real !== realBase && !real.startsWith(realBase + sep)) {
        sendJson(res, { error: 'asset not found' }, 404);
        return true;
      }
    } catch {
      sendJson(res, { error: 'asset not found' }, 404);
      return true;
    }
    const ext = extname(target).toLowerCase();
    const mime = GUI_ASSET_MIME[ext] ?? 'application/octet-stream';
    // The bundled .mjs/.js (force-graph, voice worker) are rebuilt at a STABLE url
    // on every build, so they MUST revalidate — an `immutable` cache served a stale
    // renderer for a full year (masking shipped GUI fixes until a hard reload). The
    // large vendored binaries (ONNX-Runtime .wasm) are content-stable, so they keep
    // the long immutable cache (a 60 MB blob must not re-download each load).
    const revalidate = ext === '.mjs' || ext === '.js';
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': revalidate ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // The worker uses WASM threads/SharedArrayBuffer when the browser allows it;
      // these headers don't hurt single-threaded WASM and enable the threaded path.
      'cross-origin-resource-policy': 'same-origin',
    });
    createReadStream(target).pipe(res);
    return true;
  }

  // ── Realtime: connection status (single-shot JSON) ─────────────────
  // Live realtime change/state events flow over the multiplexed
  // `/api/stream` WebSocket; this endpoint is just the snapshot probe.
  if (method === 'GET' && pathname === '/api/realtime/status') {
    const mode: 'local' | 'cloud' = active.realtime ? 'cloud' : 'local';
    const connected = active.realtime?.state() === 'connected';
    sendJson(res, { mode, state: active.realtime?.state() ?? 'local', connected });
    return true;
  }

  // ── Background render: single-shot status snapshot ──────────────────
  // `/api/render/status` returns the live render state (phase + per-table %)
  // as plain JSON; the streaming per-table progress now flows over the
  // multiplexed WebSocket. Reads `active` at request time.
  if (method === 'GET' && pathname === '/api/render/status') {
    sendJson(res, active.renderState);
    return true;
  }
  if (method === 'GET' && pathname === '/api/project') {
    sendJson(res, getGuiProject(active.configPath, active.outputDir));
    return true;
  }
  if (method === 'GET' && pathname === '/api/entities') {
    sendJson(res, await entitiesWithCounts(active.db, active.configPath, active.outputDir));
    return true;
  }
  // Fast path for the workspace-switch + boot + post-mutation reloads: the same
  // Objects list (tables + counts), but WITHOUT the O(files) rendered-file scan
  // that `/api/entities` does (the GUI never reads the scanned `entities` field).
  if (method === 'GET' && pathname === '/api/entities-summary') {
    sendJson(res, await entitiesSummary(active.db, active.configPath, active.outputDir));
    return true;
  }
  if (method === 'GET' && pathname === '/api/dashboard') {
    sendJson(res, await dashboardPayload(active.db, active.configPath, active.outputDir));
    return true;
  }
  // ── Full-text search across tables ────────────────────────────────
  // GET /api/search?q=&tables=&limit= — LIKE fallback + indexed (FTS5 /
  // tsvector) per the engine in src/search/fts.ts. Scoped to validTables;
  // row visibility is enforced by Postgres RLS at the database.
  if (method === 'GET' && pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) {
      sendJson(res, { query: '', groups: [] });
      return true;
    }
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '8')));
    const requested = url.searchParams.get('tables');
    // Conversation storage + secrets must never appear in search results
    // (mirrors the assistant's own table allowlist). Same source of truth
    // as the chat dispatcher so search and assistant stay in lockstep.
    let tables = [...active.validTables].filter((t) => !ASSISTANT_HIDDEN_TABLES.has(t));
    if (requested) {
      const want = new Set(
        requested
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      );
      tables = tables.filter((t) => want.has(t));
    }
    const result = await fullTextSearch(active.db.adapter, tables, {
      query: q,
      limitPerTable: limit,
    });
    sendJson(res, result);
    return true;
  }
  // ── Team members (for "last edited by" name resolution) ───────────
  // GET /api/team/users → { users: [{id,email,name}] }. Empty — member
  // directory is rebuilt on RLS later.
  if (method === 'GET' && pathname === '/api/team/users') {
    sendJson(res, { users: [] });
    return true;
  }
  if (method === 'GET' && pathname === '/api/graph') {
    // Only the table NAMES are needed here — use the no-disk-scan loader
    // (loadGuiData(..., false) returns the same parsed.tables.map(tableToSummary))
    // so the schema-only graph the ingest animation depends on doesn't run the
    // O(files) rendered-file scan that getGuiEntities would.
    const yamlNames = new Set(
      loadGuiData(active.configPath, active.outputDir, false).tables.map((t) => t.name),
    );
    const graphOpts: import('./data.js').BuildGuiGraphOptions = {
      extraTables: registeredExtraTables(active.db, yamlNames),
      // ?schema=1 → table topology only (the GUI graph never draws row nodes), so a
      // large workspace ships a tiny payload instead of tens of thousands of rows.
      schemaOnly: url.searchParams.get('schema') === '1',
    };
    sendJson(res, buildGuiGraph(active.configPath, active.outputDir, graphOpts));
    return true;
  }

  // ── Data provenance / lineage ─────────────────────────────────────────
  // GET /api/provenance?table=<t> → { nodes, edges } tracing the object's
  // sources across the raw / computed / observation tiers. Allowlisted to
  // validTables (same guard the search route uses), so the internal
  // lineage/audit tables can never be targeted as the object.
  if (method === 'GET' && pathname === '/api/provenance') {
    const table = (url.searchParams.get('table') ?? '').trim();
    if (!table) {
      sendJson(res, { error: 'table is required' }, 400);
      return true;
    }
    if (!active.validTables.has(table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    sendJson(
      res,
      await buildProvenanceGraph(active.db, table, {
        configPath: active.configPath,
        outputDir: active.outputDir,
      }),
    );
    return true;
  }
  // GET /api/provenance/row?table=<t>&id=<id> → row-scoped provenance.
  if (method === 'GET' && pathname === '/api/provenance/row') {
    const table = (url.searchParams.get('table') ?? '').trim();
    const id = (url.searchParams.get('id') ?? '').trim();
    if (!table || !id) {
      sendJson(res, { error: 'table and id are required' }, 400);
      return true;
    }
    if (!active.validTables.has(table)) {
      sendJson(res, { error: `Unknown table: ${table}` }, 400);
      return true;
    }
    const row = await active.db.get(table, id);
    if (row === null) {
      sendJson(res, { error: 'Row not found' }, 404);
      return true;
    }
    sendJson(
      res,
      await buildProvenanceGraph(active.db, table, {
        rowId: id,
        row, // already fetched above → creation + belongsTo tiers read it with no extra DB reads
        configPath: active.configPath,
        outputDir: active.outputDir,
      }),
    );
    return true;
  }

  // ── GUI column metadata (per-column secret flag) ─────────────────
  if (method === 'GET' && pathname === '/api/gui-meta/columns') {
    // Whole-table read is intentional + bounded: _lattice_gui_column_meta holds at
    // most one row per (table, column) in the SCHEMA — bounded by the schema size,
    // not by data volume — so it never grows with row count (not a Rule-28 hot read).
    const rows = (await active.db.query('_lattice_gui_column_meta', {})) as {
      table_name: string;
      column_name: string;
      secret: number;
      description?: string | null;
    }[];
    // Index the authored (operator/AI/auto-generated) meta by table→column.
    const authored = new Map<string, Map<string, { secret: number; description: string | null }>>();
    for (const r of rows) {
      let bucket = authored.get(r.table_name);
      if (!bucket) {
        bucket = new Map<string, { secret: number; description: string | null }>();
        authored.set(r.table_name, bucket);
      }
      bucket.set(r.column_name, { secret: r.secret, description: r.description ?? null });
    }
    // Resolve every registered column's effective description (authored wins,
    // else a built-in default) so the client can tooltip built-in columns
    // (files.original_name …) without shipping the built-in map to the
    // browser. Schema-sized + loaded once — not a per-row read (internal guideline ok).
    const out: Record<string, Record<string, { secret?: boolean; description?: string }>> = {};
    for (const table of active.validTables) {
      const cols = Object.keys(active.db.getRegisteredColumns(table) ?? {});
      const bucket = authored.get(table);
      const tableOut: Record<string, { secret?: boolean; description?: string }> = {};
      for (const col of cols) {
        const meta = bucket?.get(col);
        const desc = resolveColumnDescription(table, col, meta?.description ?? null);
        const entry: { secret?: boolean; description?: string } = {};
        if (meta?.secret === 1) entry.secret = true;
        if (desc) entry.description = desc;
        if (entry.secret || entry.description) tableOut[col] = entry;
      }
      if (Object.keys(tableOut).length) out[table] = tableOut;
    }
    sendJson(res, out);
    return true;
  }

  // ── Version history (audit log + undo/redo + revert) ──────────────
  if (method === 'GET' && pathname === '/api/history') {
    // Bounded read: clamp a provided limit to [1, MAX_ROWS_PAGE] so a client can't
    // request the whole audit table. A missing limit keeps the historical 200
    // default; a non-numeric limit is rejected (400) rather than silently
    // defaulted, matching the other bounded-list endpoints (fail loudly).
    const limitRaw = url.searchParams.get('limit');
    const parsedLimit = parsePageParam(limitRaw, 'limit');
    if (parsedLimit === 'invalid') {
      sendJson(res, { error: 'limit must be a non-negative integer' }, 400);
      return true;
    }
    const limit = limitRaw === null ? 200 : parsedLimit;
    const filterTable = url.searchParams.get('table');
    const raw = (await active.db.query('_lattice_gui_audit', { limit })) as Record<
      string,
      unknown
    >[];
    let entries = raw.map(parseAudit).sort((a, b) => b.ts.localeCompare(a.ts));
    if (filterTable) {
      // Match the entry's primary table OR any junction whose two
      // belongsTo relations point at the filtered table (so a
      // link/unlink on `meeting_people` shows up under both Meetings
      // and People).
      const junctionMatchesFilter = new Set<string>();
      // Only table shape + relations are read here — skip the O(files) scan.
      for (const guiTable of loadGuiData(active.configPath, active.outputDir, false).tables) {
        if (!isJunctionTable(guiTable)) continue;
        const rels = Object.values(guiTable.relations);
        if (rels.some((r) => r.table === filterTable)) {
          junctionMatchesFilter.add(guiTable.name);
        }
      }
      entries = entries.filter(
        (e) => e.table_name === filterTable || junctionMatchesFilter.has(e.table_name),
      );
    }
    // Stack gates (↶/↷) are SESSION-SCOPED to match the session-scoped
    // undo/redo *actions* (POST /api/history/undo|redo filter on
    // session_id). The history LIST above stays global (everyone's
    // activity is visible) and per-entry Revert stays global — but the
    // toolbar buttons must reflect only THIS session's own live/undone
    // entries. Otherwise undone rows left by a PRIOR server process
    // (sessionId is regenerated per process) light up ↷ for a session
    // that has nothing of its own to redo → "Nothing to redo".
    // canUndo/canRedo are just "does this session have ≥1 live / ≥1 undone
    // entry?" — two COUNT(*)s that read NO row bodies. The prior code loaded the
    // whole session audit log (incl. before_json/after_json blobs, up to ~200KB
    // each) on every edit/nav just to derive these two booleans — unbounded
    // egress + latency on the hottest GUI path. Backed by the (session_id, undone)
    // index added in lifecycle.ts.
    const sessionLive = await active.db.count('_lattice_gui_audit', {
      filters: [
        { col: 'session_id', op: 'eq', val: ctx.sessionId },
        { col: 'undone', op: 'eq', val: 0 },
      ],
    });
    const sessionUndone = await active.db.count('_lattice_gui_audit', {
      filters: [
        { col: 'session_id', op: 'eq', val: ctx.sessionId },
        { col: 'undone', op: 'eq', val: 1 },
      ],
    });
    sendJson(res, { entries, canUndo: sessionLive > 0, canRedo: sessionUndone > 0 });
    return true;
  }

  // ── System tables (Lattice-internal, read-only in the GUI) ────────
  if (method === 'GET' && pathname === '/api/system-tables') {
    // Lattice + GUI internal tables — `__lattice_*` (migration ledger,
    // changelog, etc.) and `_lattice_gui_*` (icon overrides, audit log,
    // column meta). Shown in the Objects sidebar under "System" so the
    // user can browse but not edit them.
    //
    // The pre-1.13.4 implementation listed tables via `sqlite_master`
    // and columns via `PRAGMA table_info` — both SQLite-only. On a
    // Postgres-backed Lattice (a migrated cloud) those queries threw
    // and the System sidebar silently rendered empty.
    // We dispatch on adapter.dialect for the listing query and
    // delegate column enumeration to `Lattice.introspectColumns()`,
    // which is already dialect-portable.
    type Adapter = {
      allAsync?: (sql: string) => Promise<unknown[]>;
      dialect: 'sqlite' | 'postgres';
    };
    const adapter = (active.db as unknown as { _adapter: Adapter })._adapter;
    let rows: { name: string }[] = [];
    if (adapter.allAsync) {
      const listSql =
        adapter.dialect === 'postgres'
          ? // pg_tables is the public-schema-only counterpart to
            // sqlite_master. We filter to public + the same `\_%`
            // ESCAPE pattern so the result is identical to SQLite.
            // Underscore is a LIKE wildcard in both engines.
            `SELECT tablename AS name FROM pg_tables ` +
            `WHERE schemaname = 'public' AND tablename LIKE '\\_%' ESCAPE '\\' ` +
            `ORDER BY tablename`
          : `SELECT name FROM sqlite_master ` +
            `WHERE type='table' AND name LIKE '\\_%' ESCAPE '\\' ` +
            `ORDER BY name`;
      rows = (await adapter.allAsync(listSql)) as { name: string }[];
    }
    // Native conversation-storage tables (chat_threads/chat_messages) are
    // hidden from the Objects list + Data Model graph, but ARE browsable
    // read-only here under "System" so the user can inspect chat history.
    // Only list ones that are actually registered on this DB.
    for (const n of NATIVE_INTERNAL_NAMES) {
      if (active.validTables.has(n) && !rows.some((r) => r.name === n)) {
        rows.push({ name: n });
      }
    }
    const tables: { name: string; columns: string[]; rowCount: number | null }[] = [];
    for (const r of rows) {
      // Lattice.introspectColumns dispatches on dialect internally:
      // PRAGMA table_info on SQLite, information_schema.columns on
      // Postgres. Returns string[] of column names either way.
      try {
        const cols = await active.db.introspectColumns(r.name);
        const rowCount = await active.db.count(r.name);
        tables.push({ name: r.name, columns: cols, rowCount });
      } catch (err) {
        // A scoped cloud member has no SELECT grant on the owner-only
        // bookkeeping tables (__lattice_owners, member_roles, cloud_settings,
        // member_invites, changes, …) — those are reached only via SECURITY
        // DEFINER functions, by design — and a NATIVE_INTERNAL_NAME we list
        // optimistically (chat_threads/…) may not be physically present on a
        // given cloud. Neither must 500 the whole System sidebar: show the
        // name, mark the count unknown (null), and continue. A genuine fault
        // (syntax, dropped connection) still surfaces.
        const msg = err instanceof Error ? err.message : String(err);
        if (/permission denied|does not exist/i.test(msg)) {
          tables.push({ name: r.name, columns: [], rowCount: null });
        } else {
          throw err;
        }
      }
    }
    sendJson(res, { tables });
    return true;
  }
  if (method === 'GET' && /^\/api\/system-tables\/[^/]+\/rows$/.test(pathname)) {
    const parts = pathname.split('/');
    const sysTable = decodeURIComponent(parts[3] ?? '');
    // Accept underscore-prefixed internals OR the native conversation
    // tables surfaced under "System". Both are fixed/validated names, so
    // the interpolation into the SELECT below stays injection-safe.
    if (!/^_+[a-zA-Z0-9_]+$/.test(sysTable) && !isInternalNativeEntity(sysTable)) {
      sendJson(res, { error: 'Not a system table' }, 400);
      return true;
    }
    // Bounded read: clamp `limit` to [1, MAX_ROWS_PAGE] and reject a non-numeric
    // value, so a client can't request an unbounded slice (whole-table egress) or
    // turn the interpolation into `LIMIT NaN`. Same contract as /api/tables/:t/rows.
    const limit = parsePageParam(url.searchParams.get('limit'), 'limit');
    if (limit === 'invalid') {
      sendJson(res, { error: 'limit must be a non-negative integer' }, 400);
      return true;
    }
    const rowsResult = (await (async () => {
      type Adapter = { allAsync?: (sql: string) => Promise<unknown[]> };
      const adapter = (active.db as unknown as { _adapter: Adapter })._adapter;
      return (
        adapter.allAsync?.(`SELECT * FROM "${sysTable}" LIMIT ${String(limit)}`) ??
        Promise.resolve([])
      );
    })()) as Record<string, unknown>[];
    sendJson(res, { rows: rowsResult });
    return true;
  }

  // Native-entity bindings for the active DB — lets the UI badge the
  // files/secrets cards as "Native". openConfig auto-records these on
  // every open, so this is a straight read of the registry.
  if (method === 'GET' && pathname === '/api/native-entities') {
    sendJson(res, { bindings: await listNativeBindings(active.db) });
    return true;
  }

  // ── GUI-only metadata (per-entity icon overrides) ─────────────────
  if (method === 'GET' && pathname === '/api/gui-meta') {
    // Whole-table read is intentional + bounded: _lattice_gui_meta holds at most one
    // row per ENTITY in the schema — bounded by the schema size, not data volume.
    const rows = (await active.db.query('_lattice_gui_meta', {})) as {
      entity_name: string;
      icon: string | null;
      description?: string | null;
    }[];
    const authored = new Map<string, { icon: string | null; description: string | null }>();
    for (const r of rows) {
      authored.set(r.entity_name, { icon: r.icon, description: r.description ?? null });
    }
    // Surface the resolved table description (authored wins, else built-in)
    // for every valid table so native-entity descriptions show without an
    // authored meta row. Icon stays authored-only (no built-in icons here).
    const out: Record<string, { icon?: string; description?: string }> = {};
    for (const table of active.validTables) {
      const meta = authored.get(table);
      const desc = resolveTableDescription(table, meta?.description ?? null);
      const entry: { icon?: string; description?: string } = {};
      if (meta?.icon) entry.icon = meta.icon;
      if (desc) entry.description = desc;
      if (entry.icon || entry.description) out[table] = entry;
    }
    sendJson(res, out);
    return true;
  }

  // ── Row context: /api/tables/:table/rows/:id/context ──────────────
  const ctxMatch = CONTEXT_PATH.exec(pathname);
  if (ctxMatch) {
    const [, rawCtxTable, rawCtxId] = ctxMatch;
    const ctxTable = decodeURIComponent(rawCtxTable ?? '');
    const ctxId = decodeURIComponent(rawCtxId ?? '');
    if (method !== 'GET' && method !== 'PUT') {
      sendJson(res, { error: `Method ${method} not allowed` }, 405);
      return true;
    }
    if (!active.validTables.has(ctxTable)) {
      sendJson(res, { error: `Unknown table: ${ctxTable}` }, 400);
      return true;
    }
    const row = await active.db.get(ctxTable, ctxId);
    if (row === null) {
      sendJson(res, { error: 'Row not found' }, 404);
      return true;
    }
    // Secret columns for this table. They are redacted out of the GET render AND
    // never round-tripped back on PUT — the served value is masked (••••••••), so
    // writing it back would clobber the real secret.
    const colMetaRows = (await active.db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: ctxTable },
        { col: 'secret', op: 'eq', val: 1 },
      ],
    })) as { column_name: string }[];
    const secretCols = new Set(colMetaRows.map((r) => r.column_name));

    // ── Write-back: save an edited rendered record back to its columns ──
    // The record's Markdown view is an editable textarea; saving it derives column
    // updates from the markdown (YAML frontmatter + `key: value` body) via the same
    // parser the file-watcher uses, then applies them through the audited mutation
    // primitive (so the edit is reversible from history). Free-form prose that
    // parses to no known column is a deliberate no-op (`updated: 0`) — a value is
    // never guessed at, so a custom/lossy render can't corrupt the row.
    if (method === 'PUT') {
      const putBody = (await readJson<unknown>(req)) as { content?: unknown };
      const content = typeof putBody.content === 'string' ? putBody.content : '';
      const pkCols = active.db.getPrimaryKey(ctxTable);
      const updates = deriveUpdatesFromFile(content, row, { table: ctxTable, pkCols });
      const set = updates[0]?.set ?? {};
      const safeSet: Record<string, unknown> = {};
      for (const [col, val] of Object.entries(set)) {
        if (secretCols.has(col)) continue; // never write a redacted secret value back
        safeSet[col] = val;
      }
      const fields = Object.keys(safeSet);
      if (fields.length > 0) {
        await updateRow(ctx.buildMutationCtx(), ctxTable, ctxId, safeSet);
      }
      sendJson(res, { updated: fields.length, fields });
      return true;
    }

    const def = active.entityContextByTable.get(ctxTable);
    const locator = buildRowContextLocator(ctxTable, row, def, active.manifest);
    if (!locator) {
      // No schema-registered context AND no matching manifest entry.
      // Surface an empty file list — the SPA renders its
      // "no rendered context" placeholder.
      sendJson(res, { files: [] });
      return true;
    }
    sendJson(res, { files: readRowContext(active.outputDir, locator, secretCols) });
    return true;
  }

  // ── Rendered markdown context tree (lazy): /api/context/tree + /list + /file ──
  // The Outputs > Markdown panel mirrors the on-disk Context/ tree. It's LAZY: /tree
  // returns the top level, /list?path=<dir> returns one folder's immediate children
  // (so a workspace with tens of thousands of context files never ships a huge
  // payload), and /file reads ONE .md. All three are read-only + path-containment-
  // guarded (normalize + prefix + realpath), internal dot-dirs skipped.
  if (method === 'GET' && pathname === '/api/context/tree') {
    const r = listContextChildren(active.outputDir, '');
    // Hide pure link tables from the Markdown panel — an implementation detail, not
    // user-facing documents (same as the brain graph, which draws them as edges,
    // not nodes). active.hiddenLinkTables (precomputed at workspace open) covers
    // BOTH relation-declared junctions AND physical link tables created without
    // declared relations (e.g. an AI-built `files_<entity>`). Junction folders are
    // the TitleCase form of the snake_case table name; match case-insensitively.
    const entries = (r?.entries ?? []).filter(
      (e) => !(e.kind === 'dir' && active.hiddenLinkTables.has(e.name.toLowerCase())),
    );
    sendJson(res, { entries, truncated: r?.truncated ?? false });
    return true;
  }

  if (method === 'GET' && pathname === '/api/context/list') {
    const rel = decodeURIComponent(url.searchParams.get('path') ?? '');
    const r = rel ? listContextChildren(active.outputDir, rel) : null;
    if (!r) {
      sendJson(res, { error: 'context folder not found' }, 404);
      return true;
    }
    sendJson(res, { entries: r.entries, truncated: r.truncated });
    return true;
  }

  if (method === 'GET' && pathname === '/api/context/file') {
    const rel = decodeURIComponent(url.searchParams.get('path') ?? '');
    const base = active.outputDir.replace(/[/\\]+$/, '');
    const target = normalize(join(base, rel));
    const within = target === base || target.startsWith(base + sep);
    if (
      !rel ||
      !within ||
      !target.toLowerCase().endsWith('.md') ||
      !existsSync(target) ||
      !statSync(target).isFile()
    ) {
      sendJson(res, { error: 'context file not found' }, 404);
      return true;
    }
    // Defense-in-depth against symlinks (mirrors the /gui-assets guard).
    try {
      const real = realpathSync(target);
      const realBase = realpathSync(base);
      if (real !== realBase && !real.startsWith(realBase + sep)) {
        sendJson(res, { error: 'context file not found' }, 404);
        return true;
      }
    } catch {
      sendJson(res, { error: 'context file not found' }, 404);
      return true;
    }
    sendJson(res, {
      name: rel.split('/').pop() ?? rel,
      path: rel,
      content: readFileSync(target, 'utf8'),
    });
    return true;
  }

  // ── Per-row version history: the recoverable trail of every edit to one
  // row, newest first, from the GUI audit log. Bounded (clamped limit) so a
  // long-lived row's history can't be read unbounded.
  // GET /api/tables/:table/rows/:id/history
  // FOLLOW-UP: `_lattice_gui_audit` has no index on (table_name, row_id), so on a
  // large cloud audit log this filtered read is a sequential scan. Correctness is
  // fine (bounded by the clamped limit) and it's on-click (not a hot path); a
  // composite index is the optimization when audit volume warrants it.
  const rowHistMatch = ROW_HISTORY_PATH.exec(pathname);
  if (rowHistMatch && method === 'GET') {
    const histTable = decodeURIComponent(rowHistMatch[1] ?? '');
    const histRowId = decodeURIComponent(rowHistMatch[2] ?? '');
    const histLimitRaw = url.searchParams.get('limit');
    const histLimit = parsePageParam(histLimitRaw, 'limit');
    if (histLimit === 'invalid') {
      sendJson(res, { error: 'limit must be a non-negative integer' }, 400);
      return true;
    }
    const rows = (await active.db.query('_lattice_gui_audit', {
      filters: [
        { col: 'table_name', op: 'eq', val: histTable },
        { col: 'row_id', op: 'eq', val: histRowId },
      ],
      limit: histLimitRaw === null ? 100 : histLimit,
    })) as Record<string, unknown>[];
    const asStr = (v: unknown): string =>
      typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    const history = rows
      .map((r) => ({
        id: asStr(r.id),
        ts: asStr(r.ts),
        operation: asStr(r.operation),
        undone: r.undone === 1 || r.undone === true,
        sessionId: typeof r.session_id === 'string' ? r.session_id : null,
      }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    sendJson(res, { history });
    return true;
  }

  // ── Last-edited-by, per row, for one table ────────────────────────
  // GET /api/tables/:table/last-edited → { edits: { <pk>: {ownerUserId,
  // at} } }. Now empty — the "last edited by" map is rebuilt on the RLS
  // model later.
  const lastEditedMatch = LAST_EDITED_PATH.exec(pathname);
  if (lastEditedMatch && method === 'GET') {
    sendJson(res, { edits: {} });
    return true;
  }

  return false;
}
