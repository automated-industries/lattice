import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse } from 'yaml';
import type { LatticeConfig } from './config/types.js';
import { generateAll } from './codegen/generate.js';
import { parseConfigFile } from './config/parser.js';
import { Lattice } from './lattice.js';
import { checkForUpdate } from './update-check.js';
import { startGuiServer } from './gui/server.js';
import { discoverOutputDir } from './gui/discover-output-dir.js';
import { runTeamsCommand } from './teams/cli-commands.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string | undefined;
  subcommand?: string | undefined;
  /** Third positional for two-level subcommands, e.g. `teams dlq list`. */
  action?: string | undefined;
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
  teamCloud: boolean;
  // Teams subcommand options (parsed only when command === 'teams')
  cloud?: string | undefined;
  token?: string | undefined;
  email?: string | undefined;
  inviteeEmail?: string | undefined;
  /** --name <display> — user display name (register / join). */
  displayName?: string | undefined;
  /** --team-name <name> — the team being created (register). */
  teamName?: string | undefined;
  team?: string | undefined;
  teamId?: string | undefined;
  expires?: number | undefined;
  userId?: string | undefined;
  table?: string | undefined;
  pk?: string | undefined;
  /** --id <uuid> — a specific DLQ entry (teams dlq retry / purge). */
  id?: string | undefined;
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
  let teamCloud = false;
  let subcommand: string | undefined;
  let cloud: string | undefined;
  let token: string | undefined;
  let email: string | undefined;
  let inviteeEmail: string | undefined;
  let displayName: string | undefined;
  let teamName: string | undefined;
  let team: string | undefined;
  let teamId: string | undefined;
  let expires: number | undefined;
  let userId: string | undefined;
  let table: string | undefined;
  let pk: string | undefined;
  let id: string | undefined;

  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
    // `lattice teams <subcommand>` — pick up the second positional.
    if (command === 'teams' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      // `lattice teams <subcommand> <action>` — third positional for
      // two-level subcommands like `teams dlq list|retry|purge`.
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
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
    } else if (arg === '--team-cloud') {
      teamCloud = true;
    } else if (arg === '--cloud' && i + 1 < argv.length) {
      i++;
      cloud = argv[i];
    } else if (arg === '--token' && i + 1 < argv.length) {
      i++;
      token = argv[i];
    } else if (arg === '--email' && i + 1 < argv.length) {
      i++;
      email = argv[i];
    } else if (arg === '--invitee-email' && i + 1 < argv.length) {
      i++;
      inviteeEmail = argv[i];
    } else if (arg === '--name' && i + 1 < argv.length) {
      i++;
      displayName = argv[i];
    } else if (arg === '--team-name' && i + 1 < argv.length) {
      i++;
      teamName = argv[i];
    } else if (arg === '--team' && i + 1 < argv.length) {
      i++;
      team = argv[i];
    } else if (arg === '--team-id' && i + 1 < argv.length) {
      i++;
      teamId = argv[i];
    } else if (arg === '--expires' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '', 10);
      if (!isNaN(parsed)) expires = parsed;
    } else if (arg === '--user-id' && i + 1 < argv.length) {
      i++;
      userId = argv[i];
    } else if (arg === '--table' && i + 1 < argv.length) {
      i++;
      table = argv[i];
    } else if (arg === '--pk' && i + 1 < argv.length) {
      i++;
      pk = argv[i];
    } else if (arg === '--id' && i + 1 < argv.length) {
      i++;
      id = argv[i];
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
    teamCloud,
    cloud,
    token,
    email,
    inviteeEmail,
    displayName,
    teamName,
    team,
    teamId,
    expires,
    userId,
    table,
    pk,
    id,
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
      '  generate    Generate TypeScript types, SQL migration, and scaffold files',
      '  render      One-shot context generation (writes entity context directories)',
      '  reconcile   Render + cleanup orphaned entity directories and files',
      '  status      Dry-run reconcile — show what would change without writing',
      '  watch       Poll for changes and re-render on each cycle',
      '  gui         Start a local browser GUI for exploring Lattice context',
      '  serve       Start a server-mode lattice (use --team-cloud for Lattice Teams)',
      '  teams       Manage Lattice Teams (run `lattice teams help` for subcommands)',
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
      'Options (serve):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --host <addr>          Bind address (default: 127.0.0.1; use 0.0.0.0 to expose)',
      '  --port <number>        Port (default: 4317; auto-increments if busy)',
      '  --team-cloud           Enable Lattice Teams cloud mode (bearer auth required)',
      '',
      'Options (global):',
      '  --help, -h             Show this help message',
      '  --version, -v          Print the version number',
    ].join('\n'),
  );
}

function getVersion(): string {
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
    execSync('npm install -g latticesql@latest', { stdio: 'inherit' });
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

  let parsed;
  try {
    parsed = parseConfigFile(resolve(args.config));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  const db = new Lattice({ config: resolve(args.config) });

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

  // Suppress unused variable warning
  void parsed;
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
  try {
    const resolvedOutput = discoverOutputDir(args.output, args.outputExplicit);
    if (!args.outputExplicit && resolvedOutput !== args.output) {
      console.log(
        `Lattice GUI: auto-detected rendered context at "${resolvedOutput}" ` +
          `(use --output to override).`,
      );
    }
    const handle = await startGuiServer({
      configPath: resolve(args.config),
      outputDir: resolve(resolvedOutput),
      port: args.port,
      openBrowser: !args.noOpen,
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

async function runServe(args: ParsedArgs): Promise<void> {
  try {
    const handle = await startGuiServer({
      configPath: resolve(args.config),
      outputDir: resolve(args.output),
      host: args.host,
      port: args.port,
      openBrowser: false,
      teamCloud: args.teamCloud,
    });
    const label = args.teamCloud ? 'Lattice team cloud' : 'Lattice server';
    console.log(`${label} listening on ${args.host}:${String(handle.port)} (${handle.url})`);
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
    case 'serve':
      void runServe(args);
      break;
    case 'teams':
      void runTeamsCommand({
        subcommand: args.subcommand,
        action: args.action,
        config: args.config,
        cloud: args.cloud,
        token: args.token,
        email: args.email,
        inviteeEmail: args.inviteeEmail,
        name: args.displayName,
        teamName: args.teamName,
        team: args.team,
        teamId: args.teamId,
        expires: args.expires,
        userId: args.userId,
        table: args.table,
        pk: args.pk,
        id: args.id,
      });
      break;
    case 'update':
      void runUpdate();
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
