/**
 * A workspace named by `--config` decides which rendered tree the command writes
 * — the shell's location must not.
 *
 * When a config is not a registered workspace, the rendered-context directory is
 * found by probing the conventional locations. Probing them relative to the
 * PROCESS's working directory answers with whatever tree happens to be near the
 * shell, which for a config named by absolute path from somewhere else belongs to
 * a different workspace entirely. The command then renders workspace A into
 * workspace B's tree and, in the same pass, sweeps B's own contexts out of it as
 * things A no longer declares — the two workspaces have nothing to do with each
 * other, so the check that guards against a half-loaded schema sees an ordinary
 * drop and lets it through.
 *
 * Driven through the REAL command as its own process, from a working directory
 * that is a different workspace — which is the whole point of the case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { resolveWorkspaceTarget } from '../../src/cli-target.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 77).toString('base64');

let scratch: string;
let savedConfigDir: string | undefined;
let savedRoot: string | undefined;
let savedKey: string | undefined;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-config-target-'));
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

/** Run the real command from `cwd`, as an operator standing in that directory. */
function runCli(cwd: string, args: string[]): { status: number | null; output: string } {
  // The runner is told where the sources live (--root), so the process's own
  // working directory is free to be the OTHER workspace — which is the condition
  // under test, not an incidental detail.
  const r = spawnSync(process.execPath, [RUNNER, '--root', REPO_ROOT, CLI_ENTRY, '--', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ...home,
      LATTICE_CONFIG_DIR: process.env.LATTICE_CONFIG_DIR ?? '',
      LATTICE_ROOT: process.env.LATTICE_ROOT ?? '',
      LATTICE_ENCRYPTION_KEY: ENCRYPTION_KEY,
    },
  });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function configFor(entity: string, root: string, file: string): string {
  return [
    'db: ./lattice.db',
    'entities:',
    `  ${entity}:`,
    '    fields:',
    '      id: { type: text, primaryKey: true }',
    '      slug: { type: text }',
    '      name: { type: text }',
    '    render: default-list',
    `    outputFile: ${file}`,
    'entityContexts:',
    `  ${entity}:`,
    `    directoryRoot: Context/${root}`,
    '    slug: "{{slug}}"',
    '    files:',
    `      ${entity.toUpperCase()}.md:`,
    '        source: self',
    '        template: default-detail',
    '',
  ].join('\n');
}

interface Workspace {
  dir: string;
  configPath: string;
  outputDir: string;
}

/** A rendered, self-contained workspace whose tree sits at `<dir>/context`. */
async function renderedWorkspace(
  name: string,
  entity: string,
  root: string,
  file: string,
  row: { id: string; slug: string; name: string },
): Promise<Workspace> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, configFor(entity, root, file), 'utf8');
  const ws: Workspace = { dir, configPath, outputDir: join(dir, 'context') };
  const db = new Lattice({ config: configPath }, { encryptionKey: ENCRYPTION_KEY });
  registerNativeEntities(db);
  await db.init();
  try {
    await db.insert(entity, row);
    await db.reconcile(ws.outputDir, {
      removeOrphanedDirectories: true,
      removeOrphanedFiles: true,
    });
  } finally {
    db.close();
  }
  return ws;
}

describe('reconciling a workspace named by --config from inside a different one', () => {
  it('writes and sweeps that workspace ONLY — the shell picks nothing', async () => {
    const alpha = await renderedWorkspace('alpha-ws', 'agent', 'Agents', 'agents.md', {
      id: 'a1',
      slug: 'ada',
      name: 'Ada',
    });
    const beta = await renderedWorkspace('beta-ws', 'project', 'Projects', 'projects.md', {
      id: 'p1',
      slug: 'apollo',
      name: 'Apollo',
    });

    const betaProject = join(beta.outputDir, 'Context', 'Projects', 'apollo', 'PROJECT.md');
    const betaRollup = join(beta.outputDir, 'projects.md');
    const alphaAgent = join(alpha.outputDir, 'Context', 'Agents', 'ada', 'AGENT.md');
    expect(existsSync(betaProject)).toBe(true);
    expect(existsSync(alphaAgent)).toBe(true);

    // A row alpha has not rendered yet, so the run must WRITE somewhere and the
    // question "where" has a visible answer.
    {
      const db = new Lattice({ config: alpha.configPath }, { encryptionKey: ENCRYPTION_KEY });
      registerNativeEntities(db);
      await db.init();
      try {
        await db.insert('agent', { id: 'a2', slug: 'grace', name: 'Grace' });
      } finally {
        db.close();
      }
    }

    // The operator is standing in beta and reconciles ALPHA by path. No --output:
    // the command has to work out where alpha's tree lives.
    const run = runCli(beta.dir, ['reconcile', '--config', alpha.configPath]);

    const writtenIntoAlpha = join(alpha.outputDir, 'Context', 'Agents', 'grace', 'AGENT.md');
    const writtenIntoBeta = join(beta.outputDir, 'Context', 'Agents', 'grace', 'AGENT.md');
    expect(existsSync(writtenIntoAlpha), run.output).toBe(true);
    expect(existsSync(writtenIntoBeta), run.output).toBe(false);

    // Beta is untouched — not written into, not swept.
    expect(existsSync(betaProject), run.output).toBe(true);
    expect(existsSync(betaRollup), run.output).toBe(true);
    expect(existsSync(join(beta.outputDir, 'Context', 'Agents')), run.output).toBe(false);
    expect(existsSync(join(beta.outputDir, 'agents.md')), run.output).toBe(false);

    // Alpha is what was reconciled.
    expect(existsSync(alphaAgent), run.output).toBe(true);
    expect(run.output).toMatch(/alpha-ws/);
    expect(run.output, 'nothing about the other workspace was touched').not.toMatch(/beta-ws/);
    expect(run.status).toBe(0);
  }, 120_000);

  it('resolves the tree next to the config, not next to the shell', () => {
    // The same claim at the level the command asks it, so a regression is named
    // rather than inferred from which files survived.
    const alphaConfig = join(scratch, 'alpha-ws', 'lattice.config.yml');
    const target = resolveWorkspaceTarget({ config: alphaConfig, explicitConfig: true });
    expect(target.contextDir).toBe(join(scratch, 'alpha-ws', 'context'));
    expect(target.contextDir.startsWith(join(scratch, 'beta-ws'))).toBe(false);
  });
});
