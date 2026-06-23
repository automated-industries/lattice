import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, parsePageParam } from './http.js';
import { Lattice } from '../lattice.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { GuiRequestContext } from './request-context.js';
import {
  buildGuiGraph,
  getGuiEntities,
  getGuiProject,
  isJunctionTable,
  type GuiEntitiesPayload,
  type GuiTableSummary,
} from './data.js';
import { fullTextSearch } from '../search/fts.js';
import { ASSISTANT_HIDDEN_TABLES } from './ai/dispatch.js';
import { resolveColumnDescription, resolveTableDescription } from './column-descriptions.js';
import { parseAudit } from './mutations.js';
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
}

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

async function entitiesWithCounts(
  db: Lattice,
  configPath: string,
  outputDir: string,
): Promise<GuiEntitiesPayload> {
  const payload = getGuiEntities(configPath, outputDir);

  const yamlNames = new Set(payload.tables.map((t) => t.name));
  // Internal native entities (chat_threads/chat_messages) back the assistant's
  // conversation storage — they're real tables but must never surface in the
  // Objects list / dashboard cards. Drop them from the display payload here
  // (they stay registered + queryable for the chat route).
  const allTables = [...payload.tables, ...registeredExtraTables(db, yamlNames)].filter(
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

  return { ...payload, tables: enrichedTables };
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
    deps.sendText(
      res,
      deps.guiAppHtml.replace(
        '<!--LATTICE_VERSION-->',
        deps.guiVersion ? `v${deps.guiVersion}` : '',
      ),
      200,
      'text/html; charset=utf-8',
    );
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
    const yamlNames = new Set(
      getGuiEntities(active.configPath, active.outputDir).tables.map((t) => t.name),
    );
    const graphOpts: import('./data.js').BuildGuiGraphOptions = {
      extraTables: registeredExtraTables(active.db, yamlNames),
    };
    sendJson(res, buildGuiGraph(active.configPath, active.outputDir, graphOpts));
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
      for (const guiTable of getGuiEntities(active.configPath, active.outputDir).tables) {
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
    const sessionRows = (await active.db.query('_lattice_gui_audit', {
      filters: [{ col: 'session_id', op: 'eq', val: ctx.sessionId }],
    })) as Record<string, unknown>[];
    const sessionLive = sessionRows.filter((r) => Number(r.undone) === 0).length;
    const sessionUndone = sessionRows.length - sessionLive;
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
    if (method !== 'GET') {
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
    const def = active.entityContextByTable.get(ctxTable);
    const locator = buildRowContextLocator(ctxTable, row, def, active.manifest);
    if (!locator) {
      // No schema-registered context AND no matching manifest entry.
      // Surface an empty file list — the SPA renders its
      // "no rendered context" placeholder.
      sendJson(res, { files: [] });
      return true;
    }
    // Pull secret columns for this table so the rendered .md gets
    // redacted before it crosses the wire.
    const colMetaRows = (await active.db.query('_lattice_gui_column_meta', {
      filters: [
        { col: 'table_name', op: 'eq', val: ctxTable },
        { col: 'secret', op: 'eq', val: 1 },
      ],
    })) as { column_name: string }[];
    const secretCols = new Set(colMetaRows.map((r) => r.column_name));
    sendJson(res, { files: readRowContext(active.outputDir, locator, secretCols) });
    return true;
  }

  // ── Per-row version history (cloud): the recoverable trail of every
  // edit to one row, newest first.
  // GET /api/tables/:table/rows/:id/history. Empty on local SQLite.
  const rowHistMatch = ROW_HISTORY_PATH.exec(pathname);
  if (rowHistMatch && method === 'GET') {
    // Per-row history is rebuilt on the RLS change-feed (__lattice_changes)
    // in a follow-up; empty for now.
    sendJson(res, { history: [] });
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
