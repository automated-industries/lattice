/**
 * The first two commands a person ever types must not report a broken install.
 *
 * `init` makes a workspace and nothing else — no table of your own, and none of
 * the framework's own tables opts into full-text or semantic search. `doctor`
 * then had nothing configured to assess, and said so as an ERROR: "Nothing to
 * diagnose", "✗ errors present", exit 1. That is the health check calling a
 * brand-new workspace unhealthy on the one path every user walks first.
 *
 * The error itself is worth keeping, because it guards something real: a deploy
 * gate must not read "healthy" off a database nobody described. But that guard
 * was firing on a different situation than the one it was written for. Two
 * things end with no tables to diagnose, and they are not the same:
 *
 *  - nobody said what to expect, and the database volunteers nothing — the
 *    doctor genuinely did not assess anything, so a gate must fail;
 *  - the whole schema was read, and none of it configures search — that IS an
 *    assessment, and its answer is "no retrieval here", which is a fact about
 *    the workspace rather than a failure to look at it.
 *
 * Opening a workspace is always the second case: the opener enumerates every
 * registered table before asking. It just could not say so, so it handed over an
 * empty list that was indistinguishable from having been told nothing.
 *
 * Both cases are covered here, and the first one runs the REAL command as its
 * own process from a directory that is not the workspace — the exit code an
 * operator and a deploy gate actually read. The in-process suites never saw this
 * because they all declare a searchable table before asking about health, which
 * is precisely the state that does not exist yet when somebody runs these two
 * commands back to back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { diagnoseRetrieval } from '../../src/search/doctor.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 57).toString('base64');

let scratch: string;
/** The machine's root — the workspace `init` makes lives in it. */
let latticeRoot: string;
/** A directory that is not a workspace and holds no config: where commands are typed. */
let elsewhere: string;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-doctor-fresh-'));
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
 * Key material, the machine configuration, the root and the HOME the command
 * resolves anything else from all live inside the scratch directory — nothing
 * here can see or touch the machine's own.
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

describe('the first two commands, run back to back', () => {
  beforeAll(() => {
    const made = runCli(elsewhere, ['init', '--name', 'First']);
    expect(made.status, made.output).toBe(0);
  });

  it('checks the health of a workspace that has only just been made, from elsewhere', () => {
    // Nothing has been added yet. Every real first run looks exactly like this.
    const run = runCli(elsewhere, ['doctor']);

    // The exit code an operator and a deploy gate read. This was 1.
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('errors present');
    expect(run.output).not.toMatch(/ERROR:/);
  });

  it('says why there is nothing to report, instead of implying something is wrong', () => {
    const run = runCli(elsewhere, ['doctor']);

    // Still surfaced — the answer is "no search is configured here", not silence.
    expect(run.output).toMatch(/INFO:/);
    expect(run.output).toMatch(/no table is configured for full-text or semantic search/i);
    // And it points at the thing that would change the answer.
    expect(run.output).toMatch(/fts:/);
  });

  it('still reports the machine-readable version as healthy', () => {
    const run = runCli(elsewhere, ['doctor', '--json']);
    expect(run.status, run.output).toBe(0);

    const json = run.output.slice(run.output.indexOf('{'), run.output.lastIndexOf('}') + 1);
    const report = JSON.parse(json) as {
      healthy: boolean;
      issues: { kind: string; severity: string }[];
    };
    expect(report.healthy).toBe(true);
    const issue = report.issues.find((i) => i.kind === 'no_retrieval_configured');
    expect(issue?.severity).toBe('info');
  });
});

describe('the guard that error was written for is still armed', () => {
  let db: Lattice | undefined;

  afterAll(() => {
    db?.close();
  });

  it('fails a caller that described nothing, because it assessed nothing', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await db.init();

    // Called with no expectations at all: this caller never enumerated the
    // schema, so an empty result means "not assessed" and must fail a gate.
    const report = await diagnoseRetrieval(db.adapter, {});

    expect(report.healthy).toBe(false);
    const issue = report.issues.find((i) => i.kind === 'nothing_to_diagnose');
    expect(issue?.severity).toBe('error');
  });

  it('separates that from a workspace whose whole schema was read and configures no search', async () => {
    // The opened-workspace path: the schema WAS enumerated, and the answer is
    // that none of it wants search. Assessed, and fine.
    const report = await db!.diagnoseRetrieval();

    expect(report.healthy).toBe(true);
    expect(report.issues.some((i) => i.kind === 'nothing_to_diagnose')).toBe(false);
    expect(report.issues.find((i) => i.kind === 'no_retrieval_configured')?.severity).toBe('info');
  });
});
