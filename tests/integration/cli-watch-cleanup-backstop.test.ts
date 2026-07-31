/**
 * Watching a workspace with cleanup on must obey the same refusals a one-shot
 * reconciliation does — and must SAY when it refuses.
 *
 * Watching is the worst place for a cleanup pass to be unguarded: it is the only
 * command whose whole job is to sweep the rendered tree over and over, on a
 * timer, unattended. The one-shot verb refused to empty a directory it did not
 * understand; the watching verb held the render engine and called its deletion
 * directly, so the identical workspace in the identical state lost its whole
 * rendered tree on the first tick and reported "removed 2 dirs, 2 files".
 *
 * Both cases are driven through the REAL command as its own process — its own
 * argument parsing, its own workspace open, its own printed output — because a
 * check that is only ever exercised by constructing a Lattice in a test is
 * exactly how the previous one passed while being unreachable in the field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import { createConnector } from '../../src/connectors/registry.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';
import type { TableDefinition } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');

let scratch: string;
let savedConfigDir: string | undefined;
let savedRoot: string | undefined;
let savedKey: string | undefined;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-watch-backstop-'));
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  savedRoot = process.env.LATTICE_ROOT;
  savedKey = process.env.LATTICE_ENCRYPTION_KEY;
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'machine-config');
  process.env.LATTICE_ROOT = join(scratch, 'lattice-root');
  process.env.LATTICE_ENCRYPTION_KEY = ENCRYPTION_KEY;
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.LATTICE_ROOT, { recursive: true });
  home = homeOfItsOwn(join(scratch, 'home'));
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
  if (savedRoot === undefined) delete process.env.LATTICE_ROOT;
  else process.env.LATTICE_ROOT = savedRoot;
  if (savedKey === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedKey;
  rmSync(scratch, { recursive: true, force: true });
});

/** The environment every command below runs in — entirely inside the scratch tree. */
function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...home,
    LATTICE_CONFIG_DIR: process.env.LATTICE_CONFIG_DIR ?? '',
    LATTICE_ROOT: process.env.LATTICE_ROOT ?? '',
    LATTICE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
}

/** Run the one-shot command and capture what an operator would see. */
function runCli(args: string[]): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [RUNNER, CLI_ENTRY, '--', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: cliEnv(),
  });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Run the WATCHING command until it has completed one cleanup pass, then stop it
 * the way an operator does. Returns everything it printed.
 */
async function watchOneCycle(args: string[]): Promise<string> {
  const child = spawn(process.execPath, [RUNNER, CLI_ENTRY, '--', 'watch', ...args], {
    cwd: REPO_ROOT,
    env: cliEnv(),
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    out += c;
  });
  child.stderr.on('data', (c: string) => {
    out += c;
  });

  const deadline = Date.now() + 90_000;
  while (!out.includes('Cleanup: removed') && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // A refusal and a sweep both print the Cleanup line; give the same tick's
  // warnings a moment to land before reading the transcript.
  await new Promise((r) => setTimeout(r, 400));
  child.kill('SIGTERM');
  await new Promise((r) => {
    if (child.exitCode !== null) r(undefined);
    else
      child.on('close', () => {
        r(undefined);
      });
  });
  return out;
}

const AGENT_CONFIG = [
  'db: ./lattice.db',
  'entities:',
  '  agent:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: agents.md',
  'entityContexts:',
  '  agent:',
  '    directoryRoot: Context/Agents',
  '    slug: "{{slug}}"',
  '    files:',
  '      AGENT.md:',
  '        source: self',
  '        template: default-detail',
  '',
].join('\n');

interface Workspace {
  dir: string;
  configPath: string;
  outputDir: string;
}

function makeWorkspace(name: string, config: string): Workspace {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, config, 'utf8');
  return { dir, configPath, outputDir: join(dir, 'context') };
}

/** Open a workspace the way the app does, run `body`, and always close. */
async function asTheApp(ws: Workspace, body: (db: Lattice) => Promise<void>): Promise<void> {
  const db = new Lattice({ config: ws.configPath }, { encryptionKey: ENCRYPTION_KEY });
  registerNativeEntities(db);
  await db.init();
  try {
    await body(db);
  } finally {
    db.close();
  }
}

/** Give a runtime-registered table the per-record context the app gives it. */
function addCanonicalContext(
  db: Lattice,
  models: readonly { table: string; definition: TableDefinition }[],
): void {
  const existing = db.entityContexts();
  const named = models.map((m) => ({ name: m.table, definition: m.definition }));
  for (const { table, definition } of deriveCanonicalContexts(named)) {
    if (!existing.has(table)) db.defineEntityContext(table, definition);
  }
}

const ORDERS: TableDefinition = {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
  primaryKey: 'id',
  render: () => '',
  outputFile: 'connectors/db/orders.md',
};

describe('watching a workspace whose layout it never learned', () => {
  it('refuses on the tick, keeps the tree, and prints why', async () => {
    const ws = makeWorkspace('watch-layout-lost', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.insert('agent', { id: 'a2', slug: 'bravo', name: 'Bravo' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const alpha = join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md');
    const bravo = join(ws.outputDir, 'Context', 'Agents', 'bravo', 'AGENT.md');
    expect(existsSync(alpha)).toBe(true);

    // The config loses its layout — the shape a shared workspace has on a machine
    // whose published layout never arrived.
    writeFileSync(ws.configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');

    const out = await watchOneCycle([
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--cleanup',
      '--interval',
      '300',
    ]);

    // Nothing removed, and the reason reached the operator rather than being
    // dropped in favour of two counts.
    expect(existsSync(alpha), out).toBe(true);
    expect(existsSync(bravo), out).toBe(true);
    expect(existsSync(join(ws.outputDir, 'agents.md')), out).toBe(true);
    expect(out).toMatch(/cleanup skipped/);
    expect(out).toMatch(/renders no layout of its own/);
    expect(out).toMatch(/Cleanup: removed 0 dirs, 0 files/);
  }, 120_000);
});

describe('watching a workspace with a connected source it cannot load', () => {
  it('refuses exactly where the one-shot command refuses, on the same workspace', async () => {
    const ws = makeWorkspace('watch-connected-unloadable', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:watch-1',
        displayName: 'analytics-db',
      });
      await db.defineLate('db_analytics_orders', ORDERS);
      addCanonicalContext(db, [{ table: 'db_analytics_orders', definition: ORDERS }]);
      await db.insert('db_analytics_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_analytics_orders', 'order-one', 'DB_ANALYTICS_ORDER.md');
    const rollup = join(ws.outputDir, 'connectors', 'db', 'orders.md');
    expect(existsSync(order)).toBe(true);

    // First the one-shot verb, to establish what this workspace's state means.
    const once = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(once.output).toMatch(/cleanup skipped/);
    expect(once.status).not.toBe(0);
    expect(existsSync(order)).toBe(true);

    // Then the watching verb, on the SAME workspace in the SAME state. It used to
    // delete the connected source's whole rendered tree here and report a clean
    // sweep — two commands, one workspace, opposite answers.
    const out = await watchOneCycle([
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--cleanup',
      '--interval',
      '300',
    ]);

    expect(existsSync(order), out).toBe(true);
    expect(existsSync(rollup), out).toBe(true);
    expect(out).toMatch(/cleanup skipped/);
    expect(out).toMatch(/analytics-db/);
    expect(out).not.toMatch(/Cleanup: removed [1-9]/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The same two guarantees for the plainest workspace of all: tables that render
// ONE file each, and no per-record directories.
//
// That shape records no per-record layout at all, and the check read the absence
// of one as "there is nothing rendered here to protect" — so it stood aside
// while the sweep deleted the single file the workspace had. Unattended, on a
// timer, reporting "removed 0 dirs, 1 files" and carrying on.
// ---------------------------------------------------------------------------

/** One table, rendering one file. No entity contexts anywhere. */
const SINGLE_FILE_CONFIG = [
  'db: ./lattice.db',
  'entities:',
  '  agents:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: AGENT.md',
  '',
].join('\n');

/** The same, plus a second single-file table — dropped back to the above below. */
const TWO_SINGLE_FILE_CONFIG = [
  SINGLE_FILE_CONFIG.trimEnd(),
  '  projects:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: PROJECT.md',
  '',
].join('\n');

describe('watching a workspace that renders single files and no per-record directories', () => {
  it('keeps the rendered file when the layout is missing, and prints why', async () => {
    const ws = makeWorkspace('watch-single-file-layout-lost', SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);

    writeFileSync(ws.configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');

    const out = await watchOneCycle([
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--cleanup',
      '--interval',
      '300',
    ]);

    expect(existsSync(rendered), out).toBe(true);
    expect(out).toMatch(/cleanup skipped/);
    expect(out).toMatch(/renders no layout of its own/);
    expect(out).toMatch(/Cleanup: removed 0 dirs, 0 files/);

    // Watching renders BEFORE it sweeps, and that render rewrites the record of
    // what has been rendered here. If the missing table were dropped from that
    // record, the objection would be gone and the very next pass would take the
    // file with nothing left to say — so ask a fresh one-shot command.
    const after = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(after.output).toMatch(/cleanup skipped/);
    expect(after.status).not.toBe(0);
    expect(existsSync(rendered)).toBe(true);
  }, 120_000);

  it('still sweeps a genuinely dropped table on the tick', async () => {
    // The other half: a protection that stops the timer sweeping ordinary edits
    // is its own kind of broken, and this is the caller with nobody watching it
    // to notice a file that should have gone and did not.
    const ws = makeWorkspace('watch-single-file-drop', TWO_SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.insert('projects', { id: 'p1', slug: 'apollo', name: 'Apollo' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const agents = join(ws.outputDir, 'AGENT.md');
    const projects = join(ws.outputDir, 'PROJECT.md');
    expect(existsSync(projects)).toBe(true);

    writeFileSync(ws.configPath, SINGLE_FILE_CONFIG, 'utf8');

    const out = await watchOneCycle([
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--cleanup',
      '--interval',
      '300',
    ]);

    expect(out).not.toMatch(/cleanup skipped/);
    expect(out).toMatch(/Cleanup: removed 0 dirs, 1 files/);
    expect(existsSync(projects), out).toBe(false);
    expect(existsSync(agents), out).toBe(true);
  }, 120_000);
});
