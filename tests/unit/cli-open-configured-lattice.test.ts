/**
 * Every CLI command that opens a workspace from a config file must open it the
 * SAME way: hydrate the shared entity/render layout into the local config FIRST,
 * then construct the Lattice from the hydrated file.
 *
 * Why this matters (the bug these tests pin):
 *
 * A member of a shared cloud workspace has a local config whose `entities:` block
 * is EMPTY until it is hydrated from the shared layout the owner published. A
 * command that constructs the Lattice straight from that un-hydrated file gets a
 * schema with ZERO tables. A reconcile on that schema then compares the previous
 * render manifest against "no entity contexts at all", concludes every context
 * that was previously rendered has been removed, and DELETES the entire rendered
 * tree from disk. The same missing hydration also makes read-only commands
 * (search, doctor, status) report on an empty schema.
 *
 * The render path already hydrated before constructing; six other commands did
 * not. These tests pin the shared open path and the fact that every
 * config-opening command routes through it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { openConfiguredLattice } from '../../src/cli-open.js';

// Stands in for the shared-layout hydration a real cloud member gets over the
// wire: it rewrites the local config file with the published layout, exactly the
// observable effect the real function has, and (like the real one) it is a no-op
// once the config already carries entities.
const hydration = vi.hoisted(() => ({
  calls: 0,
  payload: null as string | null,
  /** When set, hydration reports that the published layout could not be read. */
  unavailable: null as string | null,
}));

vi.mock('../../src/cloud/shared-schema.js', () => ({
  publishSharedSchema: (): Promise<void> => Promise.resolve(),
  hydrateMemberConfigFromCloud: (configPath: string): Promise<{ outcome: string }> => {
    hydration.calls++;
    if (hydration.unavailable !== null) {
      return Promise.resolve({ outcome: 'unavailable', reason: hydration.unavailable });
    }
    if (hydration.payload === null) return Promise.resolve({ outcome: 'not-shared' });
    const current = readFileSync(configPath, 'utf8');
    if (!/entities:\s*\{\s*\}/.test(current))
      return Promise.resolve({ outcome: 'already-populated' });
    writeFileSync(configPath, hydration.payload, 'utf8');
    return Promise.resolve({ outcome: 'hydrated' });
  },
}));

let scratch: string;
let prevConfigDir: string | undefined;
let prevKey: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cli-open-'));
  prevConfigDir = process.env.LATTICE_CONFIG_DIR;
  prevKey = process.env.LATTICE_ENCRYPTION_KEY;
  // Keep key resolution inside the scratch dir — never the real user config dir.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prevConfigDir;
  if (prevKey === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = prevKey;
  rmSync(scratch, { recursive: true, force: true });
});

const RENDER_ROOT = join('Context', 'Agents');

function sharedLayoutConfig(dbPath: string): string {
  return [
    `db: ${dbPath}`,
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
}

interface Workspace {
  configPath: string;
  outputDir: string;
  ownerConfig: string;
  /** A file the first render wrote — the tree the cleanup bug destroys. */
  renderedFile: string;
}

/**
 * Build a workspace the way the owner has it: a full layout, rows, and one
 * completed render (which writes the manifest the next reconcile compares
 * against). Then strip the config down to the shape a member's machine holds
 * before hydration — same database, empty entities.
 */
async function buildMemberShapedWorkspace(name: string): Promise<Workspace> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  const outputDir = join(dir, 'context');
  const dbPath = join(dir, 'lattice.db');
  const ownerConfig = sharedLayoutConfig(dbPath);
  writeFileSync(configPath, ownerConfig, 'utf8');

  const owner = new Lattice({ config: configPath });
  try {
    await owner.init();
    await owner.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
    await owner.insert('agent', { id: 'a2', slug: 'bravo', name: 'Bravo' });
    await owner.reconcile(outputDir, {
      removeOrphanedDirectories: true,
      removeOrphanedFiles: true,
    });
  } finally {
    owner.close();
  }

  const renderedFile = join(outputDir, RENDER_ROOT, 'alpha', 'AGENT.md');
  expect(existsSync(renderedFile)).toBe(true);

  // The member's machine: same database, no layout yet.
  writeFileSync(configPath, `db: ${dbPath}\nentities: {}\n`, 'utf8');

  return { configPath, outputDir, ownerConfig, renderedFile };
}

describe('openConfiguredLattice', () => {
  it('hydrates the shared layout before constructing, so reconcile keeps the rendered tree', async () => {
    const ws = await buildMemberShapedWorkspace('member-reconcile');
    hydration.payload = ws.ownerConfig;
    hydration.calls = 0;

    const db = await openConfiguredLattice({ config: ws.configPath });
    let result;
    try {
      await db.init();
      // A write against the hydrated schema: an un-hydrated open has no such
      // table registered, so this is also proof the layout is live in-process —
      // the same schema search, doctor and status read from.
      await db.insert('agent', { id: 'a3', slug: 'charlie', name: 'Charlie' });
      result = await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    } finally {
      db.close();
    }

    // The tree the un-hydrated open would have deleted.
    expect(existsSync(ws.renderedFile)).toBe(true);
    expect(existsSync(join(ws.outputDir, RENDER_ROOT, 'bravo', 'AGENT.md'))).toBe(true);
    expect(hydration.calls).toBe(1);
    expect(result.cleanup.directoriesRemoved).toEqual([]);
    expect(result.cleanup.filesRemoved).toEqual([]);
    // The hydrated entities are live in the opened schema, so the render/status
    // path reports real work instead of an empty schema.
    expect(result.filesWritten.some((f) => f.includes(join(RENDER_ROOT, 'charlie')))).toBe(true);
    expect(existsSync(join(ws.outputDir, RENDER_ROOT, 'charlie', 'AGENT.md'))).toBe(true);
  });

  it('leaves an already-populated config alone (an owner keeps its own layout)', async () => {
    const dir = join(scratch, 'owner-untouched');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'lattice.config.yml');
    const ownerConfig = sharedLayoutConfig(join(dir, 'lattice.db'));
    writeFileSync(configPath, ownerConfig, 'utf8');
    // A payload that would clobber the config if hydration ignored the guard.
    hydration.payload = `db: ${join(dir, 'other.db')}\nentities: {}\n`;
    hydration.calls = 0;

    const db = await openConfiguredLattice({ config: configPath });
    try {
      await db.init();
    } finally {
      db.close();
    }

    expect(hydration.calls).toBe(1);
    expect(readFileSync(configPath, 'utf8')).toBe(ownerConfig);
  });

  it('surfaces an unreadable config instead of returning a half-open handle', async () => {
    hydration.payload = null;
    await expect(openConfiguredLattice({ config: join(scratch, 'nope.yml') })).rejects.toThrow(
      /cannot read config file/,
    );
  });

  // A shared workspace whose layout could not be READ is not the same as a
  // workspace with no layout, and used to be indistinguishable from it: the
  // failure was logged and the open continued with zero tables. Every read-only
  // command then reported on nothing, and a reconcile went after the whole tree.
  it('refuses to open when the shared layout could not be read', async () => {
    const ws = await buildMemberShapedWorkspace('member-layout-unreadable');
    hydration.payload = null;
    hydration.unavailable = 'permission denied for table __lattice_shared_schema';
    try {
      await expect(openConfiguredLattice({ config: ws.configPath })).rejects.toThrow(
        /shared, and its layout could not be read.*permission denied/s,
      );
    } finally {
      hydration.unavailable = null;
    }
    // Nothing was opened, so nothing was rendered over or removed.
    expect(existsSync(ws.renderedFile)).toBe(true);
  });
});

describe('opening with a schema that never loaded', () => {
  // The destructive half of the same bug, from the other direction: whatever the
  // reason a process ends up with no tables — an un-hydrated shared workspace, a
  // config that describes nothing — the previous manifest lists every rendered
  // file as removable, and cleanup would take all of them. A schema with no
  // tables cannot have dropped anything, so this is refused and reported.
  it('refuses cleanup instead of deleting the rendered tree', async () => {
    const ws = await buildMemberShapedWorkspace('member-unhydrated');

    const db = new Lattice({ config: ws.configPath });
    let result;
    try {
      await db.init();
      result = await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    } finally {
      db.close();
    }

    expect(existsSync(ws.renderedFile)).toBe(true);
    expect(existsSync(join(ws.outputDir, RENDER_ROOT, 'bravo', 'AGENT.md'))).toBe(true);
    expect(result.cleanup.filesRemoved).toEqual([]);
    expect(result.cleanup.directoriesRemoved).toEqual([]);
    expect(result.cleanup.warnings.join('\n')).toMatch(/declares no tables/);
  });
});

describe('every config-opening CLI command uses the shared open path', () => {
  const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'cli.ts'), 'utf8');

  /** Source text of one top-level function, up to the next top-level function. */
  function bodyOf(fnName: string): string {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start, `${fnName} not found in src/cli.ts`).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:async )?function \w+\(/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  const commands = [
    'runRender',
    'runDoctor',
    'runReindex',
    'runIndex',
    'runSearch',
    'runReconcile',
    'runWatch',
  ];

  for (const fn of commands) {
    it(`${fn} opens through openConfiguredLattice`, () => {
      expect(bodyOf(fn)).toContain('openConfiguredLattice(');
    });
  }

  it('never constructs a Lattice from a config file inline', () => {
    // An inline construction skips hydration — that is the bug.
    expect(source).not.toMatch(/new Lattice\(\s*\{\s*config:/);
  });
});
