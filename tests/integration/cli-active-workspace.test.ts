/**
 * A command typed without `--config` must operate on the workspace this machine
 * is actually using.
 *
 * Making a workspace puts it in a root and makes it the active one. Every command
 * added since then resolves that — an explicit `--config` wins, a config file in
 * the current directory is next, and otherwise the active workspace is the
 * answer. The older read-and-render commands did not: they resolved the literal
 * default `./lattice.config.yml` against wherever you happened to be standing,
 * which exists almost nowhere. So the sequence the product is accepted on — make
 * a workspace, put something in it, check its health — could be run end to end in
 * a test process and still fail on the first command a person types, including
 * inside the workspace directory itself (whose file is not called that either).
 *
 * Every case here runs the REAL command as its own process, from a directory that
 * is not the workspace, and reads the exit code an operator (or a deploy gate)
 * would read. That is the whole point: the resolution being tested is the one
 * that only happens when nobody passed a path, and a test that passes a path
 * cannot see it. The in-process acceptance journey passes an explicit path at
 * every step, which is exactly why this was invisible there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');

let scratch: string;
/** The machine's root — every workspace this file makes lives in it. */
let latticeRoot: string;
/** A directory that is not a workspace and holds no config: where commands are typed. */
let elsewhere: string;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-active-workspace-'));
  latticeRoot = join(scratch, 'lattice-root');
  elsewhere = join(scratch, 'elsewhere');
  mkdirSync(latticeRoot, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(scratch, 'machine-config'), { recursive: true });
  home = homeOfItsOwn(join(scratch, 'home'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CliRun {
  status: number | null;
  output: string;
}

/**
 * Run the real command as its own process, from `cwd`.
 *
 * Nothing about the invocation is special: the runner is pointed at the
 * repository so the command's own imports resolve, and everything after `--` is
 * the argument list a person types. The working directory is the variable under
 * test, so it is always passed explicitly. Key material, the machine
 * configuration, the root and the HOME the command resolves anything else from
 * all live inside the scratch directory — nothing here can see or touch the
 * machine's own.
 */
function runCli(cwd: string, args: string[]): CliRun {
  const r = spawnSync(process.execPath, [RUNNER, '--root', REPO_ROOT, CLI_ENTRY, '--', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ...home,
      LATTICE_CONFIG_DIR: join(scratch, 'machine-config'),
      LATTICE_ROOT: latticeRoot,
      LATTICE_ENCRYPTION_KEY: ENCRYPTION_KEY,
    },
  });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A workspace file declaring one searchable table — what makes a health check assessable. */
function searchableWorkspace(name: string, table: string): string {
  return [
    `name: "${name}"`,
    'db: ./Data/database.db',
    'entities:',
    `  ${table}:`,
    '    fields:',
    '      id: { type: text, primaryKey: true }',
    '      title: { type: text }',
    '      body: { type: text }',
    '    fts: true',
    '    render: default-list',
    `    outputFile: ${table}.md`,
    'entityContexts:',
    `  ${table}:`,
    `    directoryRoot: Context/${table}`,
    '    slug: "{{id}}"',
    '    files:',
    '      CARD.md:',
    '        source: self',
    '        template: default-detail',
    '',
  ].join('\n');
}

interface Workspace {
  dir: string;
  configPath: string;
  contextDir: string;
}

/** Declare one searchable table in a workspace the commands above made. */
function declareTable(name: string, table: string): Workspace {
  const dir = join(latticeRoot, 'Workspaces', name);
  const configPath = join(dir, 'workspace.yml');
  expect(existsSync(configPath), `no workspace file at ${configPath}`).toBe(true);
  writeFileSync(configPath, searchableWorkspace(name, table), 'utf8');
  return { dir, configPath, contextDir: join(dir, 'Context') };
}

/** Make the machine's first workspace the way a person does — the real `init`. */
function initWorkspace(name: string, table: string): Workspace {
  const made = runCli(elsewhere, ['init', '--name', name]);
  expect(made.status, made.output).toBe(0);
  return declareTable(name, table);
}

/** Add another workspace and make it the active one, as `workspace` does. */
function addActiveWorkspace(name: string, table: string): Workspace {
  const created = runCli(elsewhere, ['workspace', 'create', name]);
  expect(created.status, created.output).toBe(0);
  const used = runCli(elsewhere, ['workspace', 'use', name]);
  expect(used.status, used.output).toBe(0);
  return declareTable(name, table);
}

let first: Workspace;

beforeAll(() => {
  first = initWorkspace('Ledger', 'note_card');
});

describe('the acceptance sequence, run the way a person runs it', () => {
  it('checks the health of the workspace this machine is using, from anywhere', () => {
    // Make a workspace, declare something searchable in it, check its health.
    // Nothing here names a path, because nobody types one — and that is the
    // entire difference between this and the same journey run in-process.
    const run = runCli(elsewhere, ['doctor']);

    expect(run.output).toContain('note_card');
    expect(run.output).toContain('healthy');
    // The exit code a deploy gate reads.
    expect(run.status, run.output).toBe(0);
  });

  it('checks it from inside the workspace directory too, whose file is not named that', () => {
    // The one place somebody would most expect a bare command to work — standing
    // in the workspace — and the place the old default could never resolve: the
    // file a workspace keeps is `workspace.yml`, not `lattice.config.yml`.
    const run = runCli(first.dir, ['doctor']);
    expect(run.output).toContain('note_card');
    expect(run.status, run.output).toBe(0);
  });

  it('searches it, and reports its index status, without being told where it is', () => {
    const searched = runCli(elsewhere, ['search', 'anything', '--table', 'note_card']);
    expect(searched.status, searched.output).toBe(0);

    const indexed = runCli(elsewhere, ['index', 'status']);
    expect(indexed.output).toContain('note_card');
    expect(indexed.status, indexed.output).toBe(0);
  });
});

describe('the commands that write a tree', () => {
  it('renders into the workspace, not into whatever directory it was typed from', () => {
    // Resolving the workspace without also resolving ITS rendered tree would
    // trade one wrong answer for a worse one: a command that opened the right
    // database and wrote its context beside the shell's current directory.
    const run = runCli(elsewhere, ['render']);

    expect(run.status, run.output).toBe(0);
    expect(existsSync(join(first.contextDir, 'note_card.md')), run.output).toBe(true);
    // The directory it was typed from is untouched.
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('reports on the workspace tree when asked for status, and changes nothing', () => {
    const run = runCli(elsewhere, ['status']);

    expect(run.output).toContain('DRY RUN');
    expect(run.status, run.output).toBe(0);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('still honours an explicit output directory over the workspace default', () => {
    const explicit = join(scratch, 'explicit-output');
    const run = runCli(elsewhere, ['render', '--output', explicit]);

    expect(run.status, run.output).toBe(0);
    expect(existsSync(join(explicit, 'note_card.md'))).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('a path that was actually typed still decides', () => {
  it('opens the named workspace, not the active one', () => {
    // A second workspace becomes the active one, so the only way the first can be
    // reported on is by honouring the path that was passed.
    const second = addActiveWorkspace('Archive', 'ledger_line');
    const active = runCli(elsewhere, ['doctor']);
    expect(active.output).toContain('ledger_line');
    expect(active.status, active.output).toBe(0);

    const named = runCli(elsewhere, ['doctor', '--config', first.configPath]);
    expect(named.output).toContain('note_card');
    expect(named.output).not.toContain('ledger_line');
    expect(named.status, named.output).toBe(0);
    expect(second.configPath).toContain('Archive');
  });

  it('fails on a path that names nothing, instead of quietly using the active workspace', () => {
    const missing = join(scratch, 'no-such-workspace.yml');
    const run = runCli(elsewhere, ['doctor', '--config', missing]);

    expect(run.output).toContain('no-such-workspace.yml');
    expect(run.output).not.toContain('healthy');
    expect(run.status, run.output).not.toBe(0);
  });
});

describe('a machine with nothing set up', () => {
  it('says what to do instead of reporting a missing file nobody asked for', () => {
    const bare = join(scratch, 'bare-machine');
    mkdirSync(join(bare, 'cwd'), { recursive: true });
    const r = spawnSync(
      process.execPath,
      [RUNNER, '--root', REPO_ROOT, CLI_ENTRY, '--', 'doctor'],
      {
        cwd: join(bare, 'cwd'),
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          ...homeOfItsOwn(join(bare, 'home')),
          LATTICE_CONFIG_DIR: join(bare, 'machine-config'),
          LATTICE_ROOT: join(bare, 'root'),
          LATTICE_ENCRYPTION_KEY: ENCRYPTION_KEY,
        },
      },
    );
    if (r.error) throw r.error;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(output).toMatch(/lattice init|--config/);
    expect(r.status, output).not.toBe(0);
  });
});
