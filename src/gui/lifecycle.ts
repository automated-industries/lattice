import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { Lattice } from '../lattice.js';
import type { TableDefinition } from '../types.js';
import { parseConfigFile } from '../config/parser.js';
import { upgradeConfigShape } from '../config/config-upgrade.js';
import { upgradeLegacyData } from '../framework/data-upgrade.js';
import { readIdentity, getOrCreateMasterKey, healRawDbUrl } from '../framework/user-config.js';
import { registerNativeEntities, adoptNativeEntities } from '../framework/native-entities.js';
import { deriveCanonicalContexts } from '../framework/canonical-context.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { discoverCloudTables } from '../cloud/discover.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableChatPrivacyRls,
  enableGuiAuditRls,
  ownPolyfillsByGroup,
} from '../cloud/rls.js';
import { publishSharedSchema, hydrateMemberConfigFromCloud } from '../cloud/shared-schema.js';
import { installCloudSettings } from '../cloud/settings.js';
import { reconcileCloudMemberAccess } from '../cloud/setup.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { registerPostgresPolyfills } from '../db/postgres.js';
import { RealtimeBroker } from './realtime.js';
import { FeedBus } from './feed.js';
import { ensureLineageTable } from './lineage-store.js';
import { createFileLoopbackWatcher } from './file-watcher.js';
import { RenderProgressBus } from './render-progress.js';
import type { RenderProgress } from '../render/progress.js';
import { readManifest, writeManifest, manifestPath } from '../lifecycle/manifest.js';
import { isJunctionByColumns, isJunctionTable, tableToSummary } from './data.js';
import { execSql, loadConfigDoc, saveConfigDoc } from './config-io.js';
import { physicalTableExists, physicalColumnExists } from './schema-ops.js';
import { columnDescriptionHook, tableDescriptionHook } from './meta-gen.js';
import type { AuditEntry } from './mutations.js';
import { retireLegacyPreferenceSecrets } from './assistant-routes.js';
import type { ActiveDb } from './active-db.js';
import { isFeedHiddenTable } from './active-db.js';

/**
 * Workspace lifecycle: open / reopen / dispose a workspace's ActiveDb, the
 * background-render kickoff, the schema-config (undo/redo) reopen, and the
 * timeout-bounded open/teardown helpers. Extracted from server.ts; imports only
 * config/data/framework leaves (never a route module), so it stays out of the
 * GUI import cycle. server.ts re-exports openConfig / disposeActive /
 * openWithinTimeout for external (test) callers.
 */

// Exported for tests: builds a fully-wired ActiveDb from a config on disk so
// the no-reopen schema primitives (e.g. the assistant's table delete) can be
// exercised directly without standing up the whole HTTP server.
export async function openConfig(
  configPath: string,
  outputDir: string,
  autoRender = false,
  realtimeWatchdogMs?: number,
  // Bound on the realtime-broker connect (the only unbounded awaited Postgres op
  // after the instant-construct phase). Defaults to the outer switch cap so the
  // inner bound can never silently drift below it; injectable for tests. The
  // default is read at call time, after module init, so referencing the
  // later-declared SWITCH_OPEN_TIMEOUT_MS here is safe.
  brokerConnectTimeoutMs: number = SWITCH_OPEN_TIMEOUT_MS,
): Promise<ActiveDb> {
  // Heal a legacy config that still stores a RAW postgres:// URL (password in
  // cleartext on disk): move it into the encrypted credential store and rewrite
  // the db: line to a ${LATTICE_DB:label} reference. Idempotent + a no-op for
  // already-referenced / SQLite configs. Done BEFORE parsing so the parse resolves
  // the new reference. parsed.dbPath is the same URL either way, so the open is
  // unaffected — only the at-rest secret is removed.
  healRawDbUrl(configPath);
  // Silently migrate a 3.x config shape forward on disk (e.g. the per-field `ref:`
  // shorthand → an explicit `relations:` block), preserving comments. The parser
  // also tolerates the old shape, so the open does not depend on this — a rewrite
  // failure is surfaced (not swallowed) but never aborts the open.
  try {
    upgradeConfigShape(configPath);
  } catch (e) {
    console.warn(
      `[openConfig] config shape migrate-forward failed (open continues — parser still accepts the old shape): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
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
  // into the Lattice options so the encryption-key validation is happy
  // at init() time.
  const encryptionKey = getOrCreateMasterKey();
  // Cloud member: if this scoped member's local config has no entities, hydrate the
  // owner-published entity/render layout from the cloud BEFORE constructing the Lattice,
  // so both the CLI and GUI render the full context tree. Best-effort — falls back to
  // catalog synthesis below if nothing was published. (Needs the encryption key to open
  // a short-lived peek connection.)
  if (/^postgres(ql)?:\/\//i.test(parsed.dbPath)) {
    await hydrateMemberConfigFromCloud(configPath, parsed.dbPath, encryptionKey);
  }
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
      // Who/what triggered the mutation (gui|command|ai|ingest|cli|system|
      // file-edit). Nullable + additive — added idempotently by the schema
      // reconcile. Persisted from MutationCtx.source (previously recorded only
      // on the live feed event); powers the provenance "observation" tier
      // (rows last touched by the `ai` actor).
      source: 'TEXT',
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

  // Provenance lineage substrate — an unregistered __lattice_ bookkeeping table
  // (raw DDL, like __lattice_connectors) so the renderer never scans it.
  // Owner-only: a scoped cloud member has no DDL grant. Idempotent.
  if (!memberOpen) await ensureLineageTable(db.adapter);

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

  // Inline owner-data migration — SKIP on a cloud MEMBER open (a scoped member has
  // no DDL/write grant; the bootstrap REVOKEs CREATE from PUBLIC). KEPT INLINE (not
  // backgrounded with the rest of the convergence) because the OWNER reads this data
  // the instant the switch returns: a legacy `deleted_at=''` row would otherwise read
  // as deleted — and dup on a natural-key upsert — until it ran. It is once-per-DB
  // sentinel-gated, so steady-state cost is ~one round-trip.
  if (!memberOpen) {
    await upgradeLegacyData(db);
  }

  // Tables the owner-side converge couldn't manage (e.g. owned by a different
  // Postgres role), surfaced via /api/dbconfig. Populated ASYNCHRONOUSLY by
  // convergeOwnerCloud (kicked after the ActiveDb is built) and mutated IN PLACE,
  // so the live ActiveDb reflects warnings as they land (eventually-consistent).
  const convergeWarnings: { table: string; reason: string }[] = [];

  // Cloud MEMBER open with no entity layout: the owner hasn't published one yet
  // (hydrateMemberConfigFromCloud above found nothing, and the catalog synthesis
  // discovered no user tables either). Surface a clear, actionable message rather
  // than silently rendering zero context files.
  if (memberOpen) {
    const userTables = db
      .getRegisteredTableNames()
      .filter((t) => !t.startsWith('_') && !discoveredJunctions.has(t));
    if (userTables.length === 0) {
      convergeWarnings.push({
        table: '(schema)',
        reason:
          'No entity layout is configured for this cloud workspace yet — ask the cloud owner to open the workspace once so it publishes the schema, then reopen. Until then, render produces no context files.',
      });
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
  // Derive junctions from the ALREADY-parsed config tables (reusing the exact
  // isJunctionTable predicate via tableToSummary) instead of getGuiEntities →
  // loadGuiData, which re-parses the whole config YAML AND disk-scans the rendered
  // tree (existsSync/readFileSync per entity) — pure waste on the open hot path,
  // O(entities) on a big cloud. The predicate (which has a client mirror that must
  // stay in lockstep) is reused verbatim, not reimplemented.
  const junctionTables = new Set([
    ...parsed.tables
      .filter((t) => isJunctionTable(tableToSummary(t.name, t.definition)))
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
      const broker = new RealtimeBroker(
        parsed.dbPath,
        realtimeWatchdogMs !== undefined ? { watchdogIntervalMs: realtimeWatchdogMs } : {},
      );
      // start() (client.connect + LISTEN) has no connectionTimeoutMillis, so a
      // degraded Postgres that accepts the TCP connection but never completes the
      // startup handshake can hang it forever — wedging EVERY open path (boot,
      // switch, create, reopen), most of which the outer openWithinTimeout does not
      // cover. Bound it like disposeActive bounds stop().
      realtime = await startBrokerWithinTimeout(broker, brokerConnectTimeoutMs);
    } catch (e) {
      // A connect HANG is surfaced loudly (no silent hang / local-mode fallback);
      // a genuine connect rejection keeps its existing swallow-to-local-mode path.
      if (e instanceof BrokerConnectTimeoutError) throw e;
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

  const active: ActiveDb = {
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
    converged: Promise.resolve(),
    dbPath: parsed.dbPath,
    autoRender,
    renderProgress: new RenderProgressBus(),
    renderAbort: new AbortController(),
    renderState: { phase: 'idle', tables: {} },
    maskedReadViews,
    onColumnsAdded: columnDescriptionHook(db),
    generateTableDescription: tableDescriptionHook(db),
  };

  // Owner-side convergence (native-entity adopt + the cloud RLS/grant/settings/
  // publish bootstrap) runs in the BACKGROUND, off the switch's critical path:
  // openConfig must return a usable ActiveDb instantly (it runs before disposeActive
  // on every switch), and the owner is BYPASSRLS so its own reads/writes/render
  // never depend on this work — it converges the cloud FOR members joining later +
  // self-heals objects added in later releases. The promise is exposed as
  // `active.converged` (tests await it; the GUI ignores it) and NEVER rejects —
  // convergeOwnerCloud surfaces any failure into `active.convergeWarnings` + the log.
  // SKIP on a cloud MEMBER open (no DDL/grant rights).
  if (!memberOpen) {
    active.converged = convergeOwnerCloud(active);
  }
  return active;
}

/**
 * Owner-side cloud convergence, run in the background by {@link openConfig}: reconcile
 * native entities, then (Postgres owner) converge the idempotent cloud bootstrap —
 * RLS objects, settings, observation substrate, per-viewer changelog/chat/audit RLS,
 * per-table member grants, and the published shared schema — so objects added in a
 * later release reach already-stamped clouds and a member joining later sees a fully
 * secured + granted cloud. NONE of this gates the OWNER's own usability (BYPASSRLS).
 *
 * Idempotent + fault-isolated. NEVER throws: it is awaited only by tests (via
 * `active.converged`); in the GUI it runs unawaited, so a rejection would be an
 * unhandledRejection. A failure is surfaced LOUDLY but non-fatally — pushed into
 * `active.convergeWarnings` (shown via /api/dbconfig) and logged — and re-runs on the
 * next owner open.
 */
export async function convergeOwnerCloud(active: ActiveDb): Promise<void> {
  const { db, configPath, convergeWarnings } = active;
  // The workspace was torn down (switched away / closed) before this background
  // converge ran or between its phases. disposeActive aborts `renderAbort` BEFORE
  // closing the db, so this signal is the "workspace is going away" cancel: bail
  // quietly — the converge didn't fail, it was cancelled, and re-runs on next open.
  const cancelled = (): boolean => active.renderAbort.signal.aborted;
  try {
    if (cancelled()) return;
    // Reconcile native-entity bindings (files/secrets): merge the native column
    // superset into a pre-existing table non-destructively. db.init already creates
    // the native tables (registered entities), so for a normal cloud this is a no-op
    // reconcile — safe to run after the switch returns.
    await adoptNativeEntities(db);
    // Soft-delete leftover legacy per-workspace preference rows. Idempotent.
    await retireLegacyPreferenceSecrets(db);
    if (cancelled()) return;
    if (db.getDialect() === 'postgres') {
      if ((await cloudRlsInstalled(db)) && (await canManageRoles(db))) {
        await registerPostgresPolyfills((sql) => runAsyncOrSync(db.adapter, sql));
        await installCloudRls(db);
        await ownPolyfillsByGroup(db); // group-own polyfills so any member can upgrade them
        await installCloudSettings(db);
        await db.ensureObservationSubstrate();
        await enableChangelogRls(db); // v3 fail-closed changelog policy
        await enableChatPrivacyRls(db); // per-author RESTRICTIVE lock on chat tables
        await enableGuiAuditRls(db); // row-visibility lock on the GUI audit log
        if (cancelled()) return;
        const access = await reconcileCloudMemberAccess(db);
        for (const s of access.skipped) {
          convergeWarnings.push(s); // mutate IN PLACE — the live ActiveDb sees it
          console.warn(
            `[convergeOwnerCloud] cloud converge could not manage "${s.table}": ${s.reason}`,
          );
        }
        // Republish the owner's entity/render layout so a joined member can hydrate
        // the full context tree from it (members-readable singleton).
        await publishSharedSchema(db, configPath);
      }
    }
  } catch (e) {
    // A db-call rejecting because the workspace was disposed mid-converge is a benign
    // cancel, not a failure — stay quiet (the converge re-runs on the next open).
    if (cancelled()) return;
    // A genuine convergence failure: loud but non-fatal (never silent). The owner can
    // work regardless, and the next open re-runs the idempotent converge. Surface via
    // the warnings array (visible on /api/dbconfig) + the log. Do NOT rethrow — this
    // runs unawaited in the GUI, so a throw would be an unhandledRejection.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[convergeOwnerCloud] owner-side convergence failed:', msg);
    convergeWarnings.push({
      table: '(converge)',
      reason: `Cloud convergence failed (the owner can still work; it retries on the next open): ${msg}`,
    });
  }
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
 * Eager per-viewer freshness: a REMOTE change (another client's write, or the
 * owner re-sharing / un-sharing a row) re-renders this member's RLS-scoped tree
 * so it reflects the new visibility promptly. Wired once per ActiveDb; the broker
 * is stopped in disposeActive.
 *
 * Deliberately NOT gated on "is this change visible to me now": an UN-SHARE makes
 * the row invisible, so a visibility filter would skip the re-render and leave the
 * now-stale row on disk. Re-rendering on every remote change handles share AND
 * un-share; the render reads current RLS state, so it adds/removes rows correctly.
 *
 * Bookkeeping + assistant-chat writes (chat_messages/chat_threads + every
 * `_lattice*` table) are NOT part of the rendered entity tree and are filtered
 * out via isFeedHiddenTable — otherwise every assistant message (each upserts
 * chat_messages → __lattice_changes → NOTIFY) fired a full render, which both
 * wasted egress AND, because the file-loopback watcher defers reverse-sync while a
 * render is in flight, perpetually starved the file→DB writeback.
 *
 * THROTTLED to bound shared-quota egress: a leading+trailing throttle caps it at
 * one re-render per EAGER_RERENDER_MIN_INTERVAL_MS; requestRender debounces +
 * coalesces beneath this. Extracted from startBackgroundRender so the
 * feed-hidden filter is independently unit-testable.
 */
export function wireEagerRerender(active: ActiveDb): void {
  if (active.eagerRenderWired || !active.realtime) return;
  active.eagerRenderWired = true;
  let lastFire = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  // Accumulate the CHANGED tables across the throttle window so the re-render is
  // incremental — only the entity contexts a remote change touched re-render, not
  // the whole tree. A change with no table name forces a full render.
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
    // Skip bookkeeping/chat writes BEFORE touching pendingTables / scheduling
    // fire() — otherwise an empty pendingTables set would itself fall through to a
    // full render in fire(). Mirror the feed's own isFeedHiddenTable filter.
    if (payload.table_name && isFeedHiddenTable(payload.table_name)) return;
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
export function startBackgroundRender(active: ActiveDb): void {
  if (!active.autoRender) return;
  // Begin watching the rendered tree for on-disk edits (idempotent; this is the
  // single "begin serving this workspace" chokepoint). Echo suppression keys off
  // the manifest, so the initial render's own writes are never re-ingested.
  active.fileWatcher?.start();
  // Eager per-viewer freshness — wired once per ActiveDb (see wireEagerRerender,
  // which filters out bookkeeping/chat writes so they never trigger a render).
  wireEagerRerender(active);
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
  //
  // `gateOnOpen`: this is the open/restart render. A plain restart and a version
  // update both land here, and re-rendering an unchanged tree on every one is pure
  // churn (per-table overlays + shared-quota egress for zero file changes). The gate
  // skips the render when the manifest's recorded cursor (read through this open's own
  // scope) shows nothing the tree depends on has advanced; it fails open, and the
  // realtime + mutation render paths (which never set it) are unaffected, so a real
  // cloud change still re-renders promptly.
  void db.renderInBackground(active.outputDir, { signal, onProgress, gateOnOpen: true }).then(
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
 * Thrown by {@link startBrokerWithinTimeout} when a realtime-broker connect exceeds
 * its cap. Distinct from a genuine connect rejection so callers can surface a hang
 * loudly while still degrading gracefully on a real connect failure.
 */
export class BrokerConnectTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Realtime broker connect exceeded ${String(ms)}ms — the database may be slow or unreachable`,
    );
    this.name = 'BrokerConnectTimeoutError';
  }
}

/**
 * Bound a realtime broker's connect (client.connect + LISTEN), which has no
 * connectionTimeoutMillis and can otherwise hang forever on a degraded Postgres.
 * On success returns the started broker; on timeout tears the half-open broker
 * down in the background (best-effort — stop() is itself bounded) and throws
 * {@link BrokerConnectTimeoutError}, so the open path fails fast + loud instead of
 * wedging or silently degrading. A genuine connect rejection propagates unchanged.
 */
export async function startBrokerWithinTimeout(
  broker: RealtimeBroker,
  ms: number,
): Promise<RealtimeBroker> {
  const outcome = await settleWithin(broker.start(), ms);
  if (outcome === 'timeout') {
    void Promise.resolve()
      .then(() => broker.stop())
      .catch(() => undefined);
    throw new BrokerConnectTimeoutError(ms);
  }
  return broker;
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
export const SWITCH_OPEN_TIMEOUT_MS = 20_000;

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
export async function reopenSameConfig(active: ActiveDb, autoRender: boolean): Promise<ActiveDb> {
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
/**
 * add_link / delete_link carry the belongsTo relation alongside the FK field,
 * because a link is the entity-level `relations:` entry (the per-field `ref:`
 * shorthand was removed in 4.0). Both the field and the relation must be added
 * or removed together on revert/redo so a link is never half-present (a field
 * with no relation, or a relation pointing at a missing column).
 */
type LinkPayload = FieldPayload & { relationName?: string; relation?: unknown };
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
export async function applySchemaConfig(
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
  const addRelation = (entity: string, name: string | undefined, rel: unknown): void => {
    if (name === undefined || rel === undefined) return;
    doc.setIn(['entities', entity, 'relations', name], rel);
  };
  const removeRelation = (entity: string, name: string | undefined): void => {
    if (name === undefined) return;
    doc.deleteIn(['entities', entity, 'relations', name]);
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
    case 'schema.add_column': {
      const p = after as unknown as FieldPayload;
      if (inv) removeField(p.entity, p.column);
      else await reAddField(p.entity, p.column, p.fieldDef);
      break;
    }
    case 'schema.add_link': {
      const p = after as unknown as LinkPayload;
      if (inv) {
        removeField(p.entity, p.column);
        removeRelation(p.entity, p.relationName);
      } else {
        await reAddField(p.entity, p.column, p.fieldDef);
        addRelation(p.entity, p.relationName, p.relation);
      }
      break;
    }
    case 'schema.delete_link': {
      const p = before as unknown as LinkPayload;
      if (inv) {
        await reAddField(p.entity, p.column, p.fieldDef);
        addRelation(p.entity, p.relationName, p.relation);
      } else {
        removeField(p.entity, p.column);
        removeRelation(p.entity, p.relationName);
      }
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
