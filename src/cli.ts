import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { LatticeConfig } from './config/types.js';
import { generateAll } from './codegen/generate.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string | undefined;
  config: string;
  out: string;
  scaffold: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let config = './lattice.config.yml';
  let out = './generated';
  let scaffold = false;
  let help = false;
  let version = false;

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
      config = argv[++i]!;
    } else if ((arg === '--out' || arg === '-o') && i + 1 < argv.length) {
      out = argv[++i]!;
    } else if (arg === '--scaffold') {
      scaffold = true;
    }
    i++;
  }

  return { command, config, out, scaffold, help, version };
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
      '  lattice generate [options]',
      '',
      'Commands:',
      '  generate    Generate TypeScript types, SQL migration, and scaffold files',
      '',
      'Options (generate):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --out, -o <dir>        Output directory for generated files (default: ./generated)',
      '  --scaffold             Also create empty scaffold render output files',
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

  if (!config?.entities) {
    console.error('Error: config must have an "entities" key');
    process.exit(1);
  }

  const configDir = dirname(configPath);
  const outDir = resolve(args.out);

  try {
    const result = generateAll({ config, configDir, outDir, scaffold: args.scaffold });
    console.log(`Generated ${result.filesWritten.length} file(s):`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }
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

  switch (args.command) {
    case 'generate':
      runGenerate(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
