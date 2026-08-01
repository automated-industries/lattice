/**
 * CLI arg parsing tests.
 *
 * These tests exercise parseArgs() logic in isolation — they do NOT touch the
 * filesystem, database, or perform full integration renders.
 *
 * We test the exported/testable surface by calling the module in a way that
 * lets us inspect parsed args. Since parseArgs() is internal, we test via the
 * observable effects: help text output and command recognition.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers — run the CLI logic without spawning a subprocess
// We directly import the module internals by reconstructing the parseArgs logic
// since it is not exported. We test the behavior by checking what main() does
// with controlled inputs (via mocking process.argv and console).
// ---------------------------------------------------------------------------

// We can't easily import parseArgs directly since it's not exported.
// Instead we test the CLI at the integration boundary — checking that:
// 1. Help text includes all required commands
// 2. Arg parsing tests are done via the code paths we can observe
//
// For arg parsing correctness, we replicate the parseArgs logic in the tests
// and verify the expected contract.

function parseArgs(argv: string[]): {
  command?: string;
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
  port: number;
  noOpen: boolean;
  autoUpdate: boolean;
} {
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
  let port = 4317;
  let noOpen = false;
  let autoUpdate = true;

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
    } else if (arg === '--port' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '4317', 10);
      if (!isNaN(parsed)) port = parsed;
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--no-auto-update') {
      autoUpdate = false;
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
    port,
    noOpen,
    autoUpdate: autoUpdate && process.env.LATTICE_NO_AUTO_UPDATE !== '1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseArgs() — command detection', () => {
  it('detects generate command', () => {
    const args = parseArgs(['generate', '--config', './my.yml']);
    expect(args.command).toBe('generate');
  });

  it('detects render command', () => {
    const args = parseArgs(['render']);
    expect(args.command).toBe('render');
  });

  it('detects reconcile command', () => {
    const args = parseArgs(['reconcile']);
    expect(args.command).toBe('reconcile');
  });

  it('detects status command', () => {
    const args = parseArgs(['status']);
    expect(args.command).toBe('status');
  });

  it('detects gui command', () => {
    const args = parseArgs(['gui']);
    expect(args.command).toBe('gui');
  });

  it('sets command to undefined when only flags are given', () => {
    const args = parseArgs(['--help']);
    expect(args.command).toBeUndefined();
    expect(args.help).toBe(true);
  });
});

describe('parseArgs() — gui command', () => {
  it('uses gui defaults', () => {
    const args = parseArgs(['gui']);
    expect(args.config).toBe('./lattice.config.yml');
    expect(args.output).toBe('./context');
    expect(args.port).toBe(4317);
    expect(args.noOpen).toBe(false);
  });

  it('parses gui options', () => {
    const args = parseArgs([
      'gui',
      '--config',
      './custom.yml',
      '--output',
      './ctx',
      '--port',
      '4321',
      '--no-open',
    ]);
    expect(args.config).toBe('./custom.yml');
    expect(args.output).toBe('./ctx');
    expect(args.port).toBe(4321);
    expect(args.noOpen).toBe(true);
  });
});

describe('parseArgs() — render command', () => {
  it('parses --output flag', () => {
    const args = parseArgs(['render', '--output', './my-context']);
    expect(args.output).toBe('./my-context');
  });

  it('parses --output-dir flag', () => {
    const args = parseArgs(['render', '--output-dir', './out-dir']);
    expect(args.output).toBe('./out-dir');
  });

  it('uses default output ./context when --output not given', () => {
    const args = parseArgs(['render']);
    expect(args.output).toBe('./context');
  });

  it('parses --config flag for render', () => {
    const args = parseArgs(['render', '--config', './custom.yml', '--output', './ctx']);
    expect(args.config).toBe('./custom.yml');
    expect(args.output).toBe('./ctx');
  });
});

describe('parseArgs() — reconcile command', () => {
  it('parses --dry-run flag', () => {
    const args = parseArgs(['reconcile', '--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('--dry-run defaults to false', () => {
    const args = parseArgs(['reconcile']);
    expect(args.dryRun).toBe(false);
  });

  it('parses --no-orphan-dirs flag', () => {
    const args = parseArgs(['reconcile', '--no-orphan-dirs']);
    expect(args.noOrphanDirs).toBe(true);
  });

  it('parses --no-orphan-files flag', () => {
    const args = parseArgs(['reconcile', '--no-orphan-files']);
    expect(args.noOrphanFiles).toBe(true);
  });

  it('parses --protected with comma-separated values', () => {
    const args = parseArgs(['reconcile', '--protected', 'SESSION.md,NOTES.md,RULES.md']);
    expect(args.protected).toEqual(['SESSION.md', 'NOTES.md', 'RULES.md']);
  });

  it('parses --protected with single value', () => {
    const args = parseArgs(['reconcile', '--protected', 'SESSION.md']);
    expect(args.protected).toEqual(['SESSION.md']);
  });

  it('protected defaults to empty array', () => {
    const args = parseArgs(['reconcile']);
    expect(args.protected).toEqual([]);
  });

  it('parses --output for reconcile', () => {
    const args = parseArgs(['reconcile', '--output', './context']);
    expect(args.output).toBe('./context');
  });

  it('parses all reconcile flags together', () => {
    const args = parseArgs([
      'reconcile',
      '--config',
      './lattice.yml',
      '--output',
      './ctx',
      '--dry-run',
      '--no-orphan-dirs',
      '--no-orphan-files',
      '--protected',
      'SESSION.md,NOTES.md',
    ]);
    expect(args.command).toBe('reconcile');
    expect(args.config).toBe('./lattice.yml');
    expect(args.output).toBe('./ctx');
    expect(args.dryRun).toBe(true);
    expect(args.noOrphanDirs).toBe(true);
    expect(args.noOrphanFiles).toBe(true);
    expect(args.protected).toEqual(['SESSION.md', 'NOTES.md']);
  });
});

describe('parseArgs() — generate command (backward compat)', () => {
  it('parses --out flag (not --output)', () => {
    const args = parseArgs(['generate', '--out', './gen']);
    expect(args.out).toBe('./gen');
    // output is separate and should remain at default
    expect(args.output).toBe('./context');
  });

  it('parses --scaffold flag', () => {
    const args = parseArgs(['generate', '--scaffold']);
    expect(args.scaffold).toBe(true);
  });

  it('scaffold defaults to false', () => {
    const args = parseArgs(['generate']);
    expect(args.scaffold).toBe(false);
  });
});

describe('parseArgs() — global flags', () => {
  it('parses --help flag', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });

  it('parses -h flag', () => {
    const args = parseArgs(['-h']);
    expect(args.help).toBe(true);
  });

  it('parses --version flag', () => {
    const args = parseArgs(['--version']);
    expect(args.version).toBe(true);
  });

  it('parses -v flag', () => {
    const args = parseArgs(['-v']);
    expect(args.version).toBe(true);
  });

  it('-c is short for --config', () => {
    const args = parseArgs(['render', '-c', './my.yml']);
    expect(args.config).toBe('./my.yml');
  });

  it('auto-update defaults on', () => {
    // Hermetic: the default must be asserted with the machine's ambient
    // LATTICE_NO_AUTO_UPDATE opt-out cleared, or the test fails on any
    // machine that exports it (the env opt-out has its own test below).
    vi.stubEnv('LATTICE_NO_AUTO_UPDATE', '');
    try {
      const args = parseArgs(['gui']);
      expect(args.autoUpdate).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('LATTICE_NO_AUTO_UPDATE=1 disables auto-update', () => {
    vi.stubEnv('LATTICE_NO_AUTO_UPDATE', '1');
    try {
      const args = parseArgs(['gui']);
      expect(args.autoUpdate).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('--no-auto-update disables auto-update', () => {
    const args = parseArgs(['gui', '--no-auto-update']);
    expect(args.autoUpdate).toBe(false);
  });
});

/**
 * `lattice --help` is the only reference a user has at the terminal, so a flag
 * the parser accepts but the help never names is a capability nobody can find:
 * `search --json` was parsed and honored for three commands while appearing in
 * the help only as part of the `index status` one-liner. These tests read the
 * real source rather than a replica, and check the two directions that matter —
 * every long flag the parser accepts is named somewhere in the help, and the
 * commands that take options have their own section listing them.
 */
describe('help text — every accepted flag is documented', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../../src/cli.ts'), 'utf-8');

  /** The body of a top-level `function <name>` declaration, by brace matching. */
  function functionBody(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  const parser = functionBody('parseArgs');
  const help = functionBody('printHelp');

  // Long flags only: the one-letter aliases are always documented beside the
  // long form they abbreviate, never on their own.
  const accepted = [...new Set([...parser.matchAll(/arg === '(--[a-z0-9-]+)'/g)].map((m) => m[1]))];

  it('finds the flags the parser accepts', () => {
    // Guards the extraction itself — a parser rewrite that breaks the pattern
    // would otherwise make the coverage check below vacuously pass.
    expect(accepted.length).toBeGreaterThan(15);
    expect(accepted).toContain('--json');
  });

  it.each(accepted)('documents %s', (flag) => {
    expect(help).toContain(flag);
  });

  it('gives search its own options section, including --json', () => {
    const section = help.slice(help.indexOf('Options (search)'));
    expect(section).toContain('Options (search)');
    for (const flag of ['--table', '--topk', '--explain', '--json', '--config']) {
      expect(section.slice(0, section.indexOf('Options (', 1))).toContain(flag);
    }
  });

  it('gives doctor its own options section, including --json', () => {
    const section = help.slice(help.indexOf('Options (doctor)'));
    expect(section).toContain('Options (doctor)');
    for (const flag of ['--fix', '--json', '--config']) {
      expect(section.slice(0, section.indexOf('Options (', 1))).toContain(flag);
    }
  });

  it('documents both `workspace create` forms and the name-or-id for `use`', () => {
    expect(help).toContain('create <name>');
    expect(help).toContain('use <name-or-id>');
  });
});

describe('help text', () => {
  it('includes render command', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('render');
  });

  it('includes reconcile command', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('reconcile');
  });

  it('includes status command', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('status');
  });

  it('includes generate command', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('generate');
  });

  it('includes gui command', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('gui');
  });

  it('includes --output flag documentation', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('--output');
  });

  it('includes --dry-run flag documentation', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('--dry-run');
  });

  it('includes --no-auto-update flag documentation', () => {
    const cliPath = resolve(import.meta.dirname, '../../src/cli.ts');
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('--no-auto-update');
  });
});
