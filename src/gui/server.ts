import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { sendJson, readJson } from './http.js';
import {
  type ActiveDb,
  changeVisibleToActiveRole,
  isDeleteOp,
  isFeedHiddenTable,
  readRelationFor,
  attachRowAccess,
} from './active-db.js';
import {
  resolveOutputDirForConfig,
  friendlyConfigName,
  listConfigs,
  createBlankConfig,
  deleteDatabaseFiles,
} from './config-paths.js';
import {
  openConfig,
  startBackgroundRender,
  disposeActive,
  openWithinTimeout,
  reopenSameConfig,
  applySchemaConfig,
  SWITCH_OPEN_TIMEOUT_MS,
} from './lifecycle.js';
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
  getGuiProject,
  isJunctionTable,
  fileJunctions,
  entityDescriptions,
  type GuiEntitiesPayload,
  type GuiTableSummary,
} from './data.js';
import { entityFileNames, type LatticeManifest } from '../lifecycle/manifest.js';
import { guiAppHtml } from './app.js';
import type { Row } from '../types.js';
import { feedOpForChange } from './realtime.js';
import { createUpdateService, type UpdateService } from './update-service.js';
import { buildMutationCtx } from './request-context.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import {
  resolveColumnDescription,
  resolveTableDescription,
  upsertColumnMeta,
  upsertTableMeta,
} from './column-descriptions.js';
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
  softDeleteUserEntity,
  aiDeleteEntity,
  type DeleteResolution,
} from './schema-ops.js';
import { dispatchUserConfigRoute } from './userconfig-routes.js';
import { dispatchDbConfigRoute, redeemInvite } from './dbconfig-routes.js';
import { dispatchFilesRoute } from './files-routes.js';
import { dispatchAssistantRoute, getAggressiveness } from './assistant-routes.js';
import { dispatchChatRoute } from './chat-routes.js';
import { dispatchIngestRoute } from './ingest-routes.js';
import {
  listNativeBindings,
  isNativeEntity,
  isInternalNativeEntity,
  NATIVE_INTERNAL_NAMES,
} from '../framework/native-entities.js';
import { ASSISTANT_HIDDEN_TABLES } from './ai/dispatch.js';
import {
  readIdentity,
  writeIdentity,
  deleteDbCredential,
  saveDbCredential,
} from '../framework/user-config.js';
import type { StorageAdapter } from '../db/adapter.js';
import { countManyPostgres, exactCountMany } from './count-many.js';
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

interface ContextFile {
  name: string;
  path: string;
  content: string;
}

/**
 * A row-context locator describes the on-disk shape of a single rendered
 * entity directory — independent of whether the directory was produced by a
 * YAML-declared {@link EntityContextDefinition} or a programmatic
 * `db.defineEntityContext()` call (or, for users on the manifest-only path,
 * just by `lattice render` writing a manifest).
 */
interface RowContextLocator {
  /** Directory (relative to outputDir) that holds this row's files. */
  directoryRoot: string;
  /** Slug derived from the row — appended to directoryRoot. */
  slug: string;
  /** Filenames inside the entity directory to surface to the browser. */
  fileNames: string[];
}

/**
 * Best-effort slug derivation for the manifest-only fallback path.
 *
 * The on-disk manifest tells us which slug strings have been rendered
 * (`manifest.entityContexts[table].entities` is keyed by slug) but does
 * **not** persist the slug formula itself. So when we need to map a row
 * back to its directory and the Lattice schema doesn't carry an
 * {@link EntityContextDefinition} for this table, we try common fields
 * (`slug`, then `id`, then `name`) and pick the first whose value matches
 * a slug in the manifest. Returns `null` when no match is found.
 *
 * This is a heuristic — not a guarantee. The clean fix is for callers to
 * register their {@link EntityContextDefinition} so {@link Lattice.entityContexts}
 * has it; the manifest fallback exists so users who render via a
 * programmatic `lattice.schema.mjs` (and never wire that file into the GUI)
 * still see their rendered context.
 */
function deriveSlugFromManifest(
  row: Record<string, unknown>,
  knownSlugs: ReadonlySet<string>,
): string | null {
  const candidateFields = ['slug', 'id', 'name'];
  for (const field of candidateFields) {
    const value = row[field];
    if (typeof value === 'string' && knownSlugs.has(value)) return value;
  }
  return null;
}

/**
 * Build a {@link RowContextLocator} for `(table, row)` using the layered
 * discovery chain:
 *
 *   1. **Live Lattice schema** — anything registered via the YAML config or
 *      a programmatic `db.defineEntityContext()` call. Carries the
 *      authoritative slug function and declared file list.
 *   2. **Manifest** — entries written by a prior `lattice render`. Used
 *      when the schema doesn't know about this table (typical for projects
 *      that register entity contexts in an mjs/ts module the GUI doesn't
 *      import). The slug is derived heuristically from common row fields.
 *
 * Returns `null` when neither path yields a locator — the GUI surfaces
 * "no rendered context" to the user.
 */
function buildRowContextLocator(
  table: string,
  row: Record<string, unknown>,
  schemaDef: EntityContextDefinition | undefined,
  manifest: LatticeManifest | null,
): RowContextLocator | null {
  if (schemaDef) {
    return {
      directoryRoot: schemaDef.directoryRoot ?? '',
      slug: schemaDef.slug(row),
      fileNames: Object.keys(schemaDef.files),
    };
  }
  const manifestEntry = manifest?.entityContexts[table];
  if (!manifestEntry) return null;
  const knownSlugs = new Set(Object.keys(manifestEntry.entities));
  const derivedSlug = deriveSlugFromManifest(row, knownSlugs);
  if (!derivedSlug) return null;
  const entityFiles = manifestEntry.entities[derivedSlug];
  const fileNames = entityFiles ? entityFileNames(entityFiles) : manifestEntry.declaredFiles;
  return {
    directoryRoot: manifestEntry.directoryRoot,
    slug: derivedSlug,
    fileNames,
  };
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
  locator: RowContextLocator,
  secretCols: Set<string>,
): ContextFile[] {
  const { slug, directoryRoot, fileNames } = locator;
  const entityDir = resolve(outputDir, directoryRoot, slug);
  // Defence in depth: the slug must not escape outputDir.
  const resolvedBase = resolve(outputDir);
  if (entityDir !== resolvedBase && !entityDir.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal detected: slug "${slug}" escapes output directory`);
  }
  return fileNames.map((filename) => {
    const absPath = join(entityDir, filename);
    // POSIX-joined: relPath is a logical id returned to the browser, not a
    // filesystem path (absPath above is the native one for the read).
    const relPath = [directoryRoot, slug, filename].join('/');
    if (!existsSync(absPath)) return { name: filename, path: relPath, content: '' };
    let content = readFileSync(absPath, 'utf8');
    // Redact `<secretCol>: …` lines from the rendered markdown so the secret
    // value never reaches the browser (default-detail template writes one
    // `key: value` line per column).
    for (const col of secretCols) {
      const re = new RegExp(`^(${col}):.*$`, 'gm');
      content = content.replace(re, `$1: ••••••••`);
    }
    return { name: filename, path: relPath, content };
  });
}

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
          // #4.6 — the originating client's true edit time is honored for the
          // audit timestamp so an offline edit shows when it was made.
          const mctx = buildMutationCtx(active, 'gui', sessionId, {
            clientTs: headerValue(req, 'x-lattice-client-ts'),
          });

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
          const linkCtx = buildMutationCtx(active, 'gui', sessionId);
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
