import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { sendJson, readJson } from './http.js';
import { Lattice } from '../lattice.js';
import { parseConfigFile, fieldToSqliteBaseType } from '../config/parser.js';
import { findLatticeRoot, workspaceDir } from '../framework/lattice-root.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  getWorkspace,
  addWorkspace,
  removeWorkspace,
  resolveWorkspacePaths,
} from '../framework/workspace.js';
import type { LatticeFieldDef } from '../config/types.js';
import type { EntityContextDefinition } from '../schema/entity-context.js';
import {
  buildGuiGraph,
  getGuiEntities,
  isJunctionByColumns,
  getGuiProject,
  isJunctionTable,
  fileJunctions,
  entityDescriptions,
  type GuiEntitiesPayload,
  type GuiTableSummary,
} from './data.js';
import {
  readManifest,
  manifestPath,
  writeManifest,
  type LatticeManifest,
} from '../lifecycle/manifest.js';
import { deriveCanonicalContexts } from '../framework/canonical-context.js';
import { guiAppHtml } from './app.js';
import type { Row, TableDefinition } from '../types.js';
import { RealtimeBroker, feedOpForChange, type RealtimePayload } from './realtime.js';
import { createFileLoopbackWatcher, type FileLoopbackWatcher } from './file-watcher.js';
import { buildRowContextLocator, readRowContext } from './row-context.js';
import { createUpdateService, type UpdateService } from './update-service.js';
import { getAsyncOrSync, allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { registerPostgresPolyfills } from '../db/postgres.js';
import { isPostgresUrl } from '../cloud/url.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { discoverCloudTables } from '../cloud/discover.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableChatPrivacyRls,
  ownPolyfillsByGroup,
} from '../cloud/rls.js';
import { installCloudSettings } from '../cloud/settings.js';
import { reconcileCloudMemberAccess } from '../cloud/setup.js';
import { columnDescriptionHook, tableDescriptionHook } from './meta-gen.js';
import {
  resolveColumnDescription,
  resolveTableDescription,
  upsertColumnMeta,
  upsertTableMeta,
} from './column-descriptions.js';
import { rowAccessSummaries } from '../cloud/members.js';
import { FeedBus } from './feed.js';
import { fullTextSearch } from '../search/fts.js';
import {
  createRow,
  updateRow,
  deleteRow,
  linkRows,
  unlinkRows,
  parseAudit,
  undoLast,
  redoLast,
  revertEntry,
  recordSchemaAudit,
  isSchemaOp,
  type AuditEntry,
  type MutationCtx,
} from './mutations.js';
import { execSql, loadConfigDoc, saveConfigDoc } from './config-io.js';
import {
  physicalTableExists,
  physicalColumnExists,
  emitDdlEnvelope,
  recordSchemaOp,
  materializeJunction,
  createFileJunction,
  createUserJunction,
  createUserEntity,
  addUserColumn,
  softDeleteUserEntity,
  aiDeleteEntity,
  type DeleteResolution,
} from './schema-ops.js';
import { dispatchUserConfigRoute } from './userconfig-routes.js';
import { dispatchDbConfigRoute, redeemInvite } from './dbconfig-routes.js';
import { dispatchFilesRoute } from './files-routes.js';
import {
  dispatchAssistantRoute,
  getAggressiveness,
  retireLegacyPreferenceSecrets,
} from './assistant-routes.js';
import { dispatchChatRoute } from './chat-routes.js';
import { dispatchIngestRoute } from './ingest-routes.js';
import {
  registerNativeEntities,
  adoptNativeEntities,
  listNativeBindings,
  isNativeEntity,
  isInternalNativeEntity,
  NATIVE_INTERNAL_NAMES,
} from '../framework/native-entities.js';
import { ASSISTANT_HIDDEN_TABLES } from './ai/dispatch.js';
import {
  getOrCreateMasterKey,
  readIdentity,
  writeIdentity,
  deleteDbCredential,
  saveDbCredential,
  healRawDbUrl,
} from '../framework/user-config.js';
import type { StorageAdapter } from '../db/adapter.js';
import { countManyPostgres, exactCountMany } from './count-many.js';
import { RenderProgressBus } from './render-progress.js';
import type { RenderProgress } from '../render/progress.js';
import {
  setTableDefaultVisibility,
  setTableNeverShare,
  getAllTablePolicies,
} from '../cloud/table-policy.js';
import { setColumnAudience } from '../cloud/audience.js';

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

/**
 * Augment the entities payload with row counts so the dashboard cards can
 * show "Meetings · 4" without a second round-trip. Junction tables get a
 * count too — the Data Model UI uses them, even though the Objects sidebar
 * filters them out.
 */
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

// Structural columns Lattice manages — never renamable, retypable, deletable,
// or maskable from the GUI. `id` is the uuid primary key; the timestamps +
// soft-delete column carry semantics undo/redo + freshness depend on.
const SCHEMA_SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
// The only column types a user may CREATE. `uuid` is reserved for keys
// (the id PK + foreign keys) and enforced by Lattice, not user-selectable.
const ALLOWED_COLUMN_TYPES = new Set(['text', 'integer', 'real', 'boolean']);

/** The entity a column references (a foreign-key "link"), or null. */
function columnRefTarget(configPath: string, entity: string, col: string): string | null {
  const ref: unknown = loadConfigDoc(configPath).getIn(['entities', entity, 'fields', col, 'ref']);
  return typeof ref === 'string' && ref ? ref : null;
}

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

const ROWS_PATH = /^\/api\/tables\/([^/]+)\/rows(?:\/(.+))?$/;
const CONTEXT_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/context$/;
const ROW_HISTORY_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/history$/;
const LAST_EDITED_PATH = /^\/api\/tables\/([^/]+)\/last-edited$/;
const LINK_PATH = /^\/api\/tables\/([^/]+)\/(link|unlink)$/;

/**
 * Read one request header as a trimmed string (Node lowercases header names and
 * may hand back an array for repeated headers — collapse to the first value).
 * Returns undefined when absent or blank so callers can treat "no header" and
 * "empty header" identically.
 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof v === 'string' ? v.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Max rows a single `/rows` page may request — caps cloud egress on a hot path
 *  (Rule: bounded reads). A caller wanting more pages with limit+offset. */
const MAX_ROWS_PAGE = 1000;
const DEFAULT_ROWS_PAGE = 500;

/**
 * Parse + validate a `limit`/`offset` query param (#4.9). Returns the numeric
 * value, or `'invalid'` for a non-numeric / negative / non-integer string (the
 * caller returns 400 instead of letting `Number('abc')` become `LIMIT NaN`).
 * `limit` is clamped to `[1, MAX_ROWS_PAGE]`; `offset` floored at 0.
 */
function parsePageParam(raw: string | null, kind: 'limit' | 'offset'): number | 'invalid' {
  if (raw === null) return kind === 'limit' ? DEFAULT_ROWS_PAGE : 0;
  if (!/^\d+$/.test(raw.trim())) return 'invalid';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'invalid';
  if (kind === 'limit') return Math.min(Math.max(1, n), MAX_ROWS_PAGE);
  return Math.max(0, n);
}

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
export interface RenderStatusSnapshot {
  /** Coarse lifecycle: idle (never started) → running → done | error. */
  phase: 'idle' | 'running' | 'done' | 'error';
  /** The table currently being rendered, if any. */
  currentTable?: string;
  /** Zero-based index of {@link currentTable} among the entity-context tables. */
  tableIndex?: number;
  /** Total number of entity-context tables in this render. */
  tableCount?: number;
  /** Per-table progress, keyed by table name. */
  tables: Record<
    string,
    { pct: number; entitiesRendered: number; entitiesTotal: number; done: boolean }
  >;
  /** Wall-clock duration of the render, set when it completes. */
  durationMs?: number;
  /** Error text when {@link phase} is `error`. */
  error?: string;
}

export interface ActiveDb {
  configPath: string;
  outputDir: string;
  db: Lattice;
  validTables: Set<string>;
  junctionTables: Set<string>;
  /**
   * Entity contexts registered on the live Lattice — covers both YAML and
   * programmatic `defineEntityContext()` registrations. Tables missing here
   * fall back to {@link ActiveDb.manifest} for row-context discovery.
   */
  entityContextByTable: Map<string, EntityContextDefinition>;
  /**
   * Last-read render manifest. Used as the fallback when a table has no
   * registered {@link EntityContextDefinition} but has rendered context
   * files on disk — typically when the user defines entity contexts in
   * an mjs/ts module the GUI process never imports. Re-read on each
   * `openConfig` so manual `lattice render` runs are picked up the next
   * time the GUI swaps DBs (or on next request via a small cache).
   */
  manifest: LatticeManifest | null;
  softDeletable: Set<string>;
  /**
   * Active LISTEN/NOTIFY broker when the underlying Lattice is backed
   * by Postgres. Null for SQLite (no realtime). Owned by the active
   * DB; replaced wholesale on switch.
   */
  realtime: RealtimeBroker | null;
  /**
   * In-process activity feed for the sidebar. Unlike {@link ActiveDb.realtime}
   * (Postgres-only), this works for every dialect — every audited mutation is
   * published here and streamed to the sidebar as `feed` messages on the
   * multiplexed `/api/stream` WebSocket. Owned by the active DB; replaced
   * wholesale on switch (clients reconnect).
   */
  feed: FeedBus;
  /**
   * File loopback watcher (workspace/autoRender mode only; null otherwise).
   * Captures edits to the rendered tree back into the DB via the changelog path.
   * Started by startBackgroundRender, stopped by disposeActive.
   */
  fileWatcher: FileLoopbackWatcher | null;
  /**
   * Once-guard: true after the broker→re-render subscription is wired (eager
   * per-viewer freshness — a remote change re-renders this member's tree). Set in
   * {@link startBackgroundRender}, which can be called more than once per ActiveDb.
   */
  eagerRenderWired?: boolean;
  /**
   * Tables the open-time cloud converge could not manage (e.g. owned by a
   * different Postgres role). Empty on a clean open. Surfaced via /api/dbconfig so
   * the user gets a specific, actionable message instead of a partial converge.
   */
  convergeWarnings: { table: string; reason: string }[];
  /** Original db: connection string from the YAML, used to spin up the broker. */
  dbPath: string;
  /**
   * Workspace mode: canonical entity contexts are auto-derived and every
   * mutation schedules a render. Drives whether a runtime schema creation
   * registers a canonical context inline (so the new table renders without a
   * reopen). False for plain `lattice gui --config x.yml` (manifest-only).
   */
  autoRender: boolean;
  /**
   * Per-table render progress bus for this workspace. The background render
   * publishes {@link RenderProgress} events here; the GUI subscribes via the
   * `render-progress` messages on the multiplexed `/api/stream` WebSocket. Always
   * constructed (even for SQLite / non-autoRender) so the stream has a live
   * target; replaced wholesale on switch.
   */
  renderProgress: RenderProgressBus;
  /**
   * Aborts the in-flight background render for this workspace. {@link disposeActive}
   * fires it before closing the DB so the render loop bails before its next query
   * hits a closing adapter. One controller per workspace (single-use).
   */
  renderAbort: AbortController;
  /** Folded snapshot of {@link renderProgress}, served over `/api/render/status`. */
  renderState: RenderStatusSnapshot;
  /**
   * #2.1 — base table → its audience-masking view (`<table>_v`) for the rows a
   * MEMBER must read through. A secured cloud REVOKEs base SELECT from members
   * for any table with a column audience and grants only the masking view, so a
   * member's base read would be `permission denied`; the read path routes those
   * SELECTs to the view (writes still target the base under RLS). Empty for an
   * owner open and for local/SQLite (no masking, base SELECT intact).
   */
  maskedReadViews: Map<string, string>;
  /**
   * Non-blocking, fail-silent hooks (attached by openConfig) that auto-generate
   * column / table definitions via a cheap model when a user creates them.
   * `onColumnsAdded` feeds {@link MutationCtx}; `generateTableDescription` is
   * called by createUserEntity. No-op without Claude auth.
   */
  onColumnsAdded?: (table: string, columns: string[]) => void;
  generateTableDescription?: (table: string, columns: string[]) => void;
}

/**
 * Resolve the rendered-context root for a SPECIFIC config, probing relative to
 * that config's own directory (not the GUI launch cwd). Used when the GUI
 * switches to / creates a different database so each DB's rendered-context view
 * reflects its own render — never a stale launch-directory manifest. Returns an
 * absolute path; when no co-located manifest exists, returns `<configDir>/context`
 * (which has no manifest → the GUI shows no manifest-sourced entities for that
 * DB, instead of showing another DB's rendered files).
 */
function resolveOutputDirForConfig(configPath: string): string {
  const base = dirname(resolve(configPath));
  for (const dir of ['context', '.', 'generated']) {
    const abs = resolve(base, dir);
    if (existsSync(join(abs, '.lattice', 'manifest.json'))) return abs;
  }
  return resolve(base, 'context');
}

// Exported for tests: builds a fully-wired ActiveDb from a config on disk so
// the no-reopen schema primitives (e.g. the assistant's table delete) can be
// exercised directly without standing up the whole HTTP server.
export async function openConfig(
  configPath: string,
  outputDir: string,
  autoRender = false,
  realtimeWatchdogMs?: number,
): Promise<ActiveDb> {
  // Heal a legacy config that still stores a RAW postgres:// URL (password in
  // cleartext on disk): move it into the encrypted credential store and rewrite
  // the db: line to a ${LATTICE_DB:label} reference. Idempotent + a no-op for
  // already-referenced / SQLite configs. Done BEFORE parsing so the parse resolves
  // the new reference. parsed.dbPath is the same URL either way, so the open is
  // unaffected — only the at-rest secret is removed.
  healRawDbUrl(configPath);
  const parsed = parseConfigFile(configPath);
  // Only ensure a parent directory for real filesystem DB paths. When `db:` is
  // a connection string (postgres://…), a `file:` URL, or `:memory:`,
  // parseConfigFile passes it through verbatim, so `parsed.dbPath` is the URL —
  // not a path. dirname() of such a value yields a string containing ':',
  // which is illegal in a Windows path, so mkdirSync throws ENOENT and the GUI
  // dies before it ever connects. The mkdir is meaningless for those anyway.
  if (
    !/^postgres(ql)?:\/\//i.test(parsed.dbPath) &&
    !parsed.dbPath.startsWith('file:') &&
    parsed.dbPath !== ':memory:'
  ) {
    mkdirSync(dirname(parsed.dbPath), { recursive: true });
  }
  // Native entities (`secrets`, `files`) include encrypted columns —
  // every GUI-opened Lattice must have an encryption key. Resolve once
  // here (env var or auto-generated `~/.lattice/master.key`) and feed
  // into the Lattice options so `_validateEncryptionConfig` is happy
  // at init() time.
  const encryptionKey = getOrCreateMasterKey();
  const db = new Lattice({ config: configPath }, { encryptionKey });
  registerNativeEntities(db);
  // GUI-only meta table: per-entity icon overrides edited from the browser.
  // Defined dynamically (not in the user's YAML) so it never appears in
  // /api/entities or any user-facing list.
  db.define('_lattice_gui_meta', {
    columns: {
      entity_name: 'TEXT PRIMARY KEY',
      icon: 'TEXT',
      // Operator-authored or auto-generated table definition.
      description: 'TEXT',
      updated_at: "TEXT DEFAULT (datetime('now'))",
    },
    primaryKey: 'entity_name',
    render: () => '',
    outputFile: '.lattice-gui/meta.md',
  });
  // Per-column GUI metadata — currently just the 'secret' flag used to
  // mask values with bullets in the table / detail / context views.
  db.define('_lattice_gui_column_meta', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      table_name: 'TEXT NOT NULL',
      column_name: 'TEXT NOT NULL',
      secret: 'INTEGER NOT NULL DEFAULT 0',
      // Operator-authored or auto-generated column definition (boot reconcile
      // adds it to existing tables; non-destructive).
      description: 'TEXT',
      updated_at: "TEXT DEFAULT (datetime('now'))",
    },
    render: () => '',
    outputFile: '.lattice-gui/column-meta.md',
  });
  // Machine-local user identity, mirrored into the active Lattice from
  // ~/.lattice/identity.json on every open. Single-row (`id='singleton'`).
  // Lets queries inside the active DB reference "who is sitting here"
  // without reaching across into ~/.lattice/.
  db.define('__lattice_user_identity', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Single-quoted empty-string defaults below — not double-quoted!
      // SQLite leniently accepts `DEFAULT ""` as an empty string literal,
      // but PostgreSQL treats `""` as a zero-length delimited identifier
      // (i.e. an empty column name), which throws `zero-length delimited
      // identifier at or near """""` from the parser before any rows are
      // inserted. This is the standard-conformant behavior — single
      // quotes are for string literals; double quotes are for
      // identifiers. Use `''` so the CREATE TABLE works on both engines.
      display_name: "TEXT NOT NULL DEFAULT ''",
      email: "TEXT NOT NULL DEFAULT ''",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
    },
    primaryKey: 'id',
    render: () => '',
    outputFile: '.lattice-native/user-identity.md',
  });
  // Linear audit log of all mutations the GUI performs. Powers undo/redo
  // and the version-history page. Per-DB (each lattice config has its own).
  db.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      undone: 'INTEGER NOT NULL DEFAULT 0',
      // The GUI session (one per server process) that made the change. The
      // header undo/redo stack is scoped to the current session — you undo
      // YOUR OWN recent actions, not another cloud user's edit — while the
      // version-history per-entry Revert can revert any entry regardless of
      // session. Nullable + additive (back-compat with pre-1.16 rows); added
      // idempotently to existing DBs by the schema reconcile.
      session_id: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-gui/audit.md',
  });
  // Workspace opens only: give every user table a canonical, DB-aligned entity
  // context (table → folder, row → subfolder, <ENTITY>.md + relation rollups)
  // unless the config already declares one. Without this, a table like `tasks`
  // has no per-row context to render, so the row view shows "No rendered
  // context". Mirrors Lattice.openWorkspace. NOT applied to a plain
  // `lattice gui --config x.yml`, which must keep serving exactly what was
  // rendered externally (the manifest-fallback contract).
  if (autoRender) {
    const existingContexts = db.entityContexts();
    for (const { table, definition } of deriveCanonicalContexts(parsed.tables)) {
      if (!existingContexts.has(table)) db.defineEntityContext(table, definition);
    }
  }

  // Member-open vs owner-open for a cloud (Postgres). A scoped member connects
  // as a non-superuser role with no CREATE/ALTER privilege, so a normal init()
  // (which applies the schema) would fail against an already-provisioned cloud.
  // Peek with a throwaway introspect-only connection: if the target is a cloud
  // (RLS installed) AND this role can't create roles (i.e. it's a member, not the
  // owner/DBA), open `introspectOnly` (no DDL) and register the physical tables
  // the role can see — the member's local config may declare none. The owner /
  // DBA path keeps the full init (idempotent CREATE IF NOT EXISTS on an existing
  // cloud). SQLite and fresh Postgres fall through to the normal init.
  let memberOpen = false;
  // #2.1 — base table → masking view (`<table>_v`) for member reads. Populated on a
  // cloud member open for tables whose base SELECT was revoked in favor of the view.
  const maskedReadViews = new Map<string, string>();
  // Junction tables a MEMBER discovered from the catalog. A junction is not an
  // object, but a member has no relation config to classify it (relations live
  // only in the owner's config, never in the DB), so it is classified from its
  // physical column shape and kept out of the member's table set.
  const discoveredJunctions = new Set<string>();
  if (db.getDialect() === 'postgres') {
    const peek = new Lattice({ config: configPath }, { encryptionKey });
    try {
      await peek.init({ introspectOnly: true });
      // Probe RLS-installed + role privilege CONCURRENTLY — two independent
      // read-only queries, previously serial. The gate below is identical: a
      // member open requires RLS installed AND no role-management privilege.
      // (canManageRoles runs unconditionally now; on a non-cloud Postgres it is a
      // harmless extra read whose result is simply unused.)
      const [rlsInstalled, canManage] = await Promise.all([
        cloudRlsInstalled(peek),
        canManageRoles(peek),
      ]);
      if (rlsInstalled) {
        memberOpen = !canManage;
        if (memberOpen) {
          const declared = new Set(db.getRegisteredTableNames());
          // Discover member-visible tables and the masking views CONCURRENTLY —
          // both are privilege-filtered, read-only introspection and independent.
          const [discovered, viewsRaw] = await Promise.all([
            discoverCloudTables(peek),
            allAsyncOrSync(
              peek.adapter,
              `SELECT table_name AS name FROM information_schema.views
                 WHERE table_schema = current_schema() AND table_name LIKE '%\\_v' ESCAPE '\\'`,
            ),
          ]);
          const views = viewsRaw as { name: string }[];
          const knownTables = new Set<string>([...declared, ...discovered.map((t) => t.name)]);
          // Discovered entity tables (name + a minimal definition) collected so we
          // can synthesize a default render layout from them below — the member's
          // config has `entities: {}`, so without this the render writes 0 files.
          const memberEntityDefs: { name: string; definition: TableDefinition }[] = [];
          for (const t of discovered) {
            if (declared.has(t.name)) continue;
            // A table the member has no column access to introspects to zero
            // columns (information_schema is privilege-filtered). Registering it
            // would surface an empty-schema entity that fails every read with
            // `unknown column "deleted_at"`; skip it so the member only sees
            // tables they can actually read.
            if (t.columns.length === 0) continue;
            // A junction table is not an object. The owner hides it via its
            // relation config, but a member has no config — so detect it from the
            // physical column shape (id + exactly two `*_id` columns, no payload)
            // and keep it out of the member's table set entirely. Without this the
            // member's sidebar lists every link table as a fake object, while the
            // owner's (config-driven) sidebar correctly omits them.
            if (isJunctionByColumns(t.columns)) {
              discoveredJunctions.add(t.name);
              continue;
            }
            const def: TableDefinition = {
              columns: Object.fromEntries(t.columns.map((c) => [c, 'TEXT'])),
              ...(t.pk.length > 0 ? { primaryKey: t.pk.length === 1 ? t.pk[0] : t.pk } : {}),
              render: () => '',
              outputFile: `${t.name}/.lattice/${t.name}.md`,
            };
            db.define(t.name, def);
            memberEntityDefs.push({ name: t.name, definition: def });
          }
          // A member only SEES `<base>_v` views it was granted SELECT on (the
          // audience-masking view for a table whose base SELECT was revoked).
          for (const { name } of views) {
            const base = name.slice(0, -2); // strip the "_v" suffix
            if (knownTables.has(base)) maskedReadViews.set(base, name);
          }
          // Synthesize a default per-row context tree from the introspected schema
          // so a member's render produces context FILES. The render layout
          // (entityContexts) lives ONLY in the owner's config, which the cloud
          // model never ships to members — so a member's `entities: {}` config
          // rendered 0 files even though they can read every row. The database is
          // the source of truth, so we derive a canonical layout from the tables
          // the member can actually see (same helper the owner uses on its
          // config). belongsTo/hasMany rollups need relations a member can't
          // introspect, so these are self-context-only — but that is the
          // difference between the full per-row tree and nothing. Gated on
          // autoRender to match the owner path; skips tables already declared.
          if (autoRender && memberEntityDefs.length > 0) {
            const existingContexts = db.entityContexts();
            for (const { table, definition } of deriveCanonicalContexts(memberEntityDefs)) {
              if (!existingContexts.has(table)) db.defineEntityContext(table, definition);
            }
          }
        }
      }
    } catch {
      // Unreachable, not a cloud, or a fresh DB — use the normal init() below.
    } finally {
      peek.close();
    }
  }
  await db.init(memberOpen ? { introspectOnly: true } : {});

  // Per-viewer render: on a cloud MEMBER open, route every render-time table read
  // through the member's masking view (`<table>_v`) when one exists, so the
  // rendered context tree on disk is the member's own RLS-scoped, cell-masked
  // projection (what get_row_context then serves). Owner / SQLite leave the
  // resolver at identity. Set before any render is started.
  if (memberOpen) {
    if (maskedReadViews.size > 0) {
      db.setRenderReadRelation((table) => maskedReadViews.get(table) ?? table);
    }
    // Overlay this member's visible derived enrichments onto the rendered rows.
    db.enableRenderFold();
  }

  // Mirror ~/.lattice/identity.json into __lattice_user_identity so the
  // active Lattice has a current view of who the operator is. Idempotent:
  // every open just upserts the single 'singleton' row.
  await syncUserIdentityRow(db);

  // Owner-side maintenance — SKIP on a cloud MEMBER open. Both write DDL/rows in
  // the schema (create native tables / soft-delete legacy secrets); a scoped
  // member has no such grant (the bootstrap REVOKEs CREATE from PUBLIC), so
  // running them would fail the open with "permission denied for schema public".
  // The member's tables are already registered via discoverCloudTables above.
  if (!memberOpen) {
    // Reconcile + record native-entity bindings (files, secrets). Labels a
    // pre-existing files/secrets table as THE native object (merging the native
    // column superset, non-destructively) rather than duplicating it, and
    // guarantees the tables exist on freshly created DBs.
    await adoptNativeEntities(db);
    // Retire legacy per-workspace preference rows (voice provider + inference
    // aggressiveness) older builds stored in `secrets`. They're machine-local
    // preferences now, so soft-delete leftovers. Idempotent.
    await retireLegacyPreferenceSecrets(db);
  }

  // Tables the open-time converge couldn't manage (e.g. owned by a different
  // Postgres role), surfaced to the client via /api/dbconfig so the user sees a
  // specific, actionable message instead of a silent partial converge.
  let convergeWarnings: { table: string; reason: string }[] = [];
  // Cloud OWNER open: converge the idempotent cloud bootstrap (RLS objects +
  // settings + observation substrate) so objects ADDED to the bootstrap in a
  // later release reach clouds already stamped at an earlier version — the class
  // of bug where __lattice_member_invites never reached existing clouds and a
  // version-gated `secure` no-op'd. Pure CREATE … IF NOT EXISTS / CREATE OR
  // REPLACE — cheap, no row scans. The EXPENSIVE per-table ownership/RLS backfill
  // stays gated in secureCloud (internal guideline — no whole-table scans on open).
  if (db.getDialect() === 'postgres' && !memberOpen) {
    try {
      if ((await cloudRlsInstalled(db)) && (await canManageRoles(db))) {
        // Ensure the SQLite-compat polyfills exist, created by the OWNER (who has
        // CREATE) — so an already-secured cloud whose revoke ran before they were
        // ever created gets them now, before any member connects. Idempotent.
        await registerPostgresPolyfills((sql) => runAsyncOrSync(db.adapter, sql));
        await installCloudRls(db);
        await ownPolyfillsByGroup(db); // group-own polyfills so any member can upgrade them
        await installCloudSettings(db);
        await db.ensureObservationSubstrate();
        await enableChangelogRls(db); // converges the v3 fail-closed changelog policy
        await enableChatPrivacyRls(db); // per-author RESTRICTIVE lock on chat tables (fail-closed on NULL owner)
        // Converge per-table member access (ungated, no row scans): force the
        // private-only conversation/secret tables to never_share, and re-issue
        // member grants the version-gated per-table securing won't re-emit after
        // a grant-dropping restore. Keeps "shows as shared" == "is readable".
        // Per-table fault-isolated: a table this role can't manage (e.g. owned by
        // a different role) is skipped + reported, never aborting the rest.
        const access = await reconcileCloudMemberAccess(db);
        convergeWarnings = access.skipped;
        for (const s of convergeWarnings) {
          console.warn(`[openConfig] cloud converge could not manage "${s.table}": ${s.reason}`);
        }
      }
    } catch (e) {
      // internal guideline: never silently swallow. A converge failure must be visible, but
      // shouldn't crash the GUI — the owner can still work; `secure` re-runs it.
      console.error('[openConfig] cloud bootstrap converge failed:', (e as Error).message);
    }
  }

  // Queryable tables = YAML-declared tables PLUS every table registered on the
  // live Lattice that isn't internal bookkeeping. This includes native
  // entities (files/secrets), team-shared tables auto-registered below, and
  // any programmatic db.define(). Mirrors the filter entitiesWithCounts uses
  // to surface cards, so a card that appears is always queryable (previously
  // native entities showed as cards but 400'd with "Unknown table").
  const validTables = new Set(parsed.tables.map((t) => t.name));
  for (const name of db.getRegisteredTableNames()) {
    if (name.startsWith('__lattice_') || name.startsWith('_lattice_')) continue;
    validTables.add(name);
  }
  const junctionTables = new Set([
    ...getGuiEntities(configPath, outputDir)
      .tables.filter(isJunctionTable)
      .map((t) => t.name),
    // Member-discovered junctions (classified from the physical shape above);
    // empty for an owner/local open.
    ...discoveredJunctions,
  ]);
  // Pull entity contexts from the live Lattice — covers both YAML-declared
  // contexts (already loaded in the constructor from `parsed.entityContexts`)
  // and anything a caller registered via `db.defineEntityContext()` against
  // this Lattice instance.
  const entityContextByTable = db.entityContexts();
  // Read the on-disk render manifest. Tables not registered above (e.g.
  // the user defines entity contexts in `lattice.schema.mjs` and runs
  // `lattice render` separately) fall through to this manifest to find
  // their rendered directories.
  const manifest = readManifest(outputDir);
  // Any queryable table with a deleted_at column gets soft-delete semantics in
  // the GUI (filter out deleted rows on list; soft-delete on DELETE). Derived
  // from the live schema so native files/secrets (which both have deleted_at)
  // are soft-deleted rather than hard-deleted.
  const softDeletable = new Set<string>();
  for (const name of validTables) {
    const cols = db.getRegisteredColumns(name);
    if (cols && 'deleted_at' in cols) softDeletable.add(name);
  }
  // The cloud's shared tables are defined by the config `entities:` block and
  // registered on the live Lattice at init. `validTables` + `softDeletable`
  // were built from the manifest above; re-capture the live registered set now
  // so every physically-present, RLS-governed table is queryable here. Row
  // visibility is enforced by Postgres RLS at the database — the app layer no
  // longer filters the visible set.
  for (const name of db.getRegisteredTableNames()) {
    if (name.startsWith('__lattice_') || name.startsWith('_lattice_')) continue;
    validTables.add(name);
    if (!softDeletable.has(name)) {
      const sharedCols = db.getRegisteredColumns(name);
      if (sharedCols && 'deleted_at' in sharedCols) softDeletable.add(name);
    }
  }

  // Realtime broker — only meaningful when the active DB is Postgres.
  // The broker connects on creation; status/payload events stream out
  // via the SSE endpoint. SQLite configs leave this as null and the
  // status pill reports the local-mode (yellow) state.
  let realtime: RealtimeBroker | null = null;
  if (db.getDialect() === 'postgres') {
    try {
      realtime = new RealtimeBroker(
        parsed.dbPath,
        realtimeWatchdogMs !== undefined ? { watchdogIntervalMs: realtimeWatchdogMs } : {},
      );
      await realtime.start();
    } catch (e) {
      console.warn('[openConfig] realtime broker init failed:', (e as Error).message);
      realtime = null;
    }
  }

  // Workspace opens only: keep the rendered Context/ tree synced with the DB at
  // all times — enable debounced auto-render so every insert/update/delete
  // re-renders (unchanged files skipped via the manifest hash-diff), and do one
  // initial render so the row-context view has content immediately. With the
  // canonical contexts derived above, every table renders per-row context, so
  // the GUI never shows "No rendered context for this row". A plain
  // `lattice gui --config x.yml` opts out (autoRender=false) and serves only
  // what was rendered externally.
  if (autoRender) {
    db.enableAutoRender(outputDir);
    // The full render is intentionally NOT awaited here — `openConfig` runs
    // before `disposeActive` on every switch, so it must stay a pure "construct
    // ActiveDb" function that returns instantly. The caller kicks off the actual
    // render in the background via `startBackgroundRender(active)` once the server
    // is already serving (see the call sites after each `active =` assignment).
    if (!existsSync(manifestPath(outputDir))) {
      writeManifest(outputDir, {
        version: 2,
        generated_at: new Date().toISOString(),
        entityContexts: {},
      });
    }
  }

  const feed = new FeedBus();
  // File loopback: edits to the rendered tree flow back to the DB through the
  // changelog path. Only in workspace (autoRender) mode; constructed here, started
  // by startBackgroundRender, stopped by disposeActive.
  const fileWatcher = autoRender
    ? createFileLoopbackWatcher({ db, feed, softDeletable, outputDir })
    : null;

  return {
    configPath,
    outputDir,
    db,
    validTables,
    junctionTables,
    entityContextByTable,
    manifest,
    softDeletable,
    realtime,
    feed,
    fileWatcher,
    convergeWarnings,
    dbPath: parsed.dbPath,
    autoRender,
    renderProgress: new RenderProgressBus(),
    renderAbort: new AbortController(),
    renderState: { phase: 'idle', tables: {} },
    maskedReadViews,
    onColumnsAdded: columnDescriptionHook(db),
    generateTableDescription: tableDescriptionHook(db),
  };
}

/**
 * Friendly display name for a YAML config: prefer the `name:` key when
 * the user has set one (via Database Settings → rename), fall back to
 * the config file's basename minus the .yml extension. Pure function —
 * safe to use anywhere the GUI renders a DB label.
 */
function friendlyConfigName(parsedName: string | undefined, configPath: string): string {
  if (parsedName && parsedName.trim().length > 0) return parsedName.trim();
  return basename(configPath).replace(/\.(ya?ml)$/, '');
}

/**
 * List sibling YAML configs in the same directory as the currently active
 * config. Each entry includes the parsed `db:` value when available so the
 * UI can show the underlying DB filename.
 */
interface ListedConfig {
  path: string;
  name: string;
  label: string;
  dbFile: string;
  active: boolean;
  /** Per-row connection kind so the dropdown can tag each entry without probing. */
  kind: 'local' | 'cloud';
}

function listConfigs(activeConfigPath: string): ListedConfig[] {
  const dir = dirname(activeConfigPath);
  const entries: ListedConfig[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
    const full = join(dir, fname);
    try {
      const parsed = parseConfigFile(full);
      entries.push({
        path: full,
        // `name` stays as the filename basename for compatibility with
        // existing callers that key by it (URL fragments, sort order).
        name: fname.replace(/\.(ya?ml)$/, ''),
        // `label` is the friendly DB name — what the user sees in the
        // dropdown + settings. Falls back to the basename when unset.
        label: friendlyConfigName(parsed.name, full),
        dbFile: basename(parsed.dbPath),
        active: full === activeConfigPath,
        // `${LATTICE_DB:...}` and postgres:// configs resolve to a
        // postgres URL; everything else is a local SQLite file. This
        // lets inactive rows show the correct Cloud/Local tag instead
        // of defaulting every non-active row to Local.
        kind: /^postgres(ql)?:\/\//i.test(parsed.dbPath) ? 'cloud' : 'local',
      });
    } catch {
      // Not a valid lattice config — skip silently.
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Apply a SQL statement directly via the active adapter. The Lattice instance
 * itself doesn't expose ALTER TABLE on its CRUD surface, so we reach into the
 * adapter's async run() for schema migrations the user triggers from the GUI.
 */
/**
 * Write a starter YAML config + an empty SQLite DB. The workspace starts with
 * NO entities (no example `items` table as of 1.16.3) — the user defines their
 * own schema via the Data Model editor or by editing the YAML.
 */
function createBlankConfig(activeConfigPath: string, dbName: string): string {
  const dir = dirname(activeConfigPath);
  // Slug the user-provided name into a safe filename.
  const slug = dbName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Workspace name must contain at least one alphanumeric character');
  const configPath = join(dir, `${slug}.config.yml`);
  if (existsSync(configPath)) throw new Error(`Config already exists: ${slug}.config.yml`);
  const yaml = `db: ./data/${slug}.db\n\nentities: {}\n`;
  writeFileSync(configPath, yaml, 'utf8');
  // Ensure the data dir exists so opening the new config doesn't fail.
  mkdirSync(join(dir, 'data'), { recursive: true });
  return configPath;
}

/**
 * The on-disk db file behind a local SQLite config, or null when the config
 * points at a Postgres URL / `${LATTICE_DB:label}` / `:memory:` / `file:` (in
 * which case there is no local file for us to remove). Classifies from the raw
 * `db:` YAML line — deliberately NOT via parseConfigFile, so a cloud config
 * with a missing saved credential still classifies as cloud instead of throwing.
 */
export function sqliteFileForConfig(configPath: string): string | null {
  const dbVal = parseDocument(readFileSync(configPath, 'utf8')).get('db');
  const raw = (typeof dbVal === 'string' ? dbVal : '').trim();
  if (!raw) return null;
  if (isPostgresUrl(raw) || raw.startsWith('${LATTICE_DB:')) return null;
  if (raw === ':memory:' || raw.startsWith('file:')) return null;
  return resolve(dirname(configPath), raw);
}

/**
 * Permanently delete a database: its YAML config and — for a local SQLite DB —
 * the underlying `.db` file plus its `-wal`/`-shm`/`-journal` siblings.
 * Destructive + irreversible; the caller is responsible for confirmation and
 * (when deleting the active DB) switching away first so the file handle is
 * released before we unlink. For cloud configs only the local YAML is removed —
 * the remote Postgres database is shared and is never touched from here.
 */
export function deleteDatabaseFiles(targetConfigPath: string): {
  deletedConfig: string;
  deletedDbFile: string | null;
} {
  const sqliteFile = sqliteFileForConfig(targetConfigPath);
  unlinkSync(targetConfigPath);
  let deletedDbFile: string | null = null;
  if (sqliteFile && existsSync(sqliteFile)) {
    unlinkSync(sqliteFile);
    deletedDbFile = sqliteFile;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = sqliteFile + suffix;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  }
  return { deletedConfig: basename(targetConfigPath), deletedDbFile };
}

/**
 * Tear down an ActiveDb: stop the realtime broker (if any), then close
 * the Lattice. Called before reopening or swapping configs so listeners
 * + pg clients don't leak.
 */
/**
 * Minimum spacing between eager re-renders triggered by remote changes. Caps the
 * shared-quota egress of "re-render on every remote change" under a sustained
 * stream, while keeping a member's per-viewer tree fresh within ~1.5s.
 */
const EAGER_RERENDER_MIN_INTERVAL_MS = 1500;
/**
 * Kick off the background render for `active` — fire-and-forget. Returns
 * immediately; the render churns on its own and folds progress into
 * `active.renderState` while publishing each event to `active.renderProgress`
 * for the GUI's `render-progress` messages on the multiplexed `/api/stream`.
 *
 * Called once the server is already serving and after every `active =`
 * (re)assignment, so opening/switching a workspace answers `/` and
 * `/api/entities` instantly while the context tree renders in the background.
 * Idempotent per workspace: no-op when this workspace doesn't auto-render or a
 * render is already running. Cancellation is handled by {@link disposeActive},
 * which aborts the render before closing the DB on switch/close.
 */
function startBackgroundRender(active: ActiveDb): void {
  if (!active.autoRender) return;
  // Begin watching the rendered tree for on-disk edits (idempotent; this is the
  // single "begin serving this workspace" chokepoint). Echo suppression keys off
  // the manifest, so the initial render's own writes are never re-ingested.
  active.fileWatcher?.start();
  // Eager per-viewer freshness: a REMOTE change (another client's write, or the
  // owner re-sharing / un-sharing a row) re-renders this member's RLS-scoped tree
  // so it reflects the new visibility promptly. Wired once per ActiveDb; the
  // broker is stopped in disposeActive.
  //
  // Deliberately NOT gated on "is this change visible to me now": an UN-SHARE
  // makes the row invisible, so a visibility filter would skip the re-render and
  // leave the now-stale row on disk — the exact staleness this is meant to fix.
  // Re-rendering on every remote change handles share AND un-share; the render
  // itself reads current RLS state, so it adds/removes rows correctly either way.
  //
  // THROTTLED to bound shared-quota egress: a render re-reads the member's visible
  // tables, and single-flight alone would render back-to-back under a sustained
  // stream of remote changes. A leading+trailing throttle caps it at one re-render
  // per EAGER_RERENDER_MIN_INTERVAL_MS (freshness stays sub-2s); requestRender
  // still debounces + coalesces beneath this.
  if (!active.eagerRenderWired && active.realtime) {
    active.eagerRenderWired = true;
    let lastFire = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    // Accumulate the CHANGED tables between throttle windows so the re-render is
    // incremental — only the entity contexts a remote change actually touched
    // (the changed table + its cross-table dependents) re-render, not the whole
    // tree. A change with no table name falls back to a full render.
    const pendingTables = new Set<string>();
    let pendingFull = false;
    const fire = (): void => {
      lastFire = Date.now();
      if (pendingFull || pendingTables.size === 0) {
        pendingFull = false;
        pendingTables.clear();
        active.db.requestRender(); // full
        return;
      }
      for (const t of pendingTables) active.db.requestRender(t);
      pendingTables.clear();
    };
    active.realtime.subscribePayload((payload) => {
      if (payload.table_name) pendingTables.add(payload.table_name);
      else pendingFull = true;
      const since = Date.now() - lastFire;
      if (since >= EAGER_RERENDER_MIN_INTERVAL_MS) {
        fire();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = undefined;
          fire();
        }, EAGER_RERENDER_MIN_INTERVAL_MS - since);
        trailing.unref();
      }
    });
  }
  if (active.renderState.phase === 'running') return;
  active.renderState.phase = 'running';
  const db = active.db;
  const signal = active.renderAbort.signal;
  const state = active.renderState;
  const bus = active.renderProgress;
  const startedAt = Date.now();

  const onProgress = (e: RenderProgress): void => {
    // An abort that lands mid-render: stop folding/publishing — the partial
    // tree is discarded and the next workspace owns the stream.
    if (signal.aborted) return;
    if (e.table) {
      state.tables[e.table] = {
        pct: e.pct,
        entitiesRendered: e.entitiesRendered,
        entitiesTotal: e.entitiesTotal,
        done: e.kind === 'table-done',
      };
      state.currentTable = e.table;
      state.tableIndex = e.tableIndex;
      state.tableCount = e.tableCount;
    }
    if (e.kind === 'done') {
      state.phase = 'done';
      state.durationMs = e.durationMs ?? Date.now() - startedAt;
    } else if (e.kind === 'error') {
      state.phase = 'error';
      state.error = e.message ?? 'render failed';
      // A render failure is surfaced loudly, never swallowed.
      console.error('[render] background render error:', e.message ?? '(no message)');
    }
    bus.publish(e);
  };

  // Fire-and-forget. The promise settling is handled below; the caller does NOT
  // await this, so the originating HTTP handler returns sub-second.
  void db.renderInBackground(active.outputDir, { signal, onProgress }).then(
    () => {
      // Normal completion is reported by the engine's `done` event handled in
      // onProgress; nothing more to do here.
    },
    (err: unknown) => {
      // An abort is expected control flow on switch/close — not an error.
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      state.phase = 'error';
      state.error = message;
      // Never swallow a background render rejection.
      console.error('[render] background render rejected:', message);
      bus.publish({
        kind: 'error',
        table: state.currentTable ?? null,
        entitiesRendered: 0,
        entitiesTotal: 0,
        tableIndex: state.tableIndex ?? 0,
        tableCount: state.tableCount ?? 0,
        pct: 0,
        message,
      });
    },
  );
}

/**
 * Attach a per-row `_access` summary (visibility + ownedByMe [+ grantees]) onto
 * each row so the GUI's sharing affordance renders. The frontend hides the share
 * UI when `_access` is absent, so this is what makes cloud sharing visible again
 * (the 3.0 RLS rewrite dropped the old enrichment without a replacement). No-op
 * off a secured cloud. Each row's key is its canonical pk string (single = bare
 * value, composite = TAB-joined), matching `__lattice_owners.pk`.
 */
/**
 * #4.3 — should a realtime change envelope be forwarded to the role THIS server
 * is connected as? The NOTIFY fan-out is global (every change on the whole cloud),
 * so without this gate a member's realtime/feed stream would leak the pk +
 * existence + editor (`owner_role`) of rows the member cannot read. For an
 * `upsert` we probe the row's visibility through the SAME SECURITY-DEFINER
 * function RLS uses (keyed on `session_user` = this connection's role), so the
 * filter is inherently per-recipient. A `delete` can't be probed (the ownership
 * record is removed by the delete trigger) — those are still forwarded so a client
 * drops a row it may be showing, but the caller STRIPS `owner_role` from the
 * forwarded delete so the editor of an unreadable row is never disclosed. No-op
 * (always visible) on a non-cloud single-user SQLite DB. Fails CLOSED (don't
 * forward) on a probe error, logging it.
 */
export async function changeVisibleToActiveRole(
  db: Lattice,
  payload: RealtimePayload,
): Promise<boolean> {
  if (db.getDialect() !== 'postgres') return true; // single-user local — nothing to gate
  if (payload.op === 'delete' || payload.op === 'DELETE') return true; // can't probe; owner_role stripped by caller
  if (!payload.table_name || !payload.pk) return false;
  try {
    const row = (await getAsyncOrSync(db.adapter, `SELECT lattice_row_visible(?, ?) AS v`, [
      payload.table_name,
      payload.pk,
    ])) as { v?: unknown } | undefined;
    return row?.v === true || row?.v === 't' || row?.v === 1;
  } catch (e) {
    console.warn('[realtime] visibility probe failed (dropping change):', (e as Error).message);
    return false;
  }
}

/** True for a delete op (which can't be visibility-probed post-hoc). */
function isDeleteOp(op: string): boolean {
  return op === 'delete' || op === 'DELETE';
}

/**
 * Internal plumbing tables (the assistant's own chat storage + every `_lattice*`
 * bookkeeping table) are NOT user activity — they must never surface as feed
 * pills. files/secrets/notes etc. stay visible. Shared by the multiplexed event
 * stream's two feed sources (the local feed bus + the cloud broker merge).
 */
function isFeedHiddenTable(t: string): boolean {
  return t.startsWith('_lattice') || t.startsWith('__lattice') || isInternalNativeEntity(t);
}

/**
 * #2.1 — the relation a SELECT for `table` should target: the audience-masking
 * view (`<table>_v`) when this (member) connection lost base SELECT, else the base
 * table itself. Passing `<table>_v` to `db.query`/`db.get`-style SELECTs is safe —
 * the view is unregistered (column validation passes through) so it never appears
 * as a sidebar entity, and the view re-applies row visibility + cell masking. Only
 * reads route here; writes always target the base table under RLS.
 */
function readRelationFor(active: ActiveDb, table: string): string {
  return active.maskedReadViews.get(table) ?? table;
}

async function attachRowAccess(db: Lattice, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const pkCols = db.getPrimaryKey(table);
  if (pkCols.length === 0) return;
  const pkOf = (r: Row): string => pkCols.map((c) => String(r[c])).join('\t');
  const summaries = await rowAccessSummaries(db, table, rows.map(pkOf));
  if (summaries.size === 0) return;
  for (const r of rows) {
    const a = summaries.get(pkOf(r));
    if (a) (r as Row & { _access?: unknown })._access = a;
  }
}

/**
 * Resolve when `p` settles or after `ms`, whichever comes first — never rejects.
 * A timeout resolves to the `'timeout'` sentinel so the caller can proceed rather
 * than block. The timer is unref'd so it never keeps the process alive.
 */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([
    p.finally(() => {
      clearTimeout(timer);
    }),
    timeout,
  ]);
}

/**
 * How long {@link disposeActive} waits for a previous workspace's realtime broker
 * to stop before abandoning it. The broker is a Postgres LISTEN/NOTIFY client; on
 * a degraded connection its `stop()` can hang, and a workspace switch must never
 * block on tearing down the workspace it is leaving.
 */
const DISPOSE_TEARDOWN_TIMEOUT_MS = 3000;

/**
 * Tear down an ActiveDb: abort its in-flight render, stop its realtime broker,
 * then close the DB. Called before reopening or swapping configs so listeners +
 * pg clients don't leak.
 *
 * The realtime-broker stop is **time-bounded** ({@link DISPOSE_TEARDOWN_TIMEOUT_MS}):
 * a wedged LISTEN/NOTIFY client (e.g. a stalled cloud connection) must not be able
 * to freeze a workspace switch, which `await`s this before responding. On timeout
 * the broker is abandoned best-effort (the process owns the socket) and teardown
 * continues so the switch completes. `teardownTimeoutMs` is injectable for tests.
 */
export async function disposeActive(
  active: ActiveDb,
  teardownTimeoutMs: number = DISPOSE_TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  // Stop the file loopback watcher FIRST so no on-disk edit can fire a write
  // against a DB that's about to close.
  try {
    active.fileWatcher?.stop();
  } catch {
    // best-effort
  }
  // Abort the in-flight background render — before closing the DB — so the
  // render loop bails before its next query hits a closing adapter.
  try {
    active.renderAbort.abort();
  } catch {
    // best-effort
  }
  if (active.realtime) {
    // Bound the stop: a slow/stuck broker must not wedge a workspace switch.
    const stopped = Promise.resolve()
      .then(() => active.realtime?.stop())
      .catch(() => undefined); // swallow stop() errors — teardown is best-effort
    const outcome = await settleWithin(stopped, teardownTimeoutMs);
    if (outcome === 'timeout') {
      console.warn(
        `[gui] realtime broker stop() exceeded ${String(teardownTimeoutMs)}ms during teardown; ` +
          'abandoning it so the workspace switch stays responsive.',
      );
    }
  }
  try {
    active.db.close();
  } catch {
    // best-effort
  }
}

/**
 * Cap on opening a workspace during a switch before the GUI gives up and keeps
 * the current one. Generous enough for a legitimately slow cloud (Postgres) open
 * — peek connection + init + owner bootstrap converge + LISTEN broker — yet short
 * enough that a stalled connection can't freeze the switcher indefinitely.
 */
const SWITCH_OPEN_TIMEOUT_MS = 20_000;

/**
 * Open a workspace, but never block longer than `timeoutMs`. Returns the opened
 * {@link ActiveDb} on success, or `{ timedOut: true }` so the caller keeps the
 * current workspace and surfaces an error instead of hanging the GUI on a slow or
 * stalled (e.g. cloud) open. A slow open that resolves AFTER the timeout is
 * disposed in the background so it can't leak a DB handle / pg connection. A
 * genuine open error is re-thrown (distinct from a timeout).
 */
export async function openWithinTimeout(
  open: () => Promise<ActiveDb>,
  timeoutMs: number = SWITCH_OPEN_TIMEOUT_MS,
  dispose: (db: ActiveDb) => Promise<void> = disposeActive,
): Promise<{ db: ActiveDb } | { timedOut: true }> {
  const opening = open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const outcome = await Promise.race([
    opening.then(
      (db) => ({ db }) as const,
      (err: unknown) => ({ err }) as const,
    ),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    // Abandon the switch but never leak the half-open workspace: dispose it
    // whenever the slow open eventually settles.
    void opening.then(
      (db) => dispose(db).catch(() => undefined),
      () => undefined,
    );
    return { timedOut: true };
  }
  if ('err' in outcome) throw outcome.err;
  return { db: outcome.db };
}

/**
 * Re-open the *same* workspace after a schema edit (create entity, add column,
 * rename, share…) so the new table definitions take effect — while preserving
 * the in-process {@link FeedBus}.
 *
 * The `/api/stream` WebSocket subscribes to `active.feed` at connect time. A
 * brand-new bus from {@link openConfig} would orphan those subscriptions,
 * silently killing the activity feed AND the live sidebar refresh after the
 * first data-model edit of a session (the Context Constructor's no-reopen
 * `defineLate` path is unaffected, but the manual schema endpoints reopen).
 * `disposeActive` leaves the bus untouched, so carrying the instance across the
 * reopen retains every subscriber and its replay buffer. This is a same-config
 * reopen only — a workspace *switch* intentionally gets a fresh bus (clients
 * reconnect), so those call sites keep calling `openConfig` directly.
 */
async function reopenSameConfig(active: ActiveDb, autoRender: boolean): Promise<ActiveDb> {
  const feed = active.feed;
  await disposeActive(active);
  const next = await openConfig(active.configPath, active.outputDir, autoRender);
  next.feed = feed;
  // Re-render in the background; the caller awaits this reopen (fast) but the
  // render runs detached, so the handler responds without blocking on it.
  startBackgroundRender(next);
  return next;
}

/**
 * Upsert the single `__lattice_user_identity` row from
 * `~/.lattice/identity.json`. Called from `openConfig` after `init()` —
 * idempotent (always rewrites the same row). When identity.json is
 * empty, the row still gets written with empty strings; consumers
 * (Project Config "Team status" panel) treat empty email as "not set."
 */
async function syncUserIdentityRow(db: Lattice): Promise<void> {
  const identity = readIdentity();
  try {
    const existing = (await db.get('__lattice_user_identity', 'singleton')) as {
      id: string;
      display_name: string;
      email: string;
    } | null;
    if (existing) {
      await db.update('__lattice_user_identity', 'singleton', {
        display_name: identity.display_name,
        email: identity.email,
        updated_at: new Date().toISOString(),
      });
    } else {
      await db.insert('__lattice_user_identity', {
        id: 'singleton',
        display_name: identity.display_name,
        email: identity.email,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    // Best-effort: a cloud MEMBER has no write grant on the shared singleton
    // identity row (and shouldn't clobber it anyway) — so a member open must not
    // fail here. Log it (internal guideline: visible, not silently swallowed) and continue;
    // the mirror is a convenience, not required to open the workspace.
    console.warn('[openConfig] skipped user-identity mirror:', (e as Error).message);
  }
}

// ── Schema history (tracking + soft-delete revert) ────────────────────────
// Schema/data-model changes are logged to the same `_lattice_gui_audit`
// history as row edits and are reversible. Deletes are SOFT: the entity/field
// is removed from the config (hiding it) but the SQL object + data are never
// dropped, so a revert just re-adds the config entry and the data is intact.
// No physical DROP ever runs from these paths — only the API-only purge does.

type EntityPayload = { entity: string; entityDef: unknown };
type FieldPayload = { entity: string; column: string; fieldDef: unknown };
type RenameEntityPayload = { entity: string };
type RenameColumnPayload = { entity: string; column: string };

/**
 * Apply the inverse (revert/undo) or forward (redo) of a schema audit entry:
 * a config edit (+ RENAME DDL for renames) followed by a re-open. NEVER a
 * physical DROP — deletes are soft, so re-opening reconciles idempotently with
 * the data intact. Returns the re-opened `ActiveDb`. Throws (caught by the
 * route → 400) on a name collision or when the object was permanently purged,
 * so a revert never silently clobbers or restores an empty shell.
 */
async function applySchemaConfig(
  active: ActiveDb,
  entry: AuditEntry,
  direction: 'inverse' | 'forward',
  autoRender: boolean,
): Promise<ActiveDb> {
  const before = entry.before_json
    ? (JSON.parse(entry.before_json) as Record<string, unknown>)
    : null;
  const after = entry.after_json ? (JSON.parse(entry.after_json) as Record<string, unknown>) : null;
  const doc = loadConfigDoc(active.configPath);
  const inv = direction === 'inverse';
  const ddl: string[] = [];
  const has = (path: string[]): boolean => doc.getIn(path) !== undefined;

  const reAddEntity = async (name: string, def: unknown): Promise<void> => {
    if (has(['entities', name])) {
      throw new Error(`Cannot restore "${name}": an entity with that name already exists`);
    }
    if (!(await physicalTableExists(active, name))) {
      throw new Error(`Cannot restore "${name}": it was permanently purged`);
    }
    doc.setIn(['entities', name], def);
  };
  const removeEntity = (name: string): void => {
    doc.deleteIn(['entities', name]);
  };
  const reAddField = async (entity: string, col: string, def: unknown): Promise<void> => {
    if (has(['entities', entity, 'fields', col])) {
      throw new Error(`Cannot restore column "${col}": it already exists on "${entity}"`);
    }
    if (!(await physicalColumnExists(active, entity, col))) {
      throw new Error(`Cannot restore column "${col}": it was permanently purged`);
    }
    doc.setIn(['entities', entity, 'fields', col], def);
  };
  const removeField = (entity: string, col: string): void => {
    doc.deleteIn(['entities', entity, 'fields', col]);
  };
  const renameEntity = (from: string, to: string): void => {
    const def: unknown = doc.getIn(['entities', from]);
    if (def === undefined) throw new Error(`Cannot rename "${from}": not found`);
    if (has(['entities', to])) throw new Error(`Cannot rename to "${to}": already exists`);
    doc.deleteIn(['entities', from]);
    doc.setIn(['entities', to], def);
    ddl.push(`ALTER TABLE "${from}" RENAME TO "${to}"`);
  };
  const renameColumn = (entity: string, from: string, to: string): void => {
    const def: unknown = doc.getIn(['entities', entity, 'fields', from]);
    if (def === undefined) throw new Error(`Cannot rename column "${from}": not found`);
    if (has(['entities', entity, 'fields', to]))
      throw new Error(`Cannot rename to "${to}": already exists`);
    doc.deleteIn(['entities', entity, 'fields', from]);
    doc.setIn(['entities', entity, 'fields', to], def);
    ddl.push(`ALTER TABLE "${entity}" RENAME COLUMN "${from}" TO "${to}"`);
  };

  switch (entry.operation) {
    case 'schema.create_entity':
    case 'schema.create_junction': {
      const p = after as unknown as EntityPayload;
      if (inv) removeEntity(p.entity);
      else await reAddEntity(p.entity, p.entityDef);
      break;
    }
    case 'schema.delete_entity': {
      const p = before as unknown as EntityPayload;
      if (inv) await reAddEntity(p.entity, p.entityDef);
      else removeEntity(p.entity);
      break;
    }
    case 'schema.add_column':
    case 'schema.add_link': {
      const p = after as unknown as FieldPayload;
      if (inv) removeField(p.entity, p.column);
      else await reAddField(p.entity, p.column, p.fieldDef);
      break;
    }
    case 'schema.delete_link': {
      const p = before as unknown as FieldPayload;
      if (inv) await reAddField(p.entity, p.column, p.fieldDef);
      else removeField(p.entity, p.column);
      break;
    }
    case 'schema.rename_entity': {
      const oldN = (before as unknown as RenameEntityPayload).entity;
      const newN = (after as unknown as RenameEntityPayload).entity;
      if (inv) renameEntity(newN, oldN);
      else renameEntity(oldN, newN);
      break;
    }
    case 'schema.rename_column': {
      const oldC = (before as unknown as RenameColumnPayload).column;
      const a = after as unknown as RenameColumnPayload;
      if (inv) renameColumn(a.entity, a.column, oldC);
      else renameColumn(a.entity, oldC, a.column);
      break;
    }
    default:
      throw new Error(`Cannot revert unknown schema op: ${entry.operation}`);
  }

  // Run RENAME DDL on the live connection before re-opening, so the physical
  // schema matches the edited config. (Config edits are persisted only after
  // this succeeds; a throw above leaves the on-disk config + `active` intact.)
  for (const sql of ddl) await execSql(active.db, sql);
  saveConfigDoc(active.configPath, doc);
  await disposeActive(active);
  const next = await openConfig(active.configPath, active.outputDir, autoRender);
  // Re-render in the background; the caller awaits this reopen (fast) but the
  // render runs detached, so the handler responds without blocking on it.
  startBackgroundRender(next);
  return next;
}

/** Human one-liner for an undo/redo/revert of a schema entry (activity feed). */
function schemaReverseSummary(verb: string, entry: AuditEntry): string {
  const what = entry.operation.replace('schema.', '').replace(/_/g, ' ');
  return `${verb} schema change (${what}) on ${entry.table_name}`;
}

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

        // ── HTML + read-only data routes ──────────────────────────────────
        if (method === 'GET' && pathname === '/') {
          sendText(
            res,
            guiAppHtml.replace('<!--LATTICE_VERSION-->', guiVersion ? `v${guiVersion}` : ''),
            200,
            'text/html; charset=utf-8',
          );
          return;
        }

        // ── Realtime: connection status (single-shot JSON) ─────────────────
        // Live realtime change/state events flow over the multiplexed
        // `/api/stream` WebSocket; this endpoint is just the snapshot probe.
        if (method === 'GET' && pathname === '/api/realtime/status') {
          const mode: 'local' | 'cloud' = active.realtime ? 'cloud' : 'local';
          const connected = active.realtime?.state() === 'connected';
          sendJson(res, { mode, state: active.realtime?.state() ?? 'local', connected });
          return;
        }
        // Realtime change events, the activity feed, and background-render
        // progress are no longer three separate Server-Sent-Event streams. They
        // are multiplexed onto ONE WebSocket (`/api/stream`, handled via the HTTP
        // `upgrade` path below) so a browser tab holds a single persistent
        // connection instead of three. Three SSE streams per tab consumed the
        // whole HTTP/1.1 6-connections-per-host budget after just two tabs, which
        // starved every data request (entities/rows/switch) and froze the UI; a
        // WebSocket lives in a separate, far larger connection pool, so data
        // requests always keep the full HTTP budget free. See `handleEventStream`.

        // ── Background render: single-shot status snapshot ──────────────────
        // `/api/render/status` returns the live render state (phase + per-table %)
        // as plain JSON; the streaming per-table progress now flows over the
        // multiplexed WebSocket. Reads `active` at request time.
        if (method === 'GET' && pathname === '/api/render/status') {
          sendJson(res, active.renderState);
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
        if (method === 'GET' && pathname === '/api/dashboard') {
          sendJson(res, await dashboardPayload(active.db, active.configPath, active.outputDir));
          return;
        }
        // ── Full-text search across tables ────────────────────────────────
        // GET /api/search?q=&tables=&limit= — LIKE fallback + indexed (FTS5 /
        // tsvector) per the engine in src/search/fts.ts. Scoped to validTables;
        // row visibility is enforced by Postgres RLS at the database.
        if (method === 'GET' && pathname === '/api/search') {
          const q = (url.searchParams.get('q') ?? '').trim();
          if (!q) {
            sendJson(res, { query: '', groups: [] });
            return;
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
          return;
        }
        // ── Team members (for "last edited by" name resolution) ───────────
        // GET /api/team/users → { users: [{id,email,name}] }. Empty — member
        // directory is rebuilt on RLS later.
        if (method === 'GET' && pathname === '/api/team/users') {
          sendJson(res, { users: [] });
          return;
        }
        if (method === 'GET' && pathname === '/api/graph') {
          const yamlNames = new Set(
            getGuiEntities(active.configPath, active.outputDir).tables.map((t) => t.name),
          );
          const graphOpts: import('./data.js').BuildGuiGraphOptions = {
            extraTables: registeredExtraTables(active.db, yamlNames),
          };
          sendJson(res, buildGuiGraph(active.configPath, active.outputDir, graphOpts));
          return;
        }

        // ── Create entity (additive — not in audit log, irreversible from GUI) ──
        if (method === 'POST' && pathname === '/api/schema/entities') {
          const body = (await readJson<unknown>(req)) as { name?: unknown; icon?: unknown };
          const entityName = typeof body.name === 'string' ? body.name.trim() : '';
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(entityName)) {
            sendJson(res, { error: 'Entity name must be a valid identifier' }, 400);
            return;
          }
          if (active.validTables.has(entityName)) {
            sendJson(res, { error: `Entity already exists: ${entityName}` }, 400);
            return;
          }
          // A soft-deleted table of this name still exists physically (hidden).
          // Refuse rather than CREATE-collide or silently resurrect its data.
          if (await physicalTableExists(active, entityName)) {
            sendJson(
              res,
              {
                error: `A deleted entity "${entityName}" exists — revert it instead, or purge it first.`,
              },
              400,
            );
            return;
          }
          // Delegate to the same no-reopen primitive the chat/ingest paths use
          // (one source of truth for table DDL + canonical-context + audit).
          // `normalize:false` preserves the user's typed name. Object ownership
          // is recorded by a Postgres RLS trigger at the database.
          const created = await createUserEntity(active, entityName, [], sessionId, {
            normalize: false,
          });
          if (!created) {
            sendJson(res, { error: `Could not create entity "${entityName}"` }, 400);
            return;
          }
          if (typeof body.icon === 'string' && body.icon.trim()) {
            await active.db.insert('_lattice_gui_meta', {
              entity_name: created,
              icon: body.icon.trim(),
              updated_at: new Date().toISOString(),
            });
          }
          sendJson(res, { ok: true, name: created });
          return;
        }

        // ── Create a many-to-many relationship (junction table) ──────────
        // Creates a junction table with two ref columns linking `left` and
        // `right`, so it surfaces as an m2m edge in the Data Model graph.
        if (method === 'POST' && pathname === '/api/schema/junctions') {
          const body = (await readJson<unknown>(req)) as {
            left?: unknown;
            right?: unknown;
            name?: unknown;
          };
          const left = typeof body.left === 'string' ? body.left.trim() : '';
          const right = typeof body.right === 'string' ? body.right.trim() : '';
          if (!active.validTables.has(left) || !active.validTables.has(right)) {
            sendJson(res, { error: 'Both entities must exist' }, 400);
            return;
          }
          if (active.junctionTables.has(left) || active.junctionTables.has(right)) {
            sendJson(res, { error: 'Cannot link a junction table' }, 400);
            return;
          }
          // One many-to-many link per pair (either direction): refuse if a
          // junction already connects `left` and `right`. Mirrors the picker's
          // client-side exclusion so the model can't accumulate A_B + B_A.
          const linksBoth = (j: GuiTableSummary): boolean => {
            const bt = Object.values(j.relations).filter((r) => r.type === 'belongsTo');
            const tables = new Set(bt.map((r) => r.table));
            return bt.length === 2 && tables.has(left) && tables.has(right);
          };
          const existingJunction = getGuiEntities(active.configPath, active.outputDir).tables.find(
            (j) => active.junctionTables.has(j.name) && linksBoth(j),
          );
          if (existingJunction) {
            sendJson(
              res,
              { error: `"${left}" and "${right}" are already linked (${existingJunction.name})` },
              400,
            );
            return;
          }
          const requested = typeof body.name === 'string' ? body.name.trim() : '';
          const jName = requested || `${left}_${right}`;
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(jName)) {
            sendJson(res, { error: 'Relationship name must be a valid identifier' }, 400);
            return;
          }
          if (
            active.validTables.has(jName) ||
            active.db.getRegisteredTableNames().includes(jName)
          ) {
            sendJson(res, { error: `A table named "${jName}" already exists` }, 400);
            return;
          }
          if (await physicalTableExists(active, jName)) {
            sendJson(
              res,
              {
                error: `A deleted relationship "${jName}" exists — revert it instead, or purge it first.`,
              },
              400,
            );
            return;
          }
          // Self-referential m2m needs two distinct column names.
          const leftCol = `${left}_id`;
          const rightCol = left === right ? `${right}_id_2` : `${right}_id`;
          // Same no-reopen materialization the chat path uses. Object ownership
          // is recorded by a Postgres RLS trigger at the database.
          await materializeJunction(
            active,
            jName,
            leftCol,
            left,
            rightCol,
            right,
            `Linked ${left} ↔ ${right}`,
            sessionId,
          );
          sendJson(res, { ok: true, name: jName });
          return;
        }

        // ── Delete a whole table (the single, explicit table-drop path) ───
        // This is the ONLY DROP TABLE in the GUI. It is deliberately guarded:
        // owner-gated, never drops a native entity, and REFUSES while any other
        // table still has a foreign key pointing at it (so a delete can never
        // leave dangling references / a broken data model — the user removes
        // those links first). The client gates this behind a type-the-name
        // confirmation. The old, dangerous DELETE /api/schema/junctions/:name
        // route (which dropped a "junction" inferred only from FK count, and so
        // could drop a misclassified first-class entity) has been removed.
        if (method === 'DELETE' && /^\/api\/schema\/entities\/[^/]+$/.test(pathname)) {
          const name = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(name)) {
            sendJson(res, { error: `Unknown entity: ${name}` }, 400);
            return;
          }
          if (isNativeEntity(name)) {
            sendJson(res, { error: `"${name}" is a built-in entity and cannot be deleted` }, 400);
            return;
          }
          // Inbound-FK guard: refuse if another table links to this one.
          const inbound: string[] = [];
          for (const t of getGuiEntities(active.configPath, active.outputDir).tables) {
            if (t.name === name) continue;
            for (const rel of Object.values(t.relations)) {
              if (rel.type === 'belongsTo' && rel.table === name) {
                inbound.push(`${t.name}.${rel.foreignKey}`);
              }
            }
          }
          if (inbound.length > 0) {
            sendJson(
              res,
              {
                error: `Cannot delete "${name}" — these links point at it: ${inbound.join(', ')}. Delete those links first.`,
              },
              400,
            );
            return;
          }
          // SOFT delete: remove the entity from the config + live registry
          // (hiding it from the GUI) but DO NOT drop the SQL table — its rows
          // stay intact so the recorded `schema.delete_entity` op can be reverted
          // with no snapshot. No reopen (shared with the assistant's delete tool).
          // Physical removal is a separate, API-only `POST /api/schema/purge`.
          await softDeleteUserEntity(active, name, sessionId);
          sendJson(res, { ok: true });
          return;
        }

        // ── GUI column metadata (per-column secret flag) ─────────────────
        if (method === 'GET' && pathname === '/api/gui-meta/columns') {
          const rows = (await active.db.query('_lattice_gui_column_meta', {})) as {
            table_name: string;
            column_name: string;
            secret: number;
            description?: string | null;
          }[];
          // Index the authored (operator/AI/auto-generated) meta by table→column.
          const authored = new Map<
            string,
            Map<string, { secret: number; description: string | null }>
          >();
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
          const out: Record<
            string,
            Record<string, { secret?: boolean; description?: string }>
          > = {};
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
          return;
        }
        if (method === 'PUT' && /^\/api\/gui-meta\/columns\/[^/]+\/[^/]+$/.test(pathname)) {
          const parts = pathname.split('/');
          const tableName = decodeURIComponent(parts[4] ?? '');
          const colName = decodeURIComponent(parts[5] ?? '');
          if (!active.validTables.has(tableName)) {
            sendJson(res, { error: `Unknown table: ${tableName}` }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as {
            secret?: unknown;
            description?: unknown;
          };
          const settingSecret = 'secret' in body;
          const settingDescription = 'description' in body;
          // Secret is meaningful only for scalar data columns. System columns
          // (id/created_at/updated_at/deleted_at) and links (FK columns) can't
          // be marked secret — enforce here so the data model stays clean. The
          // guard applies only when `secret` is being set; a description-only
          // write is fine on any column.
          if (settingSecret) {
            if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
              sendJson(
                res,
                { error: `"${colName}" is a system column and cannot be marked secret` },
                400,
              );
              return;
            }
            if (columnRefTarget(active.configPath, tableName, colName)) {
              sendJson(res, { error: 'Link (foreign-key) columns cannot be marked secret' }, 400);
              return;
            }
          }
          const secret: 0 | 1 = body.secret === true ? 1 : 0;
          // Consolidated find-or-insert (shared with the set_definition AI tool
          // and the auto-generators) — applies only the provided fields.
          await upsertColumnMeta(active.db, tableName, colName, {
            ...(settingSecret ? { secret } : {}),
            ...(settingDescription
              ? { description: typeof body.description === 'string' ? body.description : null }
              : {}),
          });
          // The `_lattice_gui_column_meta.secret` write above is the local
          // model-context redaction (the assistant never sees a secret value).
          // On a cloud (Postgres) DB, ALSO enforce it in the database: mask the
          // column to non-owners via the audience view, so a member's connection
          // can't read it at all. SQLite is a no-op inside setColumnAudience.
          if (settingSecret && active.db.getDialect() === 'postgres') {
            const columnNames = Object.keys(active.db.getRegisteredColumns(tableName) ?? {});
            const pkCols = active.db.getPrimaryKey(tableName);
            await setColumnAudience(
              active.db,
              tableName,
              colName,
              secret ? 'owner' : '',
              columnNames,
              pkCols,
            );
          }
          sendJson(res, { ok: true });
          return;
        }

        // ── Cloud table policy: per-table default row visibility + never-share ──
        // Owner-only (Postgres cloud); the underlying SQL functions also raise for
        // a non-owner, so the gate here is defense-in-depth + a clean error.
        if (
          method === 'POST' &&
          /^\/api\/schema\/entities\/[^/]+\/default-row-visibility$/.test(pathname)
        ) {
          const table = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }
          if (active.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(active.db))) {
            sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
            return;
          }
          if (!(await canManageRoles(active.db))) {
            sendJson(res, { error: 'Only a cloud owner can change default row visibility' }, 403);
            return;
          }
          const body = (await readJson<unknown>(req)) as { visibility?: unknown };
          const visibility = body.visibility === 'everyone' ? 'everyone' : 'private';
          if (body.visibility !== 'everyone' && body.visibility !== 'private') {
            sendJson(res, { error: "visibility must be 'private' or 'everyone'" }, 400);
            return;
          }
          await setTableDefaultVisibility(active.db, table, visibility);
          sendJson(res, { ok: true, table, visibility });
          return;
        }
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/never-share$/.test(pathname)) {
          const table = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }
          if (active.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(active.db))) {
            sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
            return;
          }
          if (!(await canManageRoles(active.db))) {
            sendJson(res, { error: 'Only a cloud owner can change never-share' }, 403);
            return;
          }
          const body = (await readJson<unknown>(req)) as { on?: unknown };
          if (typeof body.on !== 'boolean') {
            sendJson(res, { error: 'on must be a boolean' }, 400);
            return;
          }
          await setTableNeverShare(active.db, table, body.on);
          sendJson(res, { ok: true, table, on: body.on });
          return;
        }

        // ── Schema editing (rename entity / add column / rename column) ──
        // All three mutate the YAML + apply a SQL ALTER, then re-open the
        // Lattice instance so the in-memory schema matches the new config.
        // We don't audit-log schema changes (they're structural, not data).
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/rename$/.test(pathname)) {
          const oldName = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(oldName)) {
            sendJson(res, { error: `Unknown entity: ${oldName}` }, 400);
            return;
          }
          if (isNativeEntity(oldName)) {
            sendJson(
              res,
              { error: `"${oldName}" is a built-in entity and cannot be modified` },
              400,
            );
            return;
          }
          const body = (await readJson<unknown>(req)) as { to?: unknown };
          const newName = typeof body.to === 'string' ? body.to.trim() : '';
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(newName)) {
            sendJson(res, { error: 'New name must be a valid identifier' }, 400);
            return;
          }
          if (active.validTables.has(newName)) {
            sendJson(res, { error: `Entity already exists: ${newName}` }, 400);
            return;
          }
          await execSql(active.db, `ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
          const doc = loadConfigDoc(active.configPath);
          const entity: unknown = doc.getIn(['entities', oldName]);
          doc.deleteIn(['entities', oldName]);
          doc.setIn(['entities', newName], entity);
          // Also rename in entityContexts if present.
          if (doc.getIn(['entityContexts', oldName])) {
            const ctx: unknown = doc.getIn(['entityContexts', oldName]);
            doc.deleteIn(['entityContexts', oldName]);
            doc.setIn(['entityContexts', newName], ctx);
          }
          saveConfigDoc(active.configPath, doc);
          active = activeRef = await reopenSameConfig(active, autoRender);
          await recordSchemaOp(
            active,
            'schema.rename_entity',
            newName,
            { entity: oldName },
            { entity: newName },
            `Renamed table ${oldName} → ${newName}`,
            sessionId,
          );
          sendJson(res, { ok: true });
          return;
        }
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/columns$/.test(pathname)) {
          const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
            return;
          }
          if (isNativeEntity(entityName)) {
            sendJson(
              res,
              { error: `"${entityName}" is a built-in entity and cannot be modified` },
              400,
            );
            return;
          }
          const body = (await readJson<unknown>(req)) as {
            name?: unknown;
            type?: unknown;
            required?: unknown;
            ref?: unknown;
          };
          const colName = typeof body.name === 'string' ? body.name.trim() : '';
          const colType = typeof body.type === 'string' ? body.type : 'text';
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
            sendJson(res, { error: 'Column name must be a valid identifier' }, 400);
            return;
          }
          if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
            sendJson(res, { error: `"${colName}" is a reserved system column` }, 400);
            return;
          }
          // Scalar data columns only. uuid is reserved for keys; relationships
          // ("links") are created via the dedicated links endpoint, not here.
          if (!ALLOWED_COLUMN_TYPES.has(colType)) {
            sendJson(
              res,
              { error: 'Column type must be one of: text, integer, real, boolean' },
              400,
            );
            return;
          }
          if (typeof body.ref === 'string' && body.ref) {
            sendJson(res, { error: 'Use “Add link” to create a relationship column' }, 400);
            return;
          }
          // Validate the config edit BEFORE touching SQL so a failed config
          // mutation can never leave the physical schema ahead of the YAML
          // (no drift). The fields map must exist (it won't for a
          // table that isn't a declared config entity) and must not already
          // carry this column.
          const doc = loadConfigDoc(active.configPath);
          const fieldsNode: unknown = doc.getIn(['entities', entityName, 'fields']);
          if (
            !fieldsNode ||
            typeof fieldsNode !== 'object' ||
            typeof (fieldsNode as { toJSON?: unknown }).toJSON !== 'function'
          ) {
            sendJson(res, { error: `Cannot add columns to "${entityName}"` }, 400);
            return;
          }
          const existingFields = (fieldsNode as { toJSON: () => Record<string, unknown> }).toJSON();
          if (colName in existingFields) {
            sendJson(res, { error: `Column "${colName}" already exists on ${entityName}` }, 400);
            return;
          }
          const sqliteType = fieldToSqliteBaseType(colType as LatticeFieldDef['type']);
          await execSql(
            active.db,
            `ALTER TABLE "${entityName}" ADD COLUMN "${colName}" ${sqliteType}`,
          );
          const fieldDef: Record<string, unknown> = { type: colType };
          if (body.required === true) fieldDef.required = true;
          doc.setIn(['entities', entityName, 'fields', colName], fieldDef);
          saveConfigDoc(active.configPath, doc);
          active = activeRef = await reopenSameConfig(active, autoRender);
          await recordSchemaOp(
            active,
            'schema.add_column',
            entityName,
            null,
            { entity: entityName, column: colName, fieldDef },
            `Added column ${colName} to ${entityName}`,
            sessionId,
          );
          sendJson(res, { ok: true });
          return;
        }
        if (
          method === 'POST' &&
          /^\/api\/schema\/entities\/[^/]+\/columns\/[^/]+\/rename$/.test(pathname)
        ) {
          const parts = pathname.split('/');
          const entityName = decodeURIComponent(parts[4] ?? '');
          const colName = decodeURIComponent(parts[6] ?? '');
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
            return;
          }
          if (isNativeEntity(entityName)) {
            sendJson(
              res,
              { error: `"${entityName}" is a built-in entity and cannot be modified` },
              400,
            );
            return;
          }
          const body = (await readJson<unknown>(req)) as { to?: unknown };
          const newCol = typeof body.to === 'string' ? body.to.trim() : '';
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newCol)) {
            sendJson(res, { error: 'New column name must be a valid identifier' }, 400);
            return;
          }
          if (SCHEMA_SYSTEM_COLUMNS.has(colName)) {
            sendJson(res, { error: `Cannot rename the system column "${colName}"` }, 400);
            return;
          }
          if (columnRefTarget(active.configPath, entityName, colName)) {
            sendJson(res, { error: 'Foreign-key (link) column names cannot be changed' }, 400);
            return;
          }
          if (SCHEMA_SYSTEM_COLUMNS.has(newCol)) {
            sendJson(res, { error: `"${newCol}" is a reserved system column` }, 400);
            return;
          }
          // Validate the config edit BEFORE touching SQL (a failed
          // YAML mutation must never leave the physical column renamed ahead of
          // the config). Rebuild the fields map by key (object-safe) rather than
          // deleteIn+setIn on the deep path.
          const doc = loadConfigDoc(active.configPath);
          const fieldsNode: unknown = doc.getIn(['entities', entityName, 'fields']);
          if (
            !fieldsNode ||
            typeof fieldsNode !== 'object' ||
            typeof (fieldsNode as { toJSON?: unknown }).toJSON !== 'function'
          ) {
            sendJson(res, { error: `Cannot rename columns on "${entityName}"` }, 400);
            return;
          }
          const fieldsObj = (fieldsNode as { toJSON: () => Record<string, unknown> }).toJSON();
          if (!(colName in fieldsObj)) {
            sendJson(res, { error: `Unknown column "${colName}" on ${entityName}` }, 400);
            return;
          }
          if (newCol in fieldsObj) {
            sendJson(res, { error: `Column "${newCol}" already exists on ${entityName}` }, 400);
            return;
          }
          await execSql(
            active.db,
            `ALTER TABLE "${entityName}" RENAME COLUMN "${colName}" TO "${newCol}"`,
          );
          const renamedFields: Record<string, unknown> = {};
          for (const k of Object.keys(fieldsObj)) {
            renamedFields[k === colName ? newCol : k] = fieldsObj[k];
          }
          doc.setIn(['entities', entityName, 'fields'], renamedFields);
          saveConfigDoc(active.configPath, doc);
          active = activeRef = await reopenSameConfig(active, autoRender);
          await recordSchemaOp(
            active,
            'schema.rename_column',
            entityName,
            { entity: entityName, column: colName },
            { entity: entityName, column: newCol },
            `Renamed column ${colName} → ${newCol} on ${entityName}`,
            sessionId,
          );
          sendJson(res, { ok: true });
          return;
        }

        // ── Add a link (foreign key) from an entity to another ───────────
        // A "link" is a relationship, distinct from a scalar column: it adds a
        // uuid FK column referencing `target`. Links can't be edited once
        // created — only destroyed (below). Owner-gated.
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/links$/.test(pathname)) {
          const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { target?: unknown };
          const target = typeof body.target === 'string' ? body.target.trim() : '';
          if (!active.validTables.has(target)) {
            sendJson(res, { error: 'Target entity must exist' }, 400);
            return;
          }
          if (active.junctionTables.has(target)) {
            sendJson(res, { error: 'Cannot link to a junction table' }, 400);
            return;
          }
          // One link per target via this control: refuse if the entity already
          // has a foreign key pointing at `target` (the UI also excludes it
          // from the picker). Keeps the data model clean and avoids the
          // accidental <target>_id / <target>_id_2 duplication.
          const summary = getGuiEntities(active.configPath, active.outputDir).tables.find(
            (t) => t.name === entityName,
          );
          const alreadyLinked =
            summary !== undefined &&
            Object.values(summary.relations).some(
              (r) => r.type === 'belongsTo' && r.table === target,
            );
          if (alreadyLinked) {
            sendJson(res, { error: `"${entityName}" already links to "${target}"` }, 400);
            return;
          }
          // Name the FK <target>_id, de-duplicating against existing columns.
          const existingCols = new Set(
            Object.keys(active.db.getRegisteredColumns(entityName) ?? {}),
          );
          let colName = `${target}_id`;
          let n = 2;
          while (existingCols.has(colName)) colName = `${target}_id_${String(n++)}`;
          const linkType = fieldToSqliteBaseType('uuid');
          await execSql(
            active.db,
            `ALTER TABLE "${entityName}" ADD COLUMN "${colName}" ${linkType}`,
          );
          const linkFieldDef = { type: 'uuid', ref: target };
          const doc = loadConfigDoc(active.configPath);
          doc.setIn(['entities', entityName, 'fields', colName], linkFieldDef);
          saveConfigDoc(active.configPath, doc);
          active = activeRef = await reopenSameConfig(active, autoRender);
          await recordSchemaOp(
            active,
            'schema.add_link',
            entityName,
            null,
            { entity: entityName, column: colName, fieldDef: linkFieldDef },
            `Added link ${entityName} → ${target}`,
            sessionId,
          );
          sendJson(res, { ok: true, column: colName });
          return;
        }

        // ── Destroy a link (drop the FK column) ──────────────────────────
        // Links are destroy-only and owner-gated. Each link is managed
        // individually — including the legs of a (pure) junction table — and
        // dropping one only drops THAT foreign-key column (ALTER TABLE DROP
        // COLUMN), never a table. To remove a whole table, use
        // DELETE /api/schema/entities/:name.
        if (
          method === 'DELETE' &&
          /^\/api\/schema\/entities\/[^/]+\/links\/[^/]+$/.test(pathname)
        ) {
          const parts = pathname.split('/');
          const entityName = decodeURIComponent(parts[4] ?? '');
          const colName = decodeURIComponent(parts[6] ?? '');
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
            return;
          }
          const target = columnRefTarget(active.configPath, entityName, colName);
          if (!target) {
            sendJson(res, { error: `Not a link column: ${colName}` }, 400);
            return;
          }
          // SOFT delete: remove the FK field from the config (hiding the link)
          // but DO NOT drop the SQL column — its values stay, so revert restores
          // them with no snapshot. Capture the field def first for revert.
          const doc = loadConfigDoc(active.configPath);
          const deletedFieldDef = (
            doc.toJS() as { entities?: Record<string, { fields?: Record<string, unknown> }> }
          ).entities?.[entityName]?.fields?.[colName];
          doc.deleteIn(['entities', entityName, 'fields', colName]);
          saveConfigDoc(active.configPath, doc);
          active = activeRef = await reopenSameConfig(active, autoRender);
          await recordSchemaOp(
            active,
            'schema.delete_link',
            entityName,
            { entity: entityName, column: colName, fieldDef: deletedFieldDef },
            null,
            `Deleted link ${entityName} → ${target}`,
            sessionId,
          );
          sendJson(res, { ok: true });
          return;
        }

        // ── Purge permanently (API only — NOT surfaced in the GUI) ────────
        // Soft-deleted tables/columns stay physically in the DB so they can be
        // reverted. This is the escape hatch to physically DROP an orphaned
        // (soft-deleted) object and reclaim space. Irreversible — after a purge,
        // the prior soft-delete can no longer be reverted (its data is gone).
        if (method === 'POST' && pathname === '/api/schema/purge') {
          const body = (await readJson<unknown>(req)) as {
            type?: unknown;
            name?: unknown;
            column?: unknown;
          };
          const type = body.type === 'column' ? 'column' : 'table';
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          const column = typeof body.column === 'string' ? body.column.trim() : '';
          if (!name) {
            sendJson(res, { error: 'name is required' }, 400);
            return;
          }
          if (type === 'table') {
            // Must be orphaned: physically present but NOT live (soft-deleted).
            if (active.validTables.has(name)) {
              sendJson(
                res,
                { error: `"${name}" is a live table — soft-delete it first, then purge.` },
                400,
              );
              return;
            }
            if (!(await physicalTableExists(active, name))) {
              sendJson(res, { error: `No soft-deleted table "${name}" to purge` }, 400);
              return;
            }
            try {
              await execSql(active.db, `DROP TABLE IF EXISTS "${name}"`);
            } catch (err) {
              sendJson(
                res,
                {
                  error: `Failed to purge "${name}": ${err instanceof Error ? err.message : String(err)}`,
                },
                400,
              );
              return;
            }
            // Best-effort gui-meta cleanup (icon + column secret flags).
            for (const meta of [
              { table: '_lattice_gui_meta', col: 'entity_name' },
              { table: '_lattice_gui_column_meta', col: 'table_name' },
            ]) {
              const rows = (await active.db.query(meta.table, {
                filters: [{ col: meta.col, op: 'eq', val: name }],
              })) as { id: string }[];
              for (const r of rows) await active.db.delete(meta.table, r.id);
            }
            await recordSchemaAudit(
              active.db,
              active.feed,
              name,
              'schema.purge',
              { entity: name, type: 'table' },
              null,
              `Purged table ${name}`,
              'gui',
              sessionId,
            );
            await emitDdlEnvelope(active, name);
            sendJson(res, { ok: true });
            return;
          }
          // type === 'column': the table is live, the column physically present
          // but not in the config (soft-deleted link/column).
          if (!column) {
            sendJson(res, { error: 'column is required for a column purge' }, 400);
            return;
          }
          if (!active.validTables.has(name)) {
            sendJson(res, { error: `Unknown table: ${name}` }, 400);
            return;
          }
          const registered = active.db.getRegisteredColumns(name) ?? {};
          if (column in registered) {
            sendJson(
              res,
              { error: `"${column}" is a live column — soft-delete it first, then purge.` },
              400,
            );
            return;
          }
          if (!(await physicalColumnExists(active, name, column))) {
            sendJson(
              res,
              { error: `No soft-deleted column "${column}" on "${name}" to purge` },
              400,
            );
            return;
          }
          try {
            await execSql(active.db, `ALTER TABLE "${name}" DROP COLUMN "${column}"`);
          } catch (err) {
            sendJson(
              res,
              {
                error: `Failed to purge "${column}": ${err instanceof Error ? err.message : String(err)}`,
              },
              400,
            );
            return;
          }
          await recordSchemaAudit(
            active.db,
            active.feed,
            name,
            'schema.purge',
            { entity: name, column, type: 'column' },
            null,
            `Purged column ${column} from ${name}`,
            'gui',
            sessionId,
          );
          await emitDdlEnvelope(active, name);
          sendJson(res, { ok: true });
          return;
        }

        // ── Version history (audit log + undo/redo + revert) ──────────────
        if (method === 'GET' && pathname === '/api/history') {
          const limit = Number(url.searchParams.get('limit') ?? '200');
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
            filters: [{ col: 'session_id', op: 'eq', val: sessionId }],
          })) as Record<string, unknown>[];
          const sessionLive = sessionRows.filter((r) => Number(r.undone) === 0).length;
          const sessionUndone = sessionRows.length - sessionLive;
          sendJson(res, { entries, canUndo: sessionLive > 0, canRedo: sessionUndone > 0 });
          return;
        }
        if (method === 'POST' && pathname === '/api/history/undo') {
          // Peek the latest LIVE entry to branch row vs schema. Schema reverts
          // need config + re-open (which dispose the db row helpers capture), so
          // they're handled here directly; row ops go through undoLast.
          const live = (
            (await active.db.query('_lattice_gui_audit', {
              filters: [
                { col: 'undone', op: 'eq', val: 0 },
                { col: 'session_id', op: 'eq', val: sessionId },
              ],
            })) as Record<string, unknown>[]
          ).map(parseAudit);
          const target = live.sort((a, b) => b.ts.localeCompare(a.ts))[0];
          if (target && isSchemaOp(target.operation)) {
            try {
              active = activeRef = await applySchemaConfig(active, target, 'inverse', autoRender);
            } catch (err) {
              sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
              return;
            }
            await active.db.update('_lattice_gui_audit', target.id, { undone: 1 });
            active.feed.publish({
              table: target.table_name,
              op: 'undo',
              rowId: null,
              source: 'gui',
              summary: schemaReverseSummary('Undid', target),
            });
            await emitDdlEnvelope(active, target.table_name);
            sendJson(res, { ok: true, entry: target });
            return;
          }
          const entry = await undoLast({
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
            sessionId,
          });
          if (!entry) {
            sendJson(res, { error: 'Nothing to undo' }, 400);
            return;
          }
          sendJson(res, { ok: true, entry });
          return;
        }
        if (method === 'POST' && pathname === '/api/history/redo') {
          const undone = (
            (await active.db.query('_lattice_gui_audit', {
              filters: [
                { col: 'undone', op: 'eq', val: 1 },
                { col: 'session_id', op: 'eq', val: sessionId },
              ],
            })) as Record<string, unknown>[]
          ).map(parseAudit);
          const target = undone.sort((a, b) => a.ts.localeCompare(b.ts))[0];
          if (target && isSchemaOp(target.operation)) {
            try {
              active = activeRef = await applySchemaConfig(active, target, 'forward', autoRender);
            } catch (err) {
              sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
              return;
            }
            await active.db.update('_lattice_gui_audit', target.id, { undone: 0 });
            active.feed.publish({
              table: target.table_name,
              op: 'redo',
              rowId: null,
              source: 'gui',
              summary: schemaReverseSummary('Redid', target),
            });
            await emitDdlEnvelope(active, target.table_name);
            sendJson(res, { ok: true, entry: target });
            return;
          }
          const entry = await redoLast({
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
            sessionId,
          });
          if (!entry) {
            sendJson(res, { error: 'Nothing to redo' }, 400);
            return;
          }
          sendJson(res, { ok: true, entry });
          return;
        }
        if (method === 'POST' && pathname.startsWith('/api/history/revert/')) {
          const id = decodeURIComponent(pathname.slice('/api/history/revert/'.length));
          const row = (await active.db.get('_lattice_gui_audit', id)) as Record<
            string,
            unknown
          > | null;
          if (row && isSchemaOp(String(row.operation))) {
            const target = parseAudit(row);
            if (target.undone === 1) {
              sendJson(res, { error: 'Entry already undone' }, 400);
              return;
            }
            try {
              active = activeRef = await applySchemaConfig(active, target, 'inverse', autoRender);
            } catch (err) {
              sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
              return;
            }
            await active.db.update('_lattice_gui_audit', id, { undone: 1 });
            active.feed.publish({
              table: target.table_name,
              op: 'undo',
              rowId: null,
              source: 'gui',
              summary: schemaReverseSummary('Reverted', target),
            });
            await emitDdlEnvelope(active, target.table_name);
            sendJson(res, { ok: true });
            return;
          }
          const result = await revertEntry(
            {
              db: active.db,
              feed: active.feed,
              softDeletable: active.softDeletable,
              source: 'gui',
            },
            id,
          );
          if (!result.ok) {
            sendJson(
              res,
              {
                error:
                  result.reason === 'not_found' ? 'Audit entry not found' : 'Entry already undone',
              },
              result.reason === 'not_found' ? 404 : 400,
            );
            return;
          }
          sendJson(res, { ok: true });
          return;
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
          return;
        }
        if (method === 'GET' && /^\/api\/system-tables\/[^/]+\/rows$/.test(pathname)) {
          const parts = pathname.split('/');
          const sysTable = decodeURIComponent(parts[3] ?? '');
          // Accept underscore-prefixed internals OR the native conversation
          // tables surfaced under "System". Both are fixed/validated names, so
          // the interpolation into the SELECT below stays injection-safe.
          if (!/^_+[a-zA-Z0-9_]+$/.test(sysTable) && !isInternalNativeEntity(sysTable)) {
            sendJson(res, { error: 'Not a system table' }, 400);
            return;
          }
          const limit = Number(url.searchParams.get('limit') ?? '500');
          const rowsResult = (await (async () => {
            type Adapter = { allAsync?: (sql: string) => Promise<unknown[]> };
            const adapter = (active.db as unknown as { _adapter: Adapter })._adapter;
            return (
              adapter.allAsync?.(`SELECT * FROM "${sysTable}" LIMIT ${String(limit)}`) ??
              Promise.resolve([])
            );
          })()) as Record<string, unknown>[];
          sendJson(res, { rows: rowsResult });
          return;
        }

        // ── Workspaces (header switcher) ──────────────────────────────────
        // Additive: when the GUI was not opened inside a `.lattice` root,
        // these return empty and the header switcher stays hidden.
        if (method === 'GET' && pathname === '/api/workspaces') {
          if (!latticeRoot) {
            sendJson(res, { current: null, workspaces: [] });
            return;
          }
          const all = listWorkspaces(latticeRoot);
          const activeWs = getActiveWorkspace(latticeRoot);
          sendJson(res, {
            // The served workspace is the source of truth for the header label;
            // fall back to the registry only if we couldn't match the boot config.
            current: currentWorkspaceId ?? (activeWs ? activeWs.id : null),
            workspaces: all.map((w) => ({
              id: w.id,
              label: w.displayName,
              dir: w.dir,
              kind: w.kind,
            })),
          });
          return;
        }
        if (method === 'POST' && pathname === '/api/workspaces/switch') {
          if (!latticeRoot) {
            sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { id?: unknown };
          if (typeof body.id !== 'string') {
            sendJson(res, { error: 'id must be a string' }, 400);
            return;
          }
          const ws = getWorkspace(latticeRoot, body.id);
          if (!ws) {
            sendJson(res, { error: `No workspace with id ${body.id}` }, 400);
            return;
          }
          const paths = resolveWorkspacePaths(latticeRoot, ws);
          let opened: { db: ActiveDb } | { timedOut: true };
          try {
            opened = await openWithinTimeout(() =>
              openConfig(paths.configPath, paths.contextDir, autoRender),
            );
          } catch (e) {
            const err = e as Error;
            sendJson(
              res,
              { error: `Failed to open workspace ${ws.displayName}: ${err.message}` },
              500,
            );
            return;
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
            return;
          }
          const next = opened.db;
          setActiveWorkspace(latticeRoot, ws.id);
          await disposeActive(active);
          active = activeRef = next;
          startBackgroundRender(active); // render the new workspace's tree off the response path
          currentWorkspaceId = ws.id; // header now tracks the just-switched DB
          sendJson(res, { ok: true, id: ws.id });
          return;
        }
        // Reload the CURRENT workspace's schema in place: re-read the config and
        // re-register entities (so a table added out-of-band surfaces) WITHOUT a
        // full process restart. Reuses reopenSameConfig — same connection target,
        // fresh schema registration + converge. Lighter than killing the server.
        if (method === 'POST' && pathname === '/api/workspaces/reload') {
          try {
            active = activeRef = await reopenSameConfig(active, autoRender);
          } catch (e) {
            sendJson(res, { error: `Reload failed: ${(e as Error).message}` }, 500);
            return;
          }
          if (active.autoRender) startBackgroundRender(active);
          const tables = [...active.validTables].filter(
            (t) => !t.startsWith('_') && !t.startsWith('__'),
          );
          sendJson(res, { ok: true, tables, convergeWarnings: active.convergeWarnings });
          return;
        }
        if (method === 'POST' && pathname === '/api/workspaces/create') {
          if (!latticeRoot) {
            sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { name?: unknown };
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name) {
            sendJson(res, { error: 'name is required' }, 400);
            return;
          }
          let created;
          try {
            created = addWorkspace(latticeRoot, { displayName: name, makeActive: false });
          } catch (e) {
            sendJson(res, { error: `Failed to create workspace: ${(e as Error).message}` }, 500);
            return;
          }
          // Open + activate the new workspace (mirror the switch handler).
          const newPaths = resolveWorkspacePaths(latticeRoot, created);
          let newActive: ActiveDb;
          try {
            newActive = await openConfig(newPaths.configPath, newPaths.contextDir, autoRender);
          } catch (e) {
            sendJson(
              res,
              {
                error: `Created but failed to open ${created.displayName}: ${(e as Error).message}`,
              },
              500,
            );
            return;
          }
          setActiveWorkspace(latticeRoot, created.id);
          await disposeActive(active);
          active = activeRef = newActive;
          startBackgroundRender(active); // render the new workspace's tree off the response path
          currentWorkspaceId = created.id; // header tracks the new, now-served DB
          sendJson(res, { ok: true, id: created.id });
          return;
        }
        if (method === 'POST' && pathname === '/api/workspaces/delete') {
          if (!latticeRoot) {
            sendJson(res, { error: 'No .lattice root — workspaces unavailable' }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { id?: unknown };
          if (typeof body.id !== 'string') {
            sendJson(res, { error: 'id must be a string' }, 400);
            return;
          }
          const ws = getWorkspace(latticeRoot, body.id);
          if (!ws) {
            sendJson(res, { error: `No workspace with id ${body.id}` }, 400);
            return;
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
                next = await openConfig(fbPaths.configPath, fbPaths.contextDir, autoRender);
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
                return;
              }
              setActiveWorkspace(latticeRoot, fallback.id);
              await disposeActive(active);
              active = activeRef = next;
              startBackgroundRender(active); // render the fallback workspace's tree off the response path
              switchedTo = fallback.id;
              currentWorkspaceId = fallback.id; // deleted the served DB → header follows the fallback
            } else {
              // Deleting the LAST workspace → enter the virgin (zero-workspace)
              // state. Release the DB and leave the server with no active DB; the
              // client renders the welcome screen on the next /api/workspaces poll.
              await disposeActive(active);
              setActive(null, null);
              // `active` (the per-request local) is now stale, but the handler
              // returns immediately below — no further use this request.
            }
          }
          // Drop the registry record, then clean up files (loud on failure).
          removeWorkspace(latticeRoot, ws.id);
          try {
            if (!ws.configPath && ws.kind === 'local') {
              // Scaffolded local workspace: remove its whole folder (config+db+context).
              rmSync(workspaceDir(latticeRoot, ws.dir), { recursive: true, force: true });
            } else if (ws.kind === 'cloud') {
              // Cloud workspace: forget the LOCAL pointer only — never touch the
              // shared remote Postgres. Remove the managed sibling config (if any)
              // and drop the saved credential when no other workspace uses it.
              if (ws.configPath && existsSync(ws.configPath)) {
                rmSync(ws.configPath, { force: true });
              }
              const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(ws.db.trim());
              const label = labelMatch?.[1];
              if (label) {
                const stillUsed = listWorkspaces(latticeRoot).some((w) =>
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
          } catch (e) {
            sendJson(
              res,
              { error: `Workspace unregistered but file cleanup failed: ${(e as Error).message}` },
              500,
            );
            return;
          }
          sendJson(res, { ok: true, switchedTo });
          return;
        }

        if (method === 'GET' && pathname === '/api/databases') {
          const parsedActive = parseConfigFile(active.configPath);
          // Friendly name comes from the YAML's optional `name:` key, falling
          // back to the config basename.
          const friendlyLabel = friendlyConfigName(parsedActive.name, active.configPath);
          const kind: 'local' | 'cloud' = active.realtime ? 'cloud' : 'local';
          sendJson(res, {
            current: {
              path: active.configPath,
              dbFile: basename(parsedActive.dbPath),
              label: friendlyLabel,
              kind,
            },
            configs: listConfigs(active.configPath),
          });
          return;
        }
        if (method === 'POST' && pathname === '/api/databases/switch') {
          const body = (await readJson<unknown>(req)) as { path?: unknown };
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
          // bad config doesn't leave the server with no active DB. Common
          // failure mode: switching back to a cloud DB whose saved credential
          // was rotated or whose Postgres is now unreachable. Surface the
          // raw error verbatim so the UI's toast names the real cause.
          let next: ActiveDb;
          try {
            // Resolve the rendered-context root for THIS config (probing its
            // own directory), not the launch-wide outputDir. Reusing one
            // outputDir across every DB switch is what bled one DB's rendered
            // "files" view into another DB that had none of its own.
            next = await openConfig(newPath, resolveOutputDirForConfig(newPath), autoRender);
          } catch (e) {
            const err = e as Error & { code?: string };
            console.error(`[dbconfig.switch] openConfig(${newPath}) failed:`, err);
            const codePrefix = err.code ? `[${err.code}] ` : '';
            sendJson(
              res,
              { error: `Failed to switch to ${newPath}: ${codePrefix}${err.message}` },
              500,
            );
            return;
          }
          await disposeActive(active);
          active = activeRef = next;
          startBackgroundRender(active); // render the switched-to DB's tree off the response path
          sendJson(res, { ok: true, path: active.configPath });
          return;
        }
        if (method === 'POST' && pathname === '/api/databases/create') {
          const body = (await readJson<unknown>(req)) as { name?: unknown };
          if (typeof body.name !== 'string' || !body.name.trim()) {
            sendJson(res, { error: 'name must be a non-empty string' }, 400);
            return;
          }
          const newConfigPath = createBlankConfig(active.configPath, body.name.trim());
          const next = await openConfig(
            newConfigPath,
            resolveOutputDirForConfig(newConfigPath),
            autoRender,
          );
          await disposeActive(active);
          active = activeRef = next;
          startBackgroundRender(active); // render the newly-created DB's tree off the response path
          sendJson(res, { ok: true, path: active.configPath });
          return;
        }
        if (method === 'POST' && pathname === '/api/databases/delete') {
          const body = (await readJson<unknown>(req)) as { path?: unknown };
          if (typeof body.path !== 'string' || !body.path.trim()) {
            sendJson(res, { error: 'path must be a non-empty string' }, 400);
            return;
          }
          const target = resolve(body.path);
          // Only delete a config we actually list (same directory as the
          // active config). This stops the endpoint from being coaxed into
          // unlinking arbitrary files outside the database set.
          const known = listConfigs(active.configPath);
          const match = known.find((c) => resolve(c.path) === target);
          if (!match) {
            sendJson(res, { error: `Not a known database config: ${target}` }, 400);
            return;
          }
          // When deleting the active database we must switch away first so the
          // SQLite file handle is released (and the server keeps an active DB).
          let switchedTo: string | null = null;
          if (resolve(active.configPath) === target) {
            const fallback = known.find((c) => resolve(c.path) !== target);
            if (!fallback) {
              sendJson(
                res,
                {
                  error:
                    'Cannot delete the only database. Create or add another database first, then delete this one.',
                },
                400,
              );
              return;
            }
            let next: ActiveDb;
            try {
              next = await openConfig(
                fallback.path,
                resolveOutputDirForConfig(fallback.path),
                autoRender,
              );
            } catch (e) {
              const err = e as Error & { code?: string };
              const codePrefix = err.code ? `[${err.code}] ` : '';
              sendJson(
                res,
                {
                  error: `Cannot delete: failed to switch to ${fallback.path} first: ${codePrefix}${err.message}`,
                },
                500,
              );
              return;
            }
            await disposeActive(active);
            active = activeRef = next;
            startBackgroundRender(active); // render the fallback DB's tree off the response path
            switchedTo = active.configPath;
          }
          // Surface any filesystem failure loudly rather than
          // half-deleting silently.
          let deleted: { deletedConfig: string; deletedDbFile: string | null };
          try {
            deleted = deleteDatabaseFiles(target);
          } catch (e) {
            sendJson(
              res,
              { error: `Failed to delete database files: ${(e as Error).message}` },
              500,
            );
            return;
          }
          sendJson(res, {
            ok: true,
            deletedConfig: deleted.deletedConfig,
            deletedDbFile: deleted.deletedDbFile,
            switchedTo,
          });
          return;
        }

        // Native-entity bindings for the active DB — lets the UI badge the
        // files/secrets cards as "Native". openConfig auto-records these on
        // every open, so this is a straight read of the registry.
        if (method === 'GET' && pathname === '/api/native-entities') {
          sendJson(res, { bindings: await listNativeBindings(active.db) });
          return;
        }

        // ── GUI-only metadata (per-entity icon overrides) ─────────────────
        if (method === 'GET' && pathname === '/api/gui-meta') {
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
          return;
        }
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
          const row = await active.db.get(ctxTable, ctxId);
          if (row === null) {
            sendJson(res, { error: 'Row not found' }, 404);
            return;
          }
          const def = active.entityContextByTable.get(ctxTable);
          const locator = buildRowContextLocator(ctxTable, row, def, active.manifest);
          if (!locator) {
            // No schema-registered context AND no matching manifest entry.
            // Surface an empty file list — the SPA renders its
            // "no rendered context" placeholder.
            sendJson(res, { files: [] });
            return;
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
          return;
        }

        // ── Per-row version history (cloud): the recoverable trail of every
        // edit to one row, newest first.
        // GET /api/tables/:table/rows/:id/history. Empty on local SQLite.
        const rowHistMatch = ROW_HISTORY_PATH.exec(pathname);
        if (rowHistMatch && method === 'GET') {
          // Per-row history is rebuilt on the RLS change-feed (__lattice_changes)
          // in a follow-up; empty for now.
          sendJson(res, { history: [] });
          return;
        }

        // ── Last-edited-by, per row, for one table ────────────────────────
        // GET /api/tables/:table/last-edited → { edits: { <pk>: {ownerUserId,
        // at} } }. Now empty — the "last edited by" map is rebuilt on the RLS
        // model later.
        const lastEditedMatch = LAST_EDITED_PATH.exec(pathname);
        if (lastEditedMatch && method === 'GET') {
          sendJson(res, { edits: {} });
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
          const mctx: MutationCtx = {
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
            sessionId,
            ...(active.onColumnsAdded ? { onColumnsAdded: active.onColumnsAdded } : {}),
            // #4.6 — the originating client's true edit time, honored for the
            // audit timestamp so an offline edit shows when it was made.
            clientTs: headerValue(req, 'x-lattice-client-ts'),
          };

          if (id === null) {
            if (method === 'GET') {
              // #4.9 — bound + validate the page params: an unbounded `limit` is a
              // full-table egress on a cloud hot path, and `Number('abc')` was
              // becoming `LIMIT NaN`. Reject non-numeric; clamp limit ≤ MAX.
              const limit = parsePageParam(url.searchParams.get('limit'), 'limit');
              const offset = parsePageParam(url.searchParams.get('offset'), 'offset');
              if (limit === 'invalid' || offset === 'invalid') {
                sendJson(res, { error: 'limit and offset must be non-negative integers' }, 400);
                return;
              }
              const deletedMode = url.searchParams.get('deleted');
              // Row visibility is enforced by Postgres RLS at the database.
              const queryOpts: Parameters<typeof active.db.query>[1] = { limit, offset };
              if (active.softDeletable.has(table) && deletedMode !== 'any') {
                queryOpts.filters = [
                  { col: 'deleted_at', op: deletedMode === 'only' ? 'isNotNull' : 'isNull' },
                ];
              }
              // #2.1 — a member reads an audience-masked table through its
              // `<table>_v` view (base SELECT was revoked); the base name is used
              // everywhere else (validTables, ownership lookups, writes).
              const rows = await active.db.query(readRelationFor(active, table), queryOpts);
              await attachRowAccess(active.db, table, rows);
              sendJson(res, { rows });
              return;
            }
            if (method === 'POST') {
              const body = (await readJson<unknown>(req)) as Row;
              // #3.6 — pass the client edit-id through so a replayed offline POST
              // resolves to the same row (idempotent no-op) instead of a duplicate.
              const editId = headerValue(req, 'x-lattice-edit-id');
              const created = await createRow(mctx, table, body, undefined, editId);
              // A replayed POST (the row already existed) is reported as 200, not
              // 201, so the client can tell a fresh insert from an idempotent no-op.
              sendJson(res, { id: created.id }, created.idempotent ? 200 : 201);
              return;
            }
          } else {
            if (method === 'GET') {
              // #2.1 — route a masked table's single-row read through `<table>_v`
              // too (base SELECT revoked for members). Build the pk filter from the
              // BASE table's registered key; the view exposes the same columns.
              const readRel = readRelationFor(active, table);
              let row: Row | null;
              if (readRel === table) {
                row = await active.db.get(table, id);
              } else {
                // Masked tables use a single `id` PK in practice; filter the view
                // on the first PK column (fallback `id`) — the view exposes it.
                const pkCol = active.db.getPrimaryKey(table)[0] ?? 'id';
                const found = await active.db.query(readRel, { where: { [pkCol]: id }, limit: 1 });
                row = found[0] ?? null;
              }
              if (row === null) {
                sendJson(res, { error: 'Row not found' }, 404);
                return;
              }
              // A row the operator can't read already returns null (RLS-filtered /
              // not in the view), so reaching here means the row is visible.
              await attachRowAccess(active.db, table, [row]);
              sendJson(res, row);
              return;
            }
            if (method === 'PATCH') {
              const body = (await readJson<unknown>(req)) as Partial<Row>;
              await updateRow(mctx, table, id, body);
              sendJson(res, { ok: true });
              return;
            }
            if (method === 'DELETE') {
              const hard = url.searchParams.get('hard') === 'true';
              await deleteRow(mctx, table, id, hard);
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
          const body = (await readJson<unknown>(req)) as Row;
          const linkCtx: MutationCtx = {
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
            sessionId,
          };
          if (op === 'link') {
            await linkRows(linkCtx, table, body);
          } else {
            await unlinkRows(linkCtx, table, body);
          }
          sendJson(res, { ok: true });
          return;
        }

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
            addColumn: (table, column) => addUserColumn(active, table, column, sessionId),
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
            convergeWarnings: active.convergeWarnings,
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
