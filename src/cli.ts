import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { LatticeConfig } from './config/types.js';
import { generateAll } from './codegen/generate.js';
import { parseConfigFile } from './config/parser.js';
import { Lattice } from './lattice.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string | undefined;
  config: string;
  out: string;
  output: string;
  scaffold: boolean;
  help: boolean;
  version: boolean;
  dryRun: boolean;
  noOrphanDirs: boolean;
  noOrphanFiles: boolean;
  protected: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let config = './lattice.config.yml';
  let out = './generated';
  let output = './context';
  let scaffold = false;
  let help = false;
  let version = false;
  let dryRun = false;
  let noOrphanDirs = false;
  let noOrphanFiles = false;
  const protectedFiles: string[] = [];

  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
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
    }
    i++;
  }

  return {
    command,
    config,
    out,
    output,
    scaffold,
    help,
    version,
    dryRun,
    noOrphanDirs,
    noOrphanFiles,
    protected: protectedFiles,
  };
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    [
      'lattice — @m-flat/lattice CLI',
      '',
      'Usage:',
      '  lattice <command> [options]',
      '',
      'Commands:',
      '  generate    Generate TypeScript types, SQL migration, and scaffold files',
      '  render      One-shot context generation (writes entity context directories)',
      '  reconcile   Render + cleanup orphaned entity directories and files',
      '  status      Dry-run reconcile — show what would change without writing',
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
      'Options (global):',
      '  --help, -h             Show this help message',
      '  --version, -v          Print the version number',
    ].join('\n'),
  );
}

function printVersion(): void {
  // Replaced at build time by tsup via define or resolved at runtime
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    console.log(pkg.version);
  } catch {
    console.log('unknown');
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
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
