import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { sendJson, readJson } from './http.js';
import { Lattice } from '../lattice.js';
import { parseConfigFile, fieldToSqliteBaseType } from '../config/parser.js';
import { findLatticeRoot } from '../framework/lattice-root.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  getWorkspace,
  addWorkspace,
  resolveWorkspacePaths,
} from '../framework/workspace.js';
import type { LatticeFieldDef } from '../config/types.js';
import type { EntityContextDefinition } from '../schema/entity-context.js';
import {
  buildGuiGraph,
  getGuiEntities,
  getGuiProject,
  isJunctionTable,
  type GuiEntitiesPayload,
  type GuiTableSummary,
} from './data.js';
import { readManifest, entityFileNames, type LatticeManifest } from '../lifecycle/manifest.js';
import { guiAppHtml } from './app.js';
import type { Row } from '../types.js';
import {
  CLOUD_INTERNAL_TABLE_DEFS,
  installCloudInternalTriggers,
} from '../teams/internal-tables.js';
import { recordObjectOwner } from '../teams/direct-ops.js';
import {
  type TeamContext,
  isVisibleInTeam,
  resolveTeamContext,
  shareEntityWithTeam,
  applySharingToContext,
  listTeamUsers,
} from './team-context.js';
import { RealtimeBroker } from './realtime.js';
import { isPostgresUrl } from '../teams/register-direct.js';
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
  type MutationCtx,
} from './mutations.js';
import { authenticate, type AuthContext } from '../teams/server/auth.js';
import { dispatchTeamRoute, UNAUTHENTICATED_TEAM_PATHS } from '../teams/server/routes.js';
import { TeamsClient } from '../teams/client.js';
import { dispatchTeamsGuiRoute } from './teams-routes.js';
import { dispatchUserConfigRoute } from './userconfig-routes.js';
import { dispatchDbConfigRoute } from './dbconfig-routes.js';
import { dispatchFilesRoute } from './files-routes.js';
import {
  registerNativeEntities,
  adoptNativeEntities,
  listNativeBindings,
  isNativeEntity,
} from '../framework/native-entities.js';
import { getOrCreateMasterKey, readIdentity } from '../framework/user-config.js';
import type { StorageAdapter } from '../db/adapter.js';
import { countManyPostgres } from './count-many.js';

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
  teamContext: TeamContext | null,
): Promise<GuiEntitiesPayload> {
  const payload = getGuiEntities(configPath, outputDir);

  const yamlNames = new Set(payload.tables.map((t) => t.name));
  let allTables = [...payload.tables, ...registeredExtraTables(db, yamlNames)];

  // Team-cloud visibility: a member sees only their own tables plus
  // tables shared to the team. This is what hides the creator's
  // private files/secrets (and other members' private tables) from
  // members, and other members' private tables from the creator.
  if (teamContext) {
    allTables = allTables.filter((t) => isVisibleInTeam(t.name, teamContext));
  }

  // Postgres: collapse the per-table COUNT(*) fan-out to one query against
  // pg_class. The naive Promise.all path below issues N parallel COUNTs
  // through the connection pool; on a session pooler with a small slot
  // budget (e.g. Supabase's 15-slot session pooler), N > slots locks up
  // the pool the moment two clients refresh at once.
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

  const enrichedTables = await Promise.all(
    allTables.map(async (t): Promise<GuiTableSummary> => {
      let rowCount: number | null;
      if (useBatched) {
        // Postgres: use the batched approximate count when we have it.
        // Tables absent from pg_class (newly defineLate'd, never analyzed)
        // get `null` so the SPA renders them as "—". No fallback per-table
        // COUNT: the whole point of this branch is to avoid the fan-out.
        rowCount = approxCounts.get(t.name) ?? null;
      } else {
        // SQLite: in-process, no pool. Keep the exact, soft-delete-aware
        // count we've always shipped.
        rowCount = t.columns.includes('deleted_at')
          ? await db.count(t.name, { filters: [{ col: 'deleted_at', op: 'isNull' }] })
          : await db.count(t.name);
      }
      const base: GuiTableSummary = { ...t, rowCount, native: isNativeEntity(t.name) };
      if (teamContext) {
        base.shared = teamContext.shared.has(t.name);
        base.ownedByMe = teamContext.owners.get(t.name) === teamContext.myUserId;
        const ver = teamContext.sharedVersions.get(t.name);
        if (ver !== undefined) base.schemaVersion = ver;
      }
      return base;
    }),
  );
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
  recent: { table: string; op: string; rowId: string | null; ts: string }[];
}

/**
 * Workspace overview: per-entity counts (reusing {@link entitiesWithCounts}) +
 * a freshness timestamp + the recent-activity list (the GUI audit log). This is
 * a read-only, GUI-only composition — it adds no core write-path behavior and
 * does not affect a library consumer of Lattice.
 */
async function dashboardPayload(
  db: Lattice,
  configPath: string,
  outputDir: string,
  teamContext: TeamContext | null,
): Promise<DashboardPayload> {
  const entityList = await entitiesWithCounts(db, configPath, outputDir, teamContext);
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
  let recent: DashboardPayload['recent'] = [];
  try {
    const raw = (await db.query('_lattice_gui_audit', { limit: 15 })) as Record<string, unknown>[];
    recent = raw
      .map(parseAudit)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 15)
      .map((e) => ({ table: e.table_name, op: e.operation, rowId: e.row_id, ts: e.ts }));
  } catch {
    // Audit table absent (a non-GUI-initialized DB) — recent stays empty.
  }
  return {
    generatedAt: new Date().toISOString(),
    staleDays: DASHBOARD_STALE_DAYS,
    totals: { entities: entities.length, rows: totalRows, stale: staleCount },
    entities,
    recent,
  };
}

const ROWS_PATH = /^\/api\/tables\/([^/]+)\/rows(?:\/(.+))?$/;
const CONTEXT_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/context$/;
const ROW_HISTORY_PATH = /^\/api\/tables\/([^/]+)\/rows\/([^/]+)\/history$/;
const LAST_EDITED_PATH = /^\/api\/tables\/([^/]+)\/last-edited$/;
const LINK_PATH = /^\/api\/tables\/([^/]+)\/(link|unlink)$/;

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
interface ActiveDb {
  configPath: string;
  outputDir: string;
  db: Lattice;
  validTables: Set<string>;
  /** Team-cloud ownership context, or null for local / non-team DBs. */
  teamContext: TeamContext | null;
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
   * Cached `TeamsClient` so sync write-hooks registered via
   * `attachWriteHooks` persist across requests. Reuses the same Lattice
   * instance the GUI's CRUD endpoints write through, so a row update
   * via the GUI dashboard fires the same outbox-capture hook as a
   * write from outside.
   */
  teamsClient: TeamsClient;
  /**
   * Active LISTEN/NOTIFY broker when the underlying Lattice is backed
   * by Postgres. Null for SQLite (no realtime). Owned by the active
   * DB; replaced wholesale on switch.
   */
  realtime: RealtimeBroker | null;
  /**
   * In-process activity feed for the sidebar. Unlike {@link ActiveDb.realtime}
   * (Postgres-only), this works for every dialect — every audited mutation is
   * published here and streamed to the sidebar over /api/feed/stream. Owned by
   * the active DB; replaced wholesale on switch (clients reconnect).
   */
  feed: FeedBus;
  /** Original db: connection string from the YAML, used to spin up the broker. */
  dbPath: string;
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

async function openConfig(configPath: string, outputDir: string): Promise<ActiveDb> {
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
    },
    render: () => '',
    outputFile: '.lattice-gui/audit.md',
  });
  await db.init();

  // Mirror ~/.lattice/identity.json into __lattice_user_identity so the
  // active Lattice has a current view of who the operator is. Idempotent:
  // every open just upserts the single 'singleton' row.
  await syncUserIdentityRow(db);

  // Reconcile + record native-entity bindings (files, secrets). Labels a
  // pre-existing files/secrets table as THE native object (merging the native
  // column superset, non-destructively) rather than duplicating it, and
  // guarantees the tables exist on freshly created DBs. Safe on every open.
  await adoptNativeEntities(db);

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
  const junctionTables = new Set(
    getGuiEntities(configPath, outputDir)
      .tables.filter(isJunctionTable)
      .map((t) => t.name),
  );
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
  const teamsClient = new TeamsClient(db);
  // Re-arm sync write-hooks for any tables that already have local
  // links (i.e. the user is part of teams + linked rows in a prior
  // session). Idempotent — safe to call on every openConfig.
  await teamsClient.attachWriteHooks();

  // Auto-discover shared-table schemas for every team this lattice has
  // joined. Without this, a fresh `lattice gui` against a joined-team
  // cloud config opens to "No entities yet. Define entities in your
  // lattice.config.yml or register them via db.define()..." because
  // the YAML `entities: {}` block carries no schema and the cloud's
  // `__lattice_shared_objects` rows haven't been replayed into the
  // local Lattice's in-memory schema. Each `applyCloudSchemaLocally`
  // calls `defineLate` under the hood — idempotent on re-open.
  //
  // Failures here are isolated per-team: a single dead cloud must not
  // block the GUI from booting. Discovery errors are logged but
  // swallowed; the user sees a less-populated dropdown rather than
  // a 500.
  try {
    const connections = await teamsClient.listConnections();
    for (const conn of connections) {
      try {
        const result = await teamsClient.syncSharedSchemas(conn);
        for (const obj of result.applied) {
          validTables.add(obj.table);
        }
        if (result.conflicts.length > 0) {
          console.warn(
            `[openConfig] schema conflicts on team ${conn.team_name}:`,
            result.conflicts.map((c) => `${c.table}: ${c.reason}`).join('; '),
          );
        }
      } catch (e) {
        console.warn(
          `[openConfig] could not auto-sync shared schemas for team ${conn.team_name}:`,
          (e as Error).message,
        );
      }
    }
  } catch (e) {
    console.warn('[openConfig] could not enumerate team connections:', (e as Error).message);
  }

  // ── Team-cloud ownership context ──────────────────────────────────
  // When the active DB is a team-enabled Postgres cloud, every member
  // shares the same physical Postgres — so every table physically
  // exists for everyone. Register the internal tables on this handle
  // (so direct team ops like kick know composite PKs), resolve who the
  // operator is + per-table ownership, then restrict the visible /
  // queryable table set to (tables I own) ∪ (tables shared to the
  // team). Native files/secrets, owned by the creator, vanish for
  // members unless explicitly shared.
  let teamContext: TeamContext | null = null;
  if (db.getDialect() === 'postgres') {
    let teamEnabled = false;
    try {
      teamEnabled = (await db.get('__lattice_team_identity', 'singleton')) != null;
    } catch {
      teamEnabled = false;
    }
    if (teamEnabled) {
      await registerTeamCloudTables(db);
      try {
        teamContext = await resolveTeamContext(db, teamsClient, parsed.dbPath, [...validTables]);
      } catch (e) {
        console.warn(
          '[openConfig] could not resolve team ownership context:',
          (e as Error).message,
        );
      }
    }
  }
  if (teamContext) {
    for (const name of [...validTables]) {
      if (!isVisibleInTeam(name, teamContext)) validTables.delete(name);
    }
  }

  // Realtime broker — only meaningful when the active DB is Postgres.
  // The broker connects on creation; status/payload events stream out
  // via the SSE endpoint. SQLite configs leave this as null and the
  // status pill reports the local-mode (yellow) state.
  let realtime: RealtimeBroker | null = null;
  if (db.getDialect() === 'postgres') {
    try {
      realtime = new RealtimeBroker(parsed.dbPath);
      await realtime.start();
    } catch (e) {
      console.warn('[openConfig] realtime broker init failed:', (e as Error).message);
      realtime = null;
    }
  }

  // Keep this server's team-visibility set live when ANOTHER client shares
  // or unshares a table: the share/unshare envelope arrives over NOTIFY, so
  // we update `teamContext.shared` + `validTables` in place — no DB re-open,
  // and the browser's existing `change`-driven refetch then sees the new
  // visibility. `op:'schema'` ⇒ (re)shared, `op:'unshare'` ⇒ unshared.
  if (realtime && teamContext) {
    const tc = teamContext;
    realtime.subscribePayload((p) => {
      if (p.op !== 'schema' && p.op !== 'unshare') return;
      if (!p.table_name) return;
      applySharingToContext(tc, validTables, p.table_name, p.op === 'schema');
    });
  }

  return {
    configPath,
    outputDir,
    db,
    teamsClient,
    validTables,
    teamContext,
    junctionTables,
    entityContextByTable,
    manifest,
    softDeletable,
    realtime,
    feed: new FeedBus(),
    dbPath: parsed.dbPath,
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
async function execSql(db: Lattice, sql: string): Promise<void> {
  type Adapter = { runAsync?: (sql: string) => Promise<void> };
  const adapter = (db as unknown as { _adapter: Adapter })._adapter;
  if (!adapter.runAsync) throw new Error('Adapter does not support runAsync');
  await adapter.runAsync(sql);
}

/**
 * Parse the config YAML as a round-trip Document so we can mutate it while
 * preserving comments and ordering. Callers should call `doc.toString()` to
 * serialize, then writeFileSync the result.
 */
function loadConfigDoc(configPath: string): ReturnType<typeof parseDocument> {
  return parseDocument(readFileSync(configPath, 'utf8'));
}

function saveConfigDoc(configPath: string, doc: ReturnType<typeof parseDocument>): void {
  writeFileSync(configPath, doc.toString(), 'utf8');
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
async function disposeActive(active: ActiveDb): Promise<void> {
  if (active.realtime) {
    try {
      await active.realtime.stop();
    } catch {
      // best-effort
    }
  }
  try {
    active.db.close();
  } catch {
    // best-effort
  }
}

async function registerTeamCloudTables(db: Lattice): Promise<void> {
  for (const [name, def] of Object.entries(CLOUD_INTERNAL_TABLE_DEFS)) {
    await db.defineLate(name, def);
  }
  await installCloudInternalTriggers(db);
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
  // Discover the `.lattice` root (if the GUI was opened inside a workspace) so
  // the header workspace switcher can list + switch workspaces. `null` ⇒ the
  // GUI was opened on a plain config; the switcher stays hidden.
  const latticeRoot = findLatticeRoot(dirname(configPath));
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

        // ── Realtime: connection status + LISTEN/NOTIFY SSE stream ──────────
        // /api/realtime/status — single-shot JSON snapshot of mode + state.
        // /api/realtime/stream — Server-Sent Events; one event per NOTIFY
        // payload plus 'state' events on connection transitions.
        if (method === 'GET' && pathname === '/api/realtime/status') {
          const mode: 'local' | 'cloud' = active.realtime ? 'cloud' : 'local';
          const connected = active.realtime?.state() === 'connected';
          sendJson(res, { mode, state: active.realtime?.state() ?? 'local', connected });
          return;
        }
        if (method === 'GET' && pathname === '/api/realtime/stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          const broker = active.realtime;
          const initialMode: 'local' | 'cloud' = broker ? 'cloud' : 'local';
          const writeEvent = (event: string, data: unknown): void => {
            try {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch {
              // socket closed — handled by 'close' below
            }
          };
          writeEvent('state', {
            mode: initialMode,
            state: broker?.state() ?? 'local',
          });
          const keepalive = setInterval(() => {
            try {
              res.write(`: keepalive\n\n`);
            } catch {
              // socket closed
            }
          }, 25_000);
          const offState = broker?.subscribeState((state) => {
            writeEvent('state', { mode: 'cloud', state });
          });
          const offPayload = broker?.subscribePayload((payload) => {
            writeEvent('change', payload);
          });
          const cleanup = (): void => {
            clearInterval(keepalive);
            if (offState) offState();
            if (offPayload) offPayload();
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          return;
        }

        // ── Activity feed SSE: every audited mutation, for the sidebar ──────
        // Works for every dialect (SQLite included), unlike /api/realtime/*
        // which depends on Postgres LISTEN/NOTIFY. On connect we backfill the
        // most recent events so a freshly opened sidebar isn't blank.
        if (method === 'GET' && pathname === '/api/feed/stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          const writeFeed = (data: unknown): void => {
            try {
              res.write(`event: feed\ndata: ${JSON.stringify(data)}\n\n`);
            } catch {
              // socket closed — handled by 'close' below
            }
          };
          for (const e of active.feed.recent(20)) writeFeed(e);
          const keepalive = setInterval(() => {
            try {
              res.write(`: keepalive\n\n`);
            } catch {
              // socket closed
            }
          }, 25_000);
          // Track keys of this server's own mutations so we can suppress the
          // Postgres NOTIFY echo of them below (avoids double feed entries on
          // cloud DBs); genuine other-client changes still come through.
          const recentSelf = new Map<string, number>();
          const offFeed = active.feed.subscribe((e) => {
            recentSelf.set(`${e.table ?? ''}:${e.rowId ?? ''}:${e.op}`, Date.now());
            writeFeed(e);
          });
          // Merge the Postgres realtime broker so changes made by OTHER clients
          // on a shared cloud DB also appear in the feed (SQLite has no broker).
          const offBroker = active.realtime?.subscribePayload((p) => {
            const op =
              p.op === 'INSERT'
                ? 'insert'
                : p.op === 'UPDATE'
                  ? 'update'
                  : p.op === 'DELETE'
                    ? 'delete'
                    : null;
            if (!op || !p.table_name || p.table_name.startsWith('_lattice')) return;
            const key = `${p.table_name}:${p.pk ?? ''}:${op}`;
            const seen = recentSelf.get(key);
            if (seen && Date.now() - seen < 5000) return; // our own mutation, already shown
            writeFeed({
              seq: p.seq,
              table: p.table_name,
              op,
              rowId: p.pk,
              source: 'cli',
              ts: p.created_at || new Date().toISOString(),
              summary: `${op} on ${p.table_name} (another client)`,
            });
          });
          const cleanup = (): void => {
            clearInterval(keepalive);
            offFeed();
            if (offBroker) offBroker();
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          return;
        }
        if (method === 'GET' && pathname === '/api/project') {
          sendJson(res, getGuiProject(active.configPath, active.outputDir));
          return;
        }
        if (method === 'GET' && pathname === '/api/entities') {
          sendJson(
            res,
            await entitiesWithCounts(
              active.db,
              active.configPath,
              active.outputDir,
              active.teamContext,
            ),
          );
          return;
        }
        if (method === 'GET' && pathname === '/api/dashboard') {
          sendJson(
            res,
            await dashboardPayload(
              active.db,
              active.configPath,
              active.outputDir,
              active.teamContext,
            ),
          );
          return;
        }
        // ── Full-text search across visible tables ────────────────────────
        // GET /api/search?q=&tables=&limit= — LIKE fallback + indexed (FTS5 /
        // tsvector) per the engine in src/search/fts.ts. Scoped to validTables
        // (team-visibility-filtered when in cloud mode).
        if (method === 'GET' && pathname === '/api/search') {
          const q = (url.searchParams.get('q') ?? '').trim();
          if (!q) {
            sendJson(res, { query: '', groups: [] });
            return;
          }
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '8')));
          const requested = url.searchParams.get('tables');
          let tables = [...active.validTables];
          if (requested) {
            const want = new Set(
              requested
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            );
            tables = tables.filter((t) => want.has(t));
          }
          sendJson(
            res,
            await fullTextSearch(active.db.adapter, tables, { query: q, limitPerTable: limit }),
          );
          return;
        }
        // ── Team members (for "last edited by" name resolution) ───────────
        // GET /api/team/users → { users: [{id,email,name}] }. Empty on local.
        if (method === 'GET' && pathname === '/api/team/users') {
          const users = active.teamContext ? await listTeamUsers(active.db) : [];
          sendJson(res, { users });
          return;
        }
        if (method === 'GET' && pathname === '/api/graph') {
          const yamlNames = new Set(
            getGuiEntities(active.configPath, active.outputDir).tables.map((t) => t.name),
          );
          const ctx = active.teamContext;
          const graphOpts: import('./data.js').BuildGuiGraphOptions = {
            extraTables: registeredExtraTables(active.db, yamlNames),
          };
          if (ctx) graphOpts.visibleFilter = (name) => isVisibleInTeam(name, ctx);
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
          await execSql(
            active.db,
            `CREATE TABLE "${entityName}" (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT)`,
          );
          const doc = loadConfigDoc(active.configPath);
          doc.setIn(['entities', entityName], {
            fields: {
              id: { type: 'uuid', primaryKey: true },
              name: { type: 'text', required: true },
              deleted_at: { type: 'text' },
            },
            outputFile: entityName.toUpperCase() + '.md',
          });
          saveConfigDoc(active.configPath, doc);
          // Save icon override if provided
          if (typeof body.icon === 'string' && body.icon.trim()) {
            await active.db.insert('_lattice_gui_meta', {
              entity_name: entityName,
              icon: body.icon.trim(),
              updated_at: new Date().toISOString(),
            });
          }
          // Team cloud: record the creator as owner BEFORE re-opening, so
          // the reopen's reconcile (which assigns unowned tables to the
          // team creator) doesn't steal a member's new table. New tables
          // are private to their creator — sharing is an explicit,
          // separate action from the Data Model dialog.
          if (active.teamContext?.myUserId) {
            await recordObjectOwner(
              active.db,
              active.teamContext.teamId,
              entityName,
              active.teamContext.myUserId,
            );
          }
          await disposeActive(active);
          active = await openConfig(active.configPath, active.outputDir);
          sendJson(res, { ok: true, name: entityName });
          return;
        }

        // ── Share / unshare an entity with the team (owner-only) ─────────
        // The Data Model dialog calls this to toggle team visibility of a
        // table the operator owns. Only the owner may share/unshare; the
        // team creator can't reach into another member's private tables.
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/share$/.test(pathname)) {
          const table = decodeURIComponent(pathname.split('/')[4] ?? '');
          const ctx = active.teamContext;
          if (!ctx) {
            sendJson(res, { error: 'Sharing is only available on team cloud databases' }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as { share?: unknown };
          const wantShare = body.share === true;
          const result = await shareEntityWithTeam(
            active.db,
            active.dbPath,
            ctx,
            active.validTables,
            table,
            wantShare,
          );
          if (result.status === 200) {
            // Update visibility in place instead of re-opening the DB — keeps
            // the realtime broker connection alive (no LISTEN reconnect) and
            // lets the client reflect the change with a light /api/entities
            // refetch. Other clients converge via the broker subscription
            // wired in openConfig.
            applySharingToContext(ctx, active.validTables, table, wantShare);
          }
          sendJson(res, result.body, result.status);
          return;
        }

        // ── GUI column metadata (per-column secret flag) ─────────────────
        if (method === 'GET' && pathname === '/api/gui-meta/columns') {
          const rows = (await active.db.query('_lattice_gui_column_meta', {})) as {
            table_name: string;
            column_name: string;
            secret: number;
          }[];
          const out: Record<string, Record<string, { secret: boolean }>> = {};
          for (const r of rows) {
            const bucket = out[r.table_name] ?? (out[r.table_name] = {});
            bucket[r.column_name] = { secret: r.secret === 1 };
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
          const body = (await readJson<unknown>(req)) as { secret?: unknown };
          const secret = body.secret === true ? 1 : 0;
          const existing = (
            (await active.db.query('_lattice_gui_column_meta', {
              filters: [
                { col: 'table_name', op: 'eq', val: tableName },
                { col: 'column_name', op: 'eq', val: colName },
              ],
            })) as { id: string }[]
          )[0];
          if (existing) {
            await active.db.update('_lattice_gui_column_meta', existing.id, {
              secret,
              updated_at: new Date().toISOString(),
            });
          } else {
            await active.db.insert('_lattice_gui_column_meta', {
              id: crypto.randomUUID(),
              table_name: tableName,
              column_name: colName,
              secret,
              updated_at: new Date().toISOString(),
            });
          }
          sendJson(res, { ok: true });
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
          await disposeActive(active);
          active = await openConfig(active.configPath, active.outputDir);
          sendJson(res, { ok: true });
          return;
        }
        if (method === 'POST' && /^\/api\/schema\/entities\/[^/]+\/columns$/.test(pathname)) {
          const entityName = decodeURIComponent(pathname.split('/')[4] ?? '');
          if (!active.validTables.has(entityName)) {
            sendJson(res, { error: `Unknown entity: ${entityName}` }, 400);
            return;
          }
          const body = (await readJson<unknown>(req)) as {
            name?: unknown;
            type?: unknown;
            required?: unknown;
            ref?: unknown;
          };
          const colName = typeof body.name === 'string' ? body.name.trim() : '';
          const colType = (
            typeof body.type === 'string' ? body.type : 'text'
          ) as LatticeFieldDef['type'];
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
            sendJson(res, { error: 'Column name must be a valid identifier' }, 400);
            return;
          }
          const sqliteType = fieldToSqliteBaseType(colType);
          await execSql(
            active.db,
            `ALTER TABLE "${entityName}" ADD COLUMN "${colName}" ${sqliteType}`,
          );
          const doc = loadConfigDoc(active.configPath);
          const fieldDef: Record<string, unknown> = { type: colType };
          if (body.required === true) fieldDef.required = true;
          if (typeof body.ref === 'string') fieldDef.ref = body.ref;
          doc.setIn(['entities', entityName, 'fields', colName], fieldDef);
          saveConfigDoc(active.configPath, doc);
          await disposeActive(active);
          active = await openConfig(active.configPath, active.outputDir);
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
          const body = (await readJson<unknown>(req)) as { to?: unknown };
          const newCol = typeof body.to === 'string' ? body.to.trim() : '';
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newCol)) {
            sendJson(res, { error: 'New column name must be a valid identifier' }, 400);
            return;
          }
          if (colName === 'id') {
            sendJson(res, { error: 'Cannot rename the id primary key column' }, 400);
            return;
          }
          await execSql(
            active.db,
            `ALTER TABLE "${entityName}" RENAME COLUMN "${colName}" TO "${newCol}"`,
          );
          const doc = loadConfigDoc(active.configPath);
          const fieldDef: unknown = doc.getIn(['entities', entityName, 'fields', colName]);
          doc.deleteIn(['entities', entityName, 'fields', colName]);
          doc.setIn(['entities', entityName, 'fields', newCol], fieldDef);
          saveConfigDoc(active.configPath, doc);
          await disposeActive(active);
          active = await openConfig(active.configPath, active.outputDir);
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
          // Counts for the toolbar's enable/disable state (always over the
          // full set so undo/redo aren't disabled by an active filter).
          const allEntries = raw.map(parseAudit);
          const liveCount = allEntries.filter((e) => e.undone === 0).length;
          const undoneCount = allEntries.length - liveCount;
          sendJson(res, { entries, canUndo: liveCount > 0, canRedo: undoneCount > 0 });
          return;
        }
        if (method === 'POST' && pathname === '/api/history/undo') {
          const entry = await undoLast({
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
          });
          if (!entry) {
            sendJson(res, { error: 'Nothing to undo' }, 400);
            return;
          }
          sendJson(res, { ok: true, entry });
          return;
        }
        if (method === 'POST' && pathname === '/api/history/redo') {
          const entry = await redoLast({
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
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
          // Postgres-backed Lattice (migrated cloud, team cloud) those
          // queries threw and the System sidebar silently rendered empty.
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
          const tables: { name: string; columns: string[]; rowCount: number }[] = [];
          for (const r of rows) {
            // Lattice.introspectColumns dispatches on dialect internally:
            // PRAGMA table_info on SQLite, information_schema.columns on
            // Postgres. Returns string[] of column names either way.
            const cols = await active.db.introspectColumns(r.name);
            const rowCount = await active.db.count(r.name);
            tables.push({ name: r.name, columns: cols, rowCount });
          }
          sendJson(res, { tables });
          return;
        }
        if (method === 'GET' && /^\/api\/system-tables\/[^/]+\/rows$/.test(pathname)) {
          const parts = pathname.split('/');
          const sysTable = decodeURIComponent(parts[3] ?? '');
          if (!/^_+[a-zA-Z0-9_]+$/.test(sysTable)) {
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

        // ── Database switcher ─────────────────────────────────────────────
        // Disabled in team-cloud mode — switching the active DB out from
        // under other members would corrupt their session view and bypass
        // the team's auth + share contract.
        // ── Workspaces (header switcher) ──────────────────────────────────
        // Additive: when the GUI was not opened inside a `.lattice` root,
        // these return empty and the header switcher stays hidden.
        if (method === 'GET' && pathname === '/api/workspaces') {
          if (teamCloud || !latticeRoot) {
            // Disabled in team-cloud mode (switching the active DB out from
            // under members would bypass the auth + share contract).
            sendJson(res, { current: null, workspaces: [] });
            return;
          }
          const all = listWorkspaces(latticeRoot);
          const activeWs = getActiveWorkspace(latticeRoot);
          sendJson(res, {
            current: activeWs ? activeWs.id : null,
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
          if (teamCloud) {
            sendJson(res, { error: 'Workspace switching is disabled in team-cloud mode' }, 403);
            return;
          }
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
          let next: ActiveDb;
          try {
            next = await openConfig(paths.configPath, paths.contextDir);
          } catch (e) {
            const err = e as Error;
            sendJson(
              res,
              { error: `Failed to open workspace ${ws.displayName}: ${err.message}` },
              500,
            );
            return;
          }
          setActiveWorkspace(latticeRoot, ws.id);
          await disposeActive(active);
          active = next;
          sendJson(res, { ok: true, id: ws.id });
          return;
        }
        if (method === 'POST' && pathname === '/api/workspaces/create') {
          if (teamCloud) {
            sendJson(res, { error: 'Workspace creation is disabled in team-cloud mode' }, 403);
            return;
          }
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
            newActive = await openConfig(newPaths.configPath, newPaths.contextDir);
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
          active = newActive;
          sendJson(res, { ok: true, id: created.id });
          return;
        }

        if (teamCloud && pathname.startsWith('/api/databases')) {
          sendJson(res, { error: 'Database switching is disabled in team-cloud mode' }, 403);
          return;
        }
        if (method === 'GET' && pathname === '/api/databases') {
          const parsedActive = parseConfigFile(active.configPath);
          // For cloud DBs, the friendly name lives on
          // __lattice_team_identity.team_name. Fall back to the YAML's
          // optional name: key (used by local DBs), then the basename.
          let activeLabel: string | undefined;
          try {
            const row = (await active.db.get('__lattice_team_identity', 'singleton')) as {
              team_name?: string;
            } | null;
            if (row && typeof row.team_name === 'string' && row.team_name.trim()) {
              activeLabel = row.team_name.trim();
            }
          } catch {
            // Table absent or unreachable — leave undefined.
          }
          const friendlyLabel =
            activeLabel ?? friendlyConfigName(parsedActive.name, active.configPath);
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
            next = await openConfig(newPath, resolveOutputDirForConfig(newPath));
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
          active = next;
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
          const next = await openConfig(newConfigPath, resolveOutputDirForConfig(newConfigPath));
          await disposeActive(active);
          active = next;
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
              next = await openConfig(fallback.path, resolveOutputDirForConfig(fallback.path));
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
            active = next;
            switchedTo = active.configPath;
          }
          // Surface any filesystem failure loudly (the fail-loudly rule) rather than
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
          const body = (await readJson<unknown>(req)) as { icon?: unknown };
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

        // ── Per-row version history (team cloud): the recoverable trail of
        // every edit to one row, newest first, from __lattice_change_log.
        // GET /api/tables/:table/rows/:id/history. Empty on local SQLite.
        const rowHistMatch = ROW_HISTORY_PATH.exec(pathname);
        if (rowHistMatch && method === 'GET') {
          const table = decodeURIComponent(rowHistMatch[1] ?? '');
          const rowId = decodeURIComponent(rowHistMatch[2] ?? '');
          const tctx = active.teamContext;
          if (!tctx) {
            sendJson(res, { history: [] });
            return;
          }
          if (!active.validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
          const rows = (await active.db.query('__lattice_change_log', {
            filters: [
              { col: 'team_id', op: 'eq', val: tctx.teamId },
              { col: 'table_name', op: 'eq', val: table },
              { col: 'pk', op: 'eq', val: rowId },
            ],
            orderBy: 'seq',
            orderDir: 'desc',
            limit,
          })) as unknown as {
            seq: number;
            op: string;
            owner_user_id: string | null;
            created_at: string;
            client_ts: string | null;
            payload_json: string | null;
          }[];
          sendJson(res, {
            history: rows.map((r) => ({
              seq: r.seq,
              op: r.op,
              ownerUserId: r.owner_user_id,
              at: r.client_ts ?? r.created_at,
              payload: r.payload_json ? (JSON.parse(r.payload_json) as unknown) : null,
            })),
          });
          return;
        }

        // ── Last-edited-by, per row, for one table (team cloud) ───────────
        // GET /api/tables/:table/last-edited → { edits: { <pk>: {ownerUserId,
        // at} } } from the change-log (latest seq per pk). Seeds the client's
        // "last edited by" map for rows touched before this session. Empty on
        // local SQLite.
        const lastEditedMatch = LAST_EDITED_PATH.exec(pathname);
        if (lastEditedMatch && method === 'GET') {
          const table = decodeURIComponent(lastEditedMatch[1] ?? '');
          const tctx = active.teamContext;
          if (!tctx) {
            sendJson(res, { edits: {} });
            return;
          }
          if (!active.validTables.has(table)) {
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }
          // Scan recent change-log rows (newest first) and keep the first
          // (latest) entry per pk — that's the most recent edit to each row.
          const scan = (await active.db.query('__lattice_change_log', {
            filters: [
              { col: 'team_id', op: 'eq', val: tctx.teamId },
              { col: 'table_name', op: 'eq', val: table },
            ],
            orderBy: 'seq',
            orderDir: 'desc',
            limit: 2000,
          })) as unknown as {
            pk: string | null;
            owner_user_id: string | null;
            created_at: string;
            client_ts: string | null;
          }[];
          const edits: Record<string, { ownerUserId: string | null; at: string }> = {};
          for (const r of scan) {
            if (!r.pk || edits[r.pk]) continue;
            edits[r.pk] = { ownerUserId: r.owner_user_id, at: r.client_ts ?? r.created_at };
          }
          sendJson(res, { edits });
          return;
        }

        // ── Row CRUD: /api/tables/:table/rows[/:id] ───────────────────────
        const rowsMatch = ROWS_PATH.exec(pathname);
        if (rowsMatch) {
          const [, rawTable, rawId] = rowsMatch;
          const table = decodeURIComponent(rawTable ?? '');
          const id = rawId ? decodeURIComponent(rawId) : null;
          if (!active.validTables.has(table)) {
            // In team mode, a table that physically exists but isn't visible
            // was unshared (or never shared to you) — return a distinct 409 so
            // the client can toast "this was unshared" and refetch, rather than
            // treating it as a generic unknown table. Owners always retain
            // visibility, so this only bites non-owners after a de-share.
            if (active.teamContext && active.db.getRegisteredTableNames().includes(table)) {
              sendJson(res, { error: 'entity_unshared', table }, 409);
              return;
            }
            sendJson(res, { error: `Unknown table: ${table}` }, 400);
            return;
          }
          const clientTsHeader = req.headers['x-lattice-client-ts'];
          const mctx: MutationCtx = {
            db: active.db,
            feed: active.feed,
            softDeletable: active.softDeletable,
            source: 'gui',
            team: active.teamContext
              ? { teamId: active.teamContext.teamId, myUserId: active.teamContext.myUserId }
              : null,
            clientTs: typeof clientTsHeader === 'string' ? clientTsHeader : undefined,
          };

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
              const body = (await readJson<unknown>(req)) as Row;
              const { id: newId } = await createRow(mctx, table, body);
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
          };
          if (op === 'link') {
            await linkRows(linkCtx, table, body);
          } else {
            await unlinkRows(linkCtx, table, body);
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
            configPath: active.configPath,
            pathname,
            method,
            validTables: active.validTables,
            // When the active DB IS the team cloud (direct-Postgres mode),
            // there's no local connection row — team ops fall back to
            // this resolved context (cloud url + my identity + role).
            cloudUrl: active.db.getDialect() === 'postgres' ? active.dbPath : null,
            teamContext: active.teamContext
              ? {
                  teamId: active.teamContext.teamId,
                  myUserId: active.teamContext.myUserId,
                  isCreator: active.teamContext.isCreator,
                  isMember: active.teamContext.isMember,
                }
              : null,
          });
          if (handled) return;
        }

        // ── User Config routes ───────────────────────────────────────────
        // Reads + writes machine-local user identity and the saved
        // cloud-DB credential catalog. Same auth model as the other
        // GUI dev-tool routes — localhost trust, team-cloud disables.
        if (!teamCloud && pathname.startsWith('/api/userconfig/')) {
          const handled = await dispatchUserConfigRoute(req, res, {
            db: active.db,
            configPath: active.configPath,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── Files: blob serving + open-in-finder ──────────────────────────
        if (!teamCloud && pathname.startsWith('/api/files/')) {
          const handled = await dispatchFilesRoute(req, res, {
            db: active.db,
            pathname,
            method,
          });
          if (handled) return;
        }

        // ── DB Config routes ─────────────────────────────────────────────
        // Project Config "Database" panel — read / save / connect / test.
        // The `swap` callback re-opens the active configPath so the
        // YAML rewrite written by `/save` takes effect.
        if (!teamCloud && pathname.startsWith('/api/dbconfig')) {
          const handled = await dispatchDbConfigRoute(req, res, {
            db: active.db,
            configPath: active.configPath,
            pathname,
            method,
            teamMembership: active.teamContext
              ? {
                  joined: active.teamContext.isMember,
                  isCreator: active.teamContext.isCreator,
                  teamId: active.teamContext.teamId,
                  myUserId: active.teamContext.myUserId,
                }
              : null,
            swap: async () => {
              const next = await openConfig(active.configPath, active.outputDir);
              await disposeActive(active);
              active = next;
            },
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
      new Promise<void>((resolveClose, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          void disposeActive(active).then(() => {
            resolveClose();
          });
        });
        // Force-drop lingering keep-alive / SSE connections (the realtime
        // `/api/realtime/stream` EventSource stays open indefinitely), so
        // close() doesn't hang waiting for a browser tab to disconnect.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  };
}
