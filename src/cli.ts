import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse } from 'yaml';
import type { LatticeConfig } from './config/types.js';
import { generateAll } from './codegen/generate.js';
import { parseConfigFile } from './config/parser.js';
import { Lattice } from './lattice.js';
import { checkForUpdate } from './update-check.js';
import { detectInstallContext } from './update-context.js';
import { startGuiServer, openUrl } from './gui/server.js';
import { probeRunningGui } from './gui/probe-running.js';
import { superviseGui } from './gui/supervisor.js';
import { ensureRootForGui } from './framework/gui-bootstrap.js';
import { ensureLatticeRoot, findLatticeRoot, rootConfigDir } from './framework/lattice-root.js';
import {
  addWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
  setActiveWorkspace,
} from './framework/workspace.js';
import { importLegacyUserConfig } from './framework/migrate-to-root.js';
import { analyticsEnabled, getOrCreateMasterKey } from './framework/user-config.js';
import { hydrateMemberConfigFromCloud } from './cloud/shared-schema.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string | undefined;
  subcommand?: string | undefined;
  /** Third positional for two-level subcommands, e.g. `workspace use <id>`. */
  action?: string | undefined;
  /** --root <dir> — the `.lattice` root for `init` / `workspace` commands. */
  root?: string | undefined;
  config: string;
  out: string;
  output: string;
  /**
   * `true` when the user explicitly passed `--output` / `--output-dir`.
   * The GUI command uses this to decide whether to auto-discover an
   * existing render dir (default behaviour) or trust the user's value
   * (when explicit).
   */
  outputExplicit: boolean;
  scaffold: boolean;
  help: boolean;
  version: boolean;
  dryRun: boolean;
  noOrphanDirs: boolean;
  noOrphanFiles: boolean;
  protected: string[];
  interval: number;
  cleanup: boolean;
  port: number;
  noOpen: boolean;
  host: string;
  /** --name <display> — workspace / user display name (workspace create, gui). */
  displayName?: string | undefined;
  /** --json — emit machine-readable JSON instead of formatted text (doctor). */
  json: boolean;
  /** Positional query text for `search`. */
  query?: string | undefined;
  /** --table <t> — target table for `search`. */
  table?: string | undefined;
  /** --topk <n> — result count for `search`. */
  topK?: number | undefined;
  /** --explain — print the hybrid-search score breakdown (`search`). */
  explain: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let action: string | undefined;
  let config = './lattice.config.yml';
  let out = './generated';
  let output = './context';
  let outputExplicit = false;
  let scaffold = false;
  let help = false;
  let version = false;
  let dryRun = false;
  let noOrphanDirs = false;
  let noOrphanFiles = false;
  const protectedFiles: string[] = [];
  let interval = 5000;
  let cleanup = false;
  let port = 4317;
  let noOpen = false;
  let host = '127.0.0.1';
  let subcommand: string | undefined;
  let displayName: string | undefined;
  let root: string | undefined;
  let json = false;
  let query: string | undefined;
  let table: string | undefined;
  let topK: number | undefined;
  let explain = false;

  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
    // `lattice workspace <subcommand>` — pick up the second positional.
    if (command === 'workspace' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      // `lattice workspace <subcommand> <action>` — third positional for
      // two-level subcommands like `workspace use <id>`.
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice search <query>` — the next positional is the query text.
    if (command === 'search' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      query = argv[1];
      i = 2;
    }
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if ((arg === '--config' || arg === '-c') && i + 1 < argv.length) {
      i++;
      config = argv[i] ?? config;
    } else if ((arg === '--out' || arg === '-o') && i + 1 < argv.length) {
      i++;
      out = argv[i] ?? out;
    } else if ((arg === '--output' || arg === '--output-dir') && i + 1 < argv.length) {
      i++;
      output = argv[i] ?? output;
      outputExplicit = true;
    } else if (arg === '--scaffold') {
      scaffold = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-orphan-dirs') {
      noOrphanDirs = true;
    } else if (arg === '--no-orphan-files') {
      noOrphanFiles = true;
    } else if (arg === '--protected' && i + 1 < argv.length) {
      i++;
      const csv = argv[i] ?? '';
      protectedFiles.push(...csv.split(',').filter(Boolean));
    } else if (arg === '--interval' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '5000', 10);
      if (!isNaN(parsed)) interval = parsed;
    } else if (arg === '--cleanup') {
      cleanup = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '4317', 10);
      if (!isNaN(parsed)) port = parsed;
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--host' && i + 1 < argv.length) {
      i++;
      host = argv[i] ?? host;
    } else if (arg === '--name' && i + 1 < argv.length) {
      i++;
      displayName = argv[i];
    } else if (arg === '--root' && i + 1 < argv.length) {
      i++;
      root = argv[i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--explain') {
      explain = true;
    } else if (arg === '--table' && i + 1 < argv.length) {
      i++;
      table = argv[i];
    } else if (arg === '--topk' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '10', 10);
      if (!isNaN(parsed)) topK = parsed;
    }
    i++;
  }

  return {
    command,
    subcommand,
    action,
    config,
    out,
    output,
    outputExplicit,
    scaffold,
    help,
    version,
    dryRun,
    noOrphanDirs,
    noOrphanFiles,
    protected: protectedFiles,
    interval,
    cleanup,
    port,
    noOpen,
    host,
    displayName,
    root,
    json,
    query,
    table,
    topK,
    explain,
  };
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    [
      'lattice — latticesql CLI',
      '',
      'Usage:',
      '  lattice <command> [options]',
      '',
      'Commands:',
      '  init        Create a .lattice root + a default workspace (auto-renders context)',
      '  workspace   Manage workspaces (list | create --name <n> | use <id>)',
      '  generate    Generate TypeScript types, SQL migration, and scaffold files',
      '  render      One-shot context generation (writes entity context directories)',
      '  reconcile   Render + cleanup orphaned entity directories and files',
      '  status      Dry-run reconcile — show what would change without writing',
      '  watch       Poll for changes and re-render on each cycle',
      '  gui         Start a local browser GUI for exploring Lattice context',
      '  doctor      Report retrieval health (FTS/embedding coverage, extensions)',
      '  search      Hybrid search a table (--table <t> [--explain] [--topk N])',
      '  update      Upgrade latticesql to the latest version',
      '',
      'Options (generate):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --out, -o <dir>        Output directory for generated files (default: ./generated)',
      '  --scaffold             Also create empty scaffold render output files',
      '',
      'Options (render):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '',
      'Options (reconcile):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --dry-run              Report orphans but do not delete anything',
      '  --no-orphan-dirs       Skip removal of orphaned entity directories',
      '  --no-orphan-files      Skip removal of orphaned files inside entity dirs',
      '  --protected <csv>      Comma-separated list of protected filenames',
      '',
      'Options (status):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '',
      'Options (watch):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --interval <ms>        Poll interval in milliseconds (default: 5000)',
      '  --cleanup              Enable orphan cleanup after each render cycle',
      '  --no-orphan-dirs       Skip removal of orphaned entity directories (with --cleanup)',
      '  --no-orphan-files      Skip removal of orphaned files inside entity dirs (with --cleanup)',
      '  --protected <csv>      Comma-separated list of protected filenames (with --cleanup)',
      '',
      'Options (gui):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --port <number>        Localhost port (default: 4317; auto-increments if busy)',
      '  --no-open              Do not open the browser automatically',
      '',
      'Options (init / workspace):',
      '  --root <dir>           The .lattice root location (default: discovered or ./.lattice)',
      '  --name <display>       Workspace display name (init default workspace / workspace create)',
      '',
      'Options (global):',
      '  --help, -h             Show this help message',
      '  --version, -v          Print the version number',
    ].join('\n'),
  );
}

// Injected by tsup's `define` at build time (see tsup.config.ts). Undefined when
// running unbundled from source (dev / tsx), where the package.json read below
// works because import.meta.url points into src/.
declare const __LATTICE_VERSION__: string | undefined;

function getVersion(): string {
  // Build-time constant — reliable in the bundled/published CLI + GUI, where the
  // runtime package.json read fails (the bundle runs from node_modules). This is
  // the fix for the "vunknown" version chip in published builds.
  if (typeof __LATTICE_VERSION__ === 'string') return __LATTICE_VERSION__;
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function printVersion(): void {
  console.log(getVersion());
}

async function runUpdate(): Promise<void> {
  const currentVersion = getVersion();
  console.log(`Current version: ${currentVersion}`);

  const latest = await checkForUpdate('latticesql', currentVersion);
  if (!latest) {
    console.log('Already up to date.');
    return;
  }

  console.log(`Updating to ${latest}...`);
  try {
    execSync('npm install -g latticesql@latest', {
      stdio: 'inherit',
      // Honor the analytics opt-out on the reinstall (suppresses the Scarf ping).
      env: analyticsEnabled() ? process.env : { ...process.env, SCARF_ANALYTICS: 'false' },
    });
    console.log(`Updated latticesql ${currentVersion} → ${latest}`);
  } catch {
    console.error('Update failed. Try running manually: npm install -g latticesql@latest');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runGenerate(args: ParsedArgs): void {
  const configPath = resolve(args.config);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    console.error(`Error: cannot read config file at "${configPath}"`);
    process.exit(1);
  }

  let config: LatticeConfig;
  try {
    config = parse(raw) as LatticeConfig;
  } catch (e) {
    console.error(`Error: YAML parse error in "${configPath}": ${(e as Error).message}`);
    process.exit(1);
  }

  if (!(config as { entities?: unknown }).entities) {
    console.error('Error: config must have an "entities" key');
    process.exit(1);
  }

  const configDir = dirname(configPath);
  const outDir = resolve(args.out);

  try {
    const result = generateAll({ config, configDir, outDir, scaffold: args.scaffold });
    console.log(`Generated ${String(result.filesWritten.length)} file(s):`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function runRender(args: ParsedArgs): Promise<void> {
  const outputDir = resolve(args.output);
  const configPath = resolve(args.config);

  let parsed;
  try {
    parsed = parseConfigFile(configPath);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  // Native entities (`secrets`, `files`) carry encrypted columns, so a render that
  // touches them needs the master key — resolve it once (env var or
  // `~/.lattice/master.key`), the same source the GUI uses.
  const encryptionKey = getOrCreateMasterKey();
  // Cloud member: a scoped member's local config has no entities, so its render
  // would produce an empty context tree. Hydrate the owner-published entity/render
  // layout from the cloud BEFORE constructing the Lattice, keeping the member's own
  // `db:` credential. No-op for a non-postgres config or when nothing was published.
  await hydrateMemberConfigFromCloud(configPath, parsed.dbPath, encryptionKey);

  const db = new Lattice({ config: configPath }, { encryptionKey });

  try {
    await db.init();
    const start = Date.now();
    const result = await db.render(outputDir);
    const durationMs = Date.now() - start;

    console.log(`Rendered ${String(result.filesWritten.length)} files in ${String(durationMs)}ms`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  const db = new Lattice({ config: resolve(args.config) });
  try {
    await db.init();
    const report = await db.diagnoseRetrieval();
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const { formatHealthReport } = await import('./search/doctor.js');
      console.log(formatHealthReport(report));
    }
    // Exit non-zero when an error-severity issue exists, so `lattice doctor` can
    // gate CI / a deploy on retrieval health.
    if (!report.healthy) process.exitCode = 1;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function runSearch(args: ParsedArgs): Promise<void> {
  if (!args.query) {
    console.error('Usage: lattice search "<query>" --table <table> [--explain] [--topk N]');
    process.exit(1);
  }
  if (!args.table) {
    console.error('Error: --table <table> is required for search');
    process.exit(1);
  }
  const db = new Lattice({ config: resolve(args.config) });
  try {
    await db.init();
    const results = await db.hybridSearch(args.table, args.query, { topK: args.topK ?? 10 });
    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('No matches.');
      return;
    }
    for (const r of results) {
      const id =
        typeof r.row.id === 'string' || typeof r.row.id === 'number' ? String(r.row.id) : '(no id)';
      console.log(`${r.score.toFixed(4)}  ${id}`);
      if (args.explain) {
        const e = r.explain;
        const v =
          e.vectorRank === null
            ? '—'
            : `#${String(e.vectorRank)} (${(e.vectorScore ?? 0).toFixed(3)})`;
        const f =
          e.ftsRank === null ? '—' : `#${String(e.ftsRank)} (${(e.ftsScore ?? 0).toFixed(3)})`;
        console.log(
          `      vector ${v} | fts ${f} | rrf ${e.rrf.toFixed(5)} | boost ${e.rankingBoost.toFixed(3)}` +
            (e.rerankerScore !== undefined ? ` | rerank ${e.rerankerScore.toFixed(3)}` : ''),
        );
      }
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

async function runReconcile(args: ParsedArgs, isDryRun: boolean): Promise<void> {
  const outputDir = resolve(args.output);

  const db = new Lattice({ config: resolve(args.config) });

  try {
    await db.init();
    const start = Date.now();
    const reconcileOpts: import('./types.js').ReconcileOptions = {
      dryRun: isDryRun,
      removeOrphanedDirectories: !args.noOrphanDirs,
      removeOrphanedFiles: !args.noOrphanFiles,
    };
    if (args.protected.length > 0) {
      reconcileOpts.protectedFiles = args.protected;
    }
    const result = await db.reconcile(outputDir, reconcileOpts);
    const durationMs = Date.now() - start;

    if (isDryRun) {
      console.log('DRY RUN — no changes made');
    }

    console.log(`Rendered ${String(result.filesWritten.length)} files in ${String(durationMs)}ms`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }

    const { cleanup } = result;
    const totalRemoved = cleanup.directoriesRemoved.length + cleanup.filesRemoved.length;
    if (totalRemoved > 0 || cleanup.directoriesSkipped.length > 0) {
      console.log(
        `Cleanup: removed ${String(cleanup.directoriesRemoved.length)} directories, ${String(cleanup.filesRemoved.length)} files`,
      );
      for (const d of cleanup.directoriesRemoved) {
        console.log(`  ✓ Removed ${d}`);
      }
      for (const f of cleanup.filesRemoved) {
        console.log(`  ✓ Removed ${f}`);
      }
      for (const d of cleanup.directoriesSkipped) {
        console.log(`  ✗ Left ${d} (protected files remain)`);
      }
    }

    if (cleanup.warnings.length > 0) {
      console.log(`Warnings: ${String(cleanup.warnings.length)}`);
      for (const w of cleanup.warnings) {
        console.warn(`  ! ${w}`);
      }
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

function formatTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function runWatch(args: ParsedArgs): Promise<void> {
  const outputDir = resolve(args.output);

  const db = new Lattice({ config: resolve(args.config) });

  try {
    await db.init();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  const cleanupOpts: import('./types.js').CleanupOptions | undefined = args.cleanup
    ? {
        removeOrphanedDirectories: !args.noOrphanDirs,
        removeOrphanedFiles: !args.noOrphanFiles,
        ...(args.protected.length > 0 ? { protectedFiles: args.protected } : {}),
      }
    : undefined;

  const stop = await db.watch(outputDir, {
    interval: args.interval,
    onRender: (result) => {
      console.log(
        `[${formatTimestamp()}] Rendered ${String(result.filesWritten.length)} files in ${String(result.durationMs)}ms`,
      );
    },
    onError: (err) => {
      console.error(`[${formatTimestamp()}] Error: ${err.message}`);
    },
    ...(cleanupOpts !== undefined ? { cleanup: cleanupOpts } : {}),
    ...(cleanupOpts !== undefined
      ? {
          onCleanup: (result) => {
            console.log(
              `[${formatTimestamp()}] Cleanup: removed ${String(result.directoriesRemoved.length)} dirs, ${String(result.filesRemoved.length)} files`,
            );
          },
        }
      : {}),
  });

  const shutdown = (): void => {
    stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runGui(args: ParsedArgs): Promise<void> {
  const port = args.port;
  // Singleton: never start a SECOND Lattice GUI when one is already serving this
  // port. The server's port-fallback (bind the next free port if the requested one
  // is busy) would otherwise run a DUPLICATE instance — its own browser tab, its
  // own background auto-update supervisor. Repeated launches (the installer,
  // double-clicking the app, dev testing) then pile up instances + tabs at drifting
  // versions, which is what crashes the browser. If a Lattice GUI is already up on
  // this port, just open it and exit. The supervised child (LATTICE_GUI_SUPERVISED)
  // is spawned precisely to bind the port, and the supervisor frees the port before
  // an in-place update restart — so the child must skip this check.
  if (!process.env.LATTICE_GUI_SUPERVISED) {
    const running = await probeRunningGui(port);
    if (running) {
      const url = `http://127.0.0.1:${String(port)}/`;
      console.log(
        `Lattice is already running at ${url}${running.version ? ` (v${running.version})` : ''} — opening it.`,
      );
      if (!args.noOpen) openUrl(url);
      return;
    }
  }
  // A fresh, installable invocation becomes the supervisor: it silently installs
  // the latest version and respawns the server on a background update, so the GUI
  // self-updates with no manual refresh. The supervised child (and any
  // non-installable context — dev checkout, npx) falls through to run the server
  // directly. `LATTICE_GUI_SUPERVISED` prevents infinite re-supervision.
  if (!process.env.LATTICE_GUI_SUPERVISED && detectInstallContext().installable) {
    try {
      await superviseGui({
        cliPath: process.argv[1] ?? '',
        childArgs: process.argv.slice(2),
        currentVersion: getVersion(),
      });
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  try {
    // The `.lattice`/workspace model is universal for the GUI: ensure a root
    // exists, adopt the opened config as a workspace, and reconcile any stray
    // (e.g. previously-joined) sibling configs so every database shows up as a
    // single switchable workspace. There is no "database mode" fallback — that
    // duality was the source of the inconsistent header/settings lists.
    if (args.root) process.env.LATTICE_ROOT = args.root;
    const boot = ensureRootForGui({
      startDir: args.root ?? process.cwd(),
      configPath: resolve(args.config),
      explicitConfig: args.config !== './lattice.config.yml',
    });
    console.log(
      boot.workspaceId
        ? `Lattice GUI: opening workspace "${boot.displayName}".`
        : 'Lattice GUI: no workspace yet — opening the welcome screen.',
    );
    const handle = await startGuiServer({
      configPath: boot.configPath,
      outputDir: boot.contextDir,
      latticeRoot: boot.root,
      port,
      openBrowser: !args.noOpen,
      autoRender: true,
      version: getVersion(),
      // Only a supervised child polls + relaunches: exiting to apply an update is
      // safe solely when the supervisor is there to respawn it.
      selfUpdate: process.env.LATTICE_GUI_SUPERVISED === '1',
    });
    console.log(`Lattice GUI listening at ${handle.url}`);
    console.log('Press Ctrl+C to stop.');

    const shutdown = (): void => {
      void handle.close().finally(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// init / workspace
// ---------------------------------------------------------------------------

async function runInit(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  const root = ensureLatticeRoot(args.root ?? process.cwd());

  const migrated = importLegacyUserConfig(root);
  if (migrated.migrated) {
    console.log(
      `Imported legacy config (${migrated.copied.join(', ')}) into ${rootConfigDir(root)}`,
    );
  }

  let ws = getActiveWorkspace(root);
  if (!ws) {
    ws = addWorkspace(root, { displayName: args.displayName ?? 'My Workspace' });
    console.log(`Created workspace "${ws.displayName}"`);
  } else {
    console.log(`Using existing workspace "${ws.displayName}"`);
  }

  // Open once to render the initial Context/ tree (no manual `lattice render`).
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  db.close();

  const paths = resolveWorkspacePaths(root, ws);
  console.log(`Lattice root: ${root}`);
  console.log(`Workspace:    ${paths.dir}`);
  console.log(`Context:      ${paths.contextDir}`);
}

async function runWorkspace(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  const root = findLatticeRoot(args.root ?? process.cwd());
  if (!root) {
    console.error('No .lattice root found. Run `lattice init` first.');
    process.exitCode = 1;
    return;
  }

  const sub = args.subcommand ?? 'list';
  switch (sub) {
    case 'list': {
      const all = listWorkspaces(root);
      if (all.length === 0) {
        console.log('No workspaces. Run `lattice workspace create --name <display name>`.');
        return;
      }
      const active = getActiveWorkspace(root);
      for (const w of all) {
        const mark = w.id === active?.id ? '*' : ' ';
        console.log(`${mark} ${w.displayName}  [${w.kind}]  ${w.dir}  ${w.id}`);
      }
      return;
    }
    case 'create': {
      if (!args.displayName) {
        console.error('Usage: lattice workspace create --name <display name>');
        process.exitCode = 1;
        return;
      }
      const ws = addWorkspace(root, { displayName: args.displayName });
      const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
      db.close();
      console.log(`Created workspace "${ws.displayName}" (${ws.dir})`);
      return;
    }
    case 'use': {
      if (!args.action) {
        console.error('Usage: lattice workspace use <id>');
        process.exitCode = 1;
        return;
      }
      setActiveWorkspace(root, args.action);
      console.log(`Active workspace set to ${args.action}`);
      return;
    }
    default:
      console.error(`Unknown workspace subcommand: ${sub}`);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    printVersion();
    return;
  }

  if (args.help || args.command === undefined) {
    printHelp();
    process.exit(args.command === undefined && !args.help ? 1 : 0);
  }

  // Fire-and-forget update check — prints notice on exit
  const version = getVersion();
  if (version !== 'unknown') {
    checkForUpdate('latticesql', version)
      .then((latest) => {
        if (latest) {
          process.on('exit', () => {
            console.log(
              `\nUpdate available: ${version} → ${latest} — run "lattice update" to upgrade`,
            );
          });
        }
      })
      .catch(() => undefined);
  }

  switch (args.command) {
    case 'generate':
      runGenerate(args);
      break;
    case 'render':
      void runRender(args);
      break;
    case 'reconcile':
      void runReconcile(args, args.dryRun);
      break;
    case 'status':
      void runReconcile(args, true);
      break;
    case 'watch':
      void runWatch(args);
      break;
    case 'gui':
      void runGui(args);
      break;
    case 'init':
      void runInit(args);
      break;
    case 'workspace':
      void runWorkspace(args);
      break;
    case 'update':
      void runUpdate();
      break;
    case 'doctor':
      void runDoctor(args);
      break;
    case 'search':
      void runSearch(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
