/**
 * A terminal reconciliation must never delete a rendered tree it simply failed
 * to learn about.
 *
 * Every case here runs the REAL command — the actual entry point, its own
 * argument parsing, its own workspace open, its own exit code — against a
 * workspace another process rendered. That distinction is the whole point: the
 * previous guard against this was only ever exercised by constructing a Lattice
 * directly in a test, and constructing one directly is the ONE way of opening a
 * workspace that skips the schema every real opener applies. The guard passed
 * its test and could not fire in the field.
 *
 * The two ways a command ends up knowing less than the app that wrote the tree:
 *
 *  1. the workspace's layout is missing from its config (a shared workspace
 *     whose published layout has not arrived, a config that describes nothing);
 *  2. the workspace has a connected external source — an imported database, an
 *     MCP server — whose tables are registered at connect time, in that process
 *     only, and so have to be replayed on every later open.
 *
 * Both used to end the same way: "Cleanup: removed N directories, N files" and
 * an exit code of 0 over a directory that had just been emptied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import { createConnector } from '../../src/connectors/registry.js';
import { readManifest } from '../../src/lifecycle/manifest.js';
import { genericConnector } from '../../src/connectors/generic/connector.js';
import { setMcpSchemaDescriptor, mcpTableName } from '../../src/connectors/mcp/schema-cache.js';
// The browser's own open, which is where the workspace's rendered record comes
// from in the cases below that a command has to be able to reconcile afterwards.
import { openConfig, disposeActive } from '../../src/gui/server.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';
import type { TableDefinition, Row } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

let scratch: string;
let savedConfigDir: string | undefined;
let savedRoot: string | undefined;
let savedKey: string | undefined;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cleanup-backstop-'));
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  savedRoot = process.env.LATTICE_ROOT;
  savedKey = process.env.LATTICE_ENCRYPTION_KEY;
  // Everything — key material, the credential store, the workspace registry, and
  // the home a command resolves anything else from — stays inside the scratch
  // directory. Nothing reaches the machine's own.
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

interface CliRun {
  status: number | null;
  output: string;
}

/**
 * Run the real command and capture what an operator would see.
 *
 * The process runs from the repository root (the runner resolves the command's
 * own imports from there) and is pointed at the workspace by absolute path —
 * which is an ordinary way to invoke it, and leaves every other part of the run
 * untouched: real argument parsing, real workspace open, real exit code.
 */
function runCli(args: string[]): CliRun {
  const r = spawnSync(process.execPath, [RUNNER, CLI_ENTRY, '--', ...args], {
    cwd: REPO_ROOT,
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

/** The same workspace with a second entity — dropped back to AGENT_CONFIG below. */
const TWO_ENTITY_CONFIG = [
  'db: ./lattice.db',
  'entities:',
  '  agent:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: agents.md',
  '  project:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: projects.md',
  'entityContexts:',
  '  agent:',
  '    directoryRoot: Context/Agents',
  '    slug: "{{slug}}"',
  '    files:',
  '      AGENT.md:',
  '        source: self',
  '        template: default-detail',
  '  project:',
  '    directoryRoot: Context/Projects',
  '    slug: "{{slug}}"',
  '    files:',
  '      PROJECT.md:',
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

describe('a terminal reconciliation of a workspace whose layout it never learned', () => {
  it('refuses, says why, and fails — instead of emptying the directory and reporting success', async () => {
    const ws = makeWorkspace('layout-lost', AGENT_CONFIG);
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

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    expect(existsSync(alpha)).toBe(true);
    expect(existsSync(bravo)).toBe(true);
    expect(existsSync(join(ws.outputDir, 'agents.md'))).toBe(true);
    expect(run.output).not.toMatch(/Cleanup: removed/);
    expect(run.output).toMatch(/cleanup skipped/);
    expect(run.output).toMatch(/renders no layout of its own/);
    // A refusal is a problem to fix, so the command reports failure.
    expect(run.status).not.toBe(0);
  });

  it('keeps refusing on every run, not just the first', async () => {
    // A refusal that lasts one run is barely a refusal. Reconciling also rewrites
    // the record of what has been rendered here, and a process with a narrower
    // schema writes a narrower record — which turns "I do not understand these
    // contexts" into "these contexts never existed", so the very next run has
    // nothing left to object to and takes the tree. Somebody who runs the command
    // twice must not lose what the first run protected.
    const ws = makeWorkspace('layout-lost-repeated', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const alpha = join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md');
    expect(existsSync(alpha)).toBe(true);

    writeFileSync(ws.configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');

    for (const attempt of [1, 2, 3]) {
      const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
      expect(run.output, `run ${String(attempt)}`).toMatch(/cleanup skipped/);
      expect(run.output, `run ${String(attempt)}`).not.toMatch(/Cleanup: removed/);
      expect(run.status, `run ${String(attempt)}`).not.toBe(0);
      expect(existsSync(alpha), `run ${String(attempt)}`).toBe(true);
      expect(existsSync(join(ws.outputDir, 'agents.md')), `run ${String(attempt)}`).toBe(true);
    }
  });
});

describe('a terminal reconciliation of a workspace with a connected external source', () => {
  it('loads the connected source and keeps its rendered tree', async () => {
    const ws = makeWorkspace('connected-mcp', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      // A connected server, and the tables it registers at connect time — which
      // live in this process only, and in the registry row that outlives it.
      await createConnector(db, { connector: 'mcp', toolkit: 'mcp', displayName: 'partner-mcp' });
      const models = genericConnector().models('mcp');
      for (const m of models) await db.defineLate(m.table, m.definition);
      addCanonicalContext(db, models);
      await db.insert('mcp_items', { id: 'i1', title: 'Widget One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const item = join(ws.outputDir, 'Mcp_items', 'widget-one', 'MCP_ITEM.md');
    const rollup = join(ws.outputDir, 'connectors', 'mcp', 'mcp_items.md');
    expect(existsSync(item)).toBe(true);
    expect(existsSync(rollup)).toBe(true);

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    // The command replayed the connection, so the tree is reconciled, not removed.
    expect(existsSync(item)).toBe(true);
    expect(existsSync(rollup)).toBe(true);
    expect(existsSync(join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md'))).toBe(true);
    expect(run.output).not.toMatch(/Removed/);
    expect(run.output).not.toMatch(/cleanup skipped/);
    expect(run.status).toBe(0);
  });

  it('refuses when the connected source cannot be loaded on this machine', async () => {
    const ws = makeWorkspace('connected-db-unloadable', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      // An imported external database. Its tables come from a schema description
      // held on the machine that made the connection — which is exactly what a
      // second machine (or a cleared store) does not have.
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:conn-1',
        displayName: 'analytics-db',
      });
      await db.defineLate('db_analytics_orders', orders);
      addCanonicalContext(db, [{ table: 'db_analytics_orders', definition: orders }]);
      await db.insert('db_analytics_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_analytics_orders', 'order-one', 'DB_ANALYTICS_ORDER.md');
    expect(existsSync(order)).toBe(true);

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    expect(existsSync(order)).toBe(true);
    expect(existsSync(join(ws.outputDir, 'connectors', 'db', 'orders.md'))).toBe(true);
    expect(run.output).not.toMatch(/Cleanup: removed/);
    expect(run.output).toMatch(/cleanup skipped/);
    expect(run.output).toMatch(/analytics-db/);
    expect(run.status).not.toBe(0);
  });

  it('says so in the app too, where the background pass reads no result at all', async () => {
    // The reconciliation the app runs after every write discards its result, so a
    // refusal there has nowhere to appear unless it is announced. Silence is
    // precisely the failure this check exists to end, so it must not reappear one
    // layer down.
    const ws = makeWorkspace('background-refusal', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:conn-2',
        displayName: 'analytics-db',
      });
      await db.defineLate('db_analytics_orders', orders);
      addCanonicalContext(db, [{ table: 'db_analytics_orders', definition: orders }]);
      await db.insert('db_analytics_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });

    // A second session that cannot describe the connected source, writing normally.
    const notices: string[] = [];
    const db = new Lattice({ config: ws.configPath }, { encryptionKey: ENCRYPTION_KEY });
    registerNativeEntities(db);
    await db.init();
    try {
      db.setRenderNoticeHandler((m) => notices.push(m));
      db.enableAutoRender(ws.outputDir, { debounceMs: 1 });
      // Two writes, because a background render rewrites the record of what has
      // been rendered here — and if the contexts it does not know are dropped
      // from that record, the SECOND pass has nothing left to object to.
      for (const row of [
        { id: 'a2', slug: 'bravo', name: 'Bravo' },
        { id: 'a3', slug: 'charlie', name: 'Charlie' },
      ]) {
        await db.insert('agent', row);
        const deadline = Date.now() + 10_000;
        while (notices.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        // Let the pass that follows this write settle before the next one.
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      db.disableAutoRender();
      db.close();
    }

    expect(notices.join('\n')).toMatch(/cleanup skipped/);
    expect(notices.join('\n')).toMatch(/analytics-db/);
    // ...and the tree it declined to sweep is still there.
    expect(
      existsSync(join(ws.outputDir, 'Db_analytics_orders', 'order-one', 'DB_ANALYTICS_ORDER.md')),
    ).toBe(true);
  });

  it('is still objected to on the second and third open, not quietly forgotten', async () => {
    // Opening a workspace renders it in full and then reconciles, and the render
    // rewrites the record of what has been rendered here. A session that does not
    // know the connected source writes a record without it — which reads, from
    // then on, as "that context never existed". The condition has not improved at
    // all, but the complaint stops, the rendered files it wrote outside the
    // context tree are swept as unrecorded leftovers, and the tree that remains is
    // no longer tracked by anything. The app opens a workspace every time it
    // starts, so being right on the first open only is not being right.
    const ws = makeWorkspace('reopened-repeatedly', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:conn-3',
        displayName: 'analytics-db',
      });
      await db.defineLate('db_analytics_orders', orders);
      addCanonicalContext(db, [{ table: 'db_analytics_orders', definition: orders }]);
      await db.insert('db_analytics_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_analytics_orders', 'order-one', 'DB_ANALYTICS_ORDER.md');
    expect(existsSync(order)).toBe(true);

    const rollup = join(ws.outputDir, 'connectors', 'db', 'orders.md');
    expect(existsSync(rollup)).toBe(true);

    for (const attempt of [1, 2, 3]) {
      const refusals: string[] = [];
      // Exactly what opening a workspace does: render, then reconcile the tree
      // against what the previous render recorded.
      await asTheApp(ws, async (db) => {
        db.setRenderNoticeHandler((m) => {
          if (m.includes('cleanup skipped')) refusals.push(m);
        });
        const prev = readManifest(ws.outputDir);
        await db.render(ws.outputDir);
        await db.reconcileRenderedTree(ws.outputDir, prev, readManifest(ws.outputDir));
      });
      // Every open: the same objection, and everything still on disk.
      expect(refusals.join('\n'), `open ${String(attempt)}`).toMatch(/analytics-db/);
      expect(existsSync(order), `open ${String(attempt)}`).toBe(true);
      expect(existsSync(rollup), `open ${String(attempt)}`).toBe(true);
      // The record still knows about the context it refused to sweep, which is
      // what keeps the objection true rather than merely repeated.
      expect(
        Object.keys(readManifest(ws.outputDir)?.entityContexts ?? {}),
        `open ${String(attempt)}`,
      ).toContain('db_analytics_orders');
    }
  });
});

describe('a workspace that really did drop a table', () => {
  it('still has its orphaned tree swept, and reports success', async () => {
    const ws = makeWorkspace('genuine-drop', TWO_ENTITY_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.insert('project', { id: 'p1', slug: 'apollo', name: 'Apollo' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const apollo = join(ws.outputDir, 'Context', 'Projects', 'apollo', 'PROJECT.md');
    expect(existsSync(apollo)).toBe(true);

    // The operator removes one entity and keeps the rest — an ordinary edit, and
    // the case a backstop must not stand in the way of.
    writeFileSync(ws.configPath, AGENT_CONFIG, 'utf8');

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    expect(existsSync(apollo)).toBe(false);
    expect(existsSync(join(ws.outputDir, 'Context', 'Projects'))).toBe(false);
    expect(existsSync(join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md'))).toBe(true);
    expect(run.output).toMatch(/Cleanup: removed/);
    expect(run.output).not.toMatch(/cleanup skipped/);
    expect(run.status).toBe(0);
  });
});

describe('a workspace with more than one plain connected server', () => {
  it('replays them all, and every one of them keeps its rendered layout', async () => {
    // Two MCP servers connected without a described schema of their own share ONE
    // flat table between them. The reconstruction used to skip a repeat TOOLKIT,
    // which these are not — two different per-connection toolkits that resolve to
    // the same table — so the table arrived twice, defining its rendered layout
    // the second time raised, and every model listed after it ended the open with
    // a registered table and no layout at all. A registered table with no layout
    // is worse than a missing one: the schema looks complete, and the next
    // reconciliation reads that source's rendered tree as removed.
    const ws = makeWorkspace('two-plain-servers', AGENT_CONFIG);

    // A typed server, connected first, whose tables ARE described. It is the one
    // with something to lose: it sorts ahead of the duplicate pair in the list.
    setMcpSchemaDescriptor('typed-1', {
      version: 2,
      prefix: 'widgets',
      kinds: [
        {
          kind: 'orders',
          tool: 'list_orders',
          naturalKey: 'id',
          columns: [{ name: 'title', sqlSpec: 'TEXT' }],
        },
      ],
    });
    const typedTable = mcpTableName('widgets', 'orders');

    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'mcp',
        toolkit: 'mcp:typed-1',
        displayName: 'widgets-mcp',
      });
      const typed = genericConnector().models('mcp:typed-1');
      expect(typed.map((m) => m.table)).toEqual([typedTable]);
      for (const m of typed) await db.defineLate(m.table, m.definition);
      addCanonicalContext(db, typed);
      await db.insert(typedTable, { id: 'o1', title: 'First Order' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const firstOrder = join(
      ws.outputDir,
      'Mcp_widgets_orders',
      'first-order',
      'MCP_WIDGETS_ORDER.md',
    );
    expect(existsSync(firstOrder)).toBe(true);

    // The operator now adds two ordinary servers, neither of which describes its
    // schema. Both resolve to the same flat table.
    await asTheApp(ws, async (db) => {
      await createConnector(db, {
        connector: 'mcp',
        toolkit: 'mcp:plain-a',
        displayName: 'first-plain',
      });
      await createConnector(db, {
        connector: 'mcp',
        toolkit: 'mcp:plain-b',
        displayName: 'second-plain',
      });
    });

    // Any later open — the app, a command, an embedder. The replay must complete.
    const warnings: string[] = [];
    const saidWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '));
    try {
      await asTheApp(ws, async (db) => {
        expect(db.getRegisteredTableNames()).toContain(typedTable);
        expect(db.getRegisteredTableNames()).toContain('mcp_items');
        // Both tables registered AND both holding the rendered layout that keeps
        // their trees alive.
        expect([...db.entityContexts().keys()]).toContain(typedTable);
        expect([...db.entityContexts().keys()]).toContain('mcp_items');

        const cleanup = await db.reconcile(ws.outputDir, {
          removeOrphanedDirectories: true,
          removeOrphanedFiles: true,
        });
        expect(cleanup.cleanup.directoriesRemoved).toEqual([]);
        expect(cleanup.cleanup.filesRemoved).toEqual([]);
      });
    } finally {
      console.warn = saidWarn;
    }

    expect(warnings.join('\n')).not.toMatch(/already defined/);
    expect(warnings.join('\n')).not.toMatch(/replay/);
    // The typed server's tree is exactly where it was.
    expect(existsSync(firstOrder)).toBe(true);
  });
});

describe('a connected source whose table came back without its rendered layout', () => {
  it('is refused, not swept — the table being known is not the question', async () => {
    // The state this whole check exists for, reached the way it is really reached:
    // something registers the connected TABLE and not its rendered CONTEXT. That is
    // what the retired restoration modules did, and what any partial replay leaves
    // behind. Cleanup deletes on the absence of a context, so asking whether the
    // TABLE is registered answers a different question than the one that decides
    // the deletion — and this workspace slid straight through it.
    const ws = makeWorkspace('table-without-layout', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:half-1',
        displayName: 'shop-db',
      });
      await db.defineLate('db_shop_orders', orders);
      addCanonicalContext(db, [{ table: 'db_shop_orders', definition: orders }]);
      await db.insert('db_shop_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_shop_orders', 'order-one', 'DB_SHOP_ORDER.md');
    const rollup = join(ws.outputDir, 'connectors', 'db', 'orders.md');
    expect(existsSync(order)).toBe(true);

    // A later session — the published entry point, exactly as an embedder drives
    // it — brings the TABLE back and nothing else, then reconciles.
    const db = new Lattice({ config: ws.configPath }, { encryptionKey: ENCRYPTION_KEY });
    registerNativeEntities(db);
    await db.init();
    let result;
    try {
      await db.defineLate('db_shop_orders', orders);
      expect(db.getRegisteredTableNames()).toContain('db_shop_orders');
      expect([...db.entityContexts().keys()]).not.toContain('db_shop_orders');
      result = await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    } finally {
      db.close();
    }

    expect(result.cleanup.directoriesRemoved).toEqual([]);
    expect(result.cleanup.filesRemoved).toEqual([]);
    expect(result.cleanup.warnings.join('\n')).toMatch(/cleanup skipped/);
    expect(result.cleanup.warnings.join('\n')).toMatch(/shop-db/);
    expect(existsSync(order)).toBe(true);
    expect(existsSync(rollup)).toBe(true);
  });
});

describe('a workspace that really did delete its last table', () => {
  it('says so once and the leftover tree is swept, instead of being stuck forever', async () => {
    // The refusal for "this workspace renders no layout of its own" cannot tell a
    // layout that never loaded from one that was emptied on purpose — the config
    // is the same file either way. Left at that, deleting your last table wedges
    // the workspace: it stops rendering as well as sweeping, the stale tree can
    // never be cleared, and every run exits non-zero with no way forward.
    const ws = makeWorkspace('last-table-deleted', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const alpha = join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md');
    expect(existsSync(alpha)).toBe(true);

    writeFileSync(ws.configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');

    // Unasked, it still refuses — the protection is not weakened by having a way out.
    const guarded = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(guarded.output).toMatch(/cleanup skipped/);
    expect(guarded.status).not.toBe(0);
    expect(existsSync(alpha)).toBe(true);
    // ...and it names the way out rather than only repeating advice already taken.
    expect(guarded.output).toMatch(/--layout-emptied/);

    const told = runCli([
      'reconcile',
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--layout-emptied',
    ]);
    expect(told.output).not.toMatch(/cleanup skipped/);
    expect(told.output).toMatch(/Cleanup: removed/);
    expect(told.status).toBe(0);
    expect(existsSync(alpha)).toBe(false);
    expect(existsSync(join(ws.outputDir, 'agents.md'))).toBe(false);
  });

  it('still protects a connected source even when the emptying was intended', async () => {
    // Saying "I emptied my layout" says nothing about somebody else's tables, so
    // the escape must not become a way to delete a connected source's tree.
    const ws = makeWorkspace('emptied-with-connected', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:kept-1',
        displayName: 'kept-db',
      });
      await db.defineLate('db_kept_orders', orders);
      addCanonicalContext(db, [{ table: 'db_kept_orders', definition: orders }]);
      await db.insert('db_kept_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_kept_orders', 'order-one', 'DB_KEPT_ORDER.md');
    expect(existsSync(order)).toBe(true);

    writeFileSync(ws.configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');

    const run = runCli([
      'reconcile',
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--layout-emptied',
    ]);

    expect(run.output).toMatch(/cleanup skipped/);
    expect(run.output).toMatch(/kept-db/);
    expect(run.status).not.toBe(0);
    expect(existsSync(order)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The plainest workspace of all: tables that render ONE file each, and no
// per-record directories.
//
// Nothing here declares a per-record layout, so the previous render recorded no
// entity context — and the check that is supposed to stop a half-loaded process
// from emptying a directory read that as "there is no baseline here, nothing can
// be wrongly swept" and stood aside. The sweep that runs afterwards does not
// share that opinion: a rendered file whose table the process no longer knows is
// retired and deleted. So the shape with the least structure to lose had the
// least protection, and lost all of it, reporting success on the way out.
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
  'db: ./lattice.db',
  'entities:',
  '  agents:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: AGENT.md',
  '  projects:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      slug: { type: text }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: PROJECT.md',
  '',
].join('\n');

const NO_LAYOUT_CONFIG = 'db: ./lattice.db\nentities: {}\n';

describe('a workspace that renders single files and no per-record directories', () => {
  it('is not emptied by a reconciliation whose config lost the layout', async () => {
    const ws = makeWorkspace('single-file-layout-lost', SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);
    expect(readFileSync(rendered, 'utf8')).toMatch(/Alpha/);

    // The layout goes missing, exactly as it does for a shared workspace whose
    // published layout has not arrived on this machine.
    writeFileSync(ws.configPath, NO_LAYOUT_CONFIG, 'utf8');

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    expect(existsSync(rendered)).toBe(true);
    expect(readFileSync(rendered, 'utf8')).toMatch(/Alpha/);
    expect(run.output).not.toMatch(/Cleanup: removed/);
    expect(run.output).toMatch(/cleanup skipped/);
    expect(run.output).toMatch(/renders no layout of its own/);
    expect(run.status).not.toBe(0);
  });

  it('still has a genuinely dropped table swept, and reports success', async () => {
    // The other half of being right: one table removed and the rest kept is an
    // ordinary edit, and refusing it would leave a stale file behind forever.
    const ws = makeWorkspace('single-file-genuine-drop', TWO_SINGLE_FILE_CONFIG);
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
    expect(existsSync(agents)).toBe(true);
    expect(existsSync(projects)).toBe(true);

    writeFileSync(ws.configPath, SINGLE_FILE_CONFIG, 'utf8');

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    expect(existsSync(projects)).toBe(false);
    expect(existsSync(agents)).toBe(true);
    expect(run.output).toMatch(/Cleanup: removed/);
    expect(run.output).not.toMatch(/cleanup skipped/);
    expect(run.status).toBe(0);
  });

  it('is swept when the operator says the emptying was intended', async () => {
    // Left at a refusal, deleting your last single-file table would wedge the
    // workspace: nothing renders, nothing sweeps, and the stale file stays
    // forever. The stated way out has to work for this shape too.
    const ws = makeWorkspace('single-file-emptied-on-purpose', SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);

    writeFileSync(ws.configPath, NO_LAYOUT_CONFIG, 'utf8');

    // Unasked, it refuses — and names the way out.
    const guarded = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(guarded.output).toMatch(/cleanup skipped/);
    expect(guarded.output).toMatch(/--layout-emptied/);
    expect(guarded.status).not.toBe(0);
    expect(existsSync(rendered)).toBe(true);

    const told = runCli([
      'reconcile',
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--layout-emptied',
    ]);
    expect(told.output).not.toMatch(/cleanup skipped/);
    expect(told.output).toMatch(/Cleanup: removed/);
    expect(told.status).toBe(0);
    expect(existsSync(rendered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A refusal has to survive the things that happen BETWEEN two reconciliations.
//
// The refusal is computed against the record of what was last rendered here, and
// the thing that rewrites that record is a RENDER. So every way of reaching a
// render is a way of clearing the protection, and only the ones that end in a
// sweep were putting the record back.
// ---------------------------------------------------------------------------

describe('a render between two reconciliations', () => {
  it('does not clear the refusal — the next reconcile still keeps the tree', async () => {
    // The command an operator reaches for NEXT, precisely because the refusal
    // makes reconcile render nothing. One of these used to be enough: the render
    // wrote a record without the table it does not know, so the reconcile after
    // it had nothing left to object to, deleted the file, and said so at exit 0.
    const ws = makeWorkspace('render-between-reconciles', SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);

    writeFileSync(ws.configPath, NO_LAYOUT_CONFIG, 'utf8');

    const first = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(first.output).toMatch(/cleanup skipped/);
    expect(first.status).not.toBe(0);
    expect(existsSync(rendered)).toBe(true);

    // A plain render — no sweep anywhere in it.
    const rendering = runCli(['render', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(rendering.status).toBe(0);
    // The record it wrote still knows about the table it does not understand,
    // which is the whole reason the next run has something to refuse over.
    expect(Object.keys(readManifest(ws.outputDir)?.tableFiles ?? {})).toContain('agents');

    const second = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(second.output).toMatch(/cleanup skipped/);
    expect(second.output).not.toMatch(/Cleanup: removed/);
    expect(second.status).not.toBe(0);
    expect(existsSync(rendered)).toBe(true);
    expect(readFileSync(rendered, 'utf8')).toMatch(/Alpha/);
  });

  it('keeps the per-record tree too, and leaves nothing untracked behind', async () => {
    // The same hazard for the other shape. Losing the entity-context record does
    // worse than delete the rollup: the directory tree it names stops being
    // recorded by anything at all, so no later pass can even find it to sweep.
    const ws = makeWorkspace('render-between-reconciles-contexts', AGENT_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const alpha = join(ws.outputDir, 'Context', 'Agents', 'alpha', 'AGENT.md');
    const rollup = join(ws.outputDir, 'agents.md');
    expect(existsSync(alpha)).toBe(true);

    writeFileSync(ws.configPath, NO_LAYOUT_CONFIG, 'utf8');

    runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    runCli(['render', '--config', ws.configPath, '--output', ws.outputDir]);

    const manifest = readManifest(ws.outputDir);
    expect(Object.keys(manifest?.entityContexts ?? {})).toContain('agent');
    expect(Object.keys(manifest?.tableFiles ?? {})).toContain('agent');

    const after = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(after.output).toMatch(/cleanup skipped/);
    expect(after.status).not.toBe(0);
    expect(existsSync(alpha)).toBe(true);
    expect(existsSync(rollup)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A pass that cannot delete anything.
// ---------------------------------------------------------------------------

describe('a reconciliation that could not delete anything even if it were allowed', () => {
  it('reports what is at stake instead of nothing at all', async () => {
    // A dry run is the command somebody reaches for to find out what a refusal is
    // about. Refused as a whole pass, it answered with an empty render and a
    // failure — no rendered output, no orphan list, nothing to act on. It removes
    // nothing either way, so there is no deletion to refuse: it runs, names the
    // file a real sweep would take, and says why a real sweep will not take it.
    const ws = makeWorkspace('dry-run-reports', SINGLE_FILE_CONFIG);
    await asTheApp(ws, async (db) => {
      await db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);

    writeFileSync(ws.configPath, NO_LAYOUT_CONFIG, 'utf8');

    const dry = runCli([
      'reconcile',
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--dry-run',
    ]);
    // It names the file at stake...
    expect(dry.output).toMatch(/AGENT\.md/);
    // ...in the tense that is true of a run that deletes nothing...
    expect(dry.output).toMatch(/would remove/i);
    expect(dry.output).not.toMatch(/✓ Removed/);
    // ...and still says why an ordinary run will not do it.
    expect(dry.output).toMatch(/cleanup skipped/);
    expect(existsSync(rendered)).toBe(true);

    // And the dry run must not have DISARMED anything on its way through: it
    // renders, and a render rewrites the record the refusal stands on.
    const after = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(after.output).toMatch(/cleanup skipped/);
    expect(after.output).not.toMatch(/Cleanup: removed/);
    expect(after.status).not.toBe(0);
    expect(existsSync(rendered)).toBe(true);
  });

  it('still RENDERS with both sweeps turned off, rather than refusing the whole pass', async () => {
    // Turning cleanup off does not ask for the rest of the command to stop. The
    // refusal was reached before the render and without reference to any of this,
    // so a pass that was never going to delete anything wrote nothing either —
    // and the data the operator asked to be written to disk stayed unwritten.
    //
    // The refusal here comes from a source that cannot be reconstructed on this
    // machine, so the workspace keeps its own layout and the render has real work
    // to do. That is what makes "it rendered" observable rather than a matter of
    // reading the same "0 files" from either behaviour.
    const ws = makeWorkspace('sweeps-disabled', AGENT_CONFIG);
    const orders: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'connectors/db/orders.md',
    };
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:absent-3',
        displayName: 'shop-db',
      });
      await db.defineLate('db_shop_orders', orders);
      addCanonicalContext(db, [{ table: 'db_shop_orders', definition: orders }]);
      await db.insert('db_shop_orders', { id: 'o1', name: 'Order One' });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    const order = join(ws.outputDir, 'Db_shop_orders', 'order-one', 'DB_SHOP_ORDER.md');
    expect(existsSync(order)).toBe(true);

    // A second row, which only reaches disk if this pass actually renders.
    await asTheApp(ws, async (db) => {
      await db.insert('agent', { id: 'a2', slug: 'bravo', name: 'Bravo' });
    });
    const bravo = join(ws.outputDir, 'Context', 'Agents', 'bravo', 'AGENT.md');
    expect(existsSync(bravo)).toBe(false);

    const run = runCli([
      'reconcile',
      '--config',
      ws.configPath,
      '--output',
      ws.outputDir,
      '--no-orphan-dirs',
      '--no-orphan-files',
    ]);

    expect(existsSync(bravo)).toBe(true);
    expect(run.output).toMatch(/Rendered [1-9]/);
    // Still refused, still nothing removed — turning the sweeps off does not make
    // the workspace any better understood.
    expect(run.output).toMatch(/cleanup skipped/);
    expect(run.output).not.toMatch(/Cleanup: removed/);
    expect(existsSync(order)).toBe(true);

    // Same durability requirement: this pass rendered, so it rewrote the record.
    const after = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);
    expect(after.output).toMatch(/cleanup skipped/);
    expect(after.output).not.toMatch(/Cleanup: removed/);
    expect(after.status).not.toBe(0);
    expect(existsSync(order)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A workspace the browser has opened, reconciled from the terminal.
//
// The browser registers bookkeeping tables a command never registers — per-entity
// metadata, per-column metadata, a machine identity row, an audit log, the native
// binding registry. Every one renders a file, so the record the browser leaves
// names tables no command will ever declare. Read as the workspace's own layout,
// they are five outputs it appears to have dropped — and paired with any source
// that cannot be reconstructed locally, that refused the command outright.
// ---------------------------------------------------------------------------

describe('a workspace the browser has opened', () => {
  it('is still reconcilable from the terminal, and its own layout is untouched', async () => {
    const ws = makeWorkspace('browser-then-terminal', SINGLE_FILE_CONFIG);
    const active = await openConfig(ws.configPath, ws.outputDir, false);
    try {
      await active.db.insert('agents', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      // A connected source whose tables cannot be worked out on this machine —
      // the ordinary state on a second machine, and what turns any unexplained
      // rendered output into a refusal.
      await createConnector(active.db, {
        connector: 'db_source',
        toolkit: 'db_source:absent-1',
        displayName: 'shop-db',
      });
      await active.db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    } finally {
      await disposeActive(active);
    }

    // The browser really did record bookkeeping tables no command declares.
    const recorded = Object.keys(readManifest(ws.outputDir)?.tableFiles ?? {});
    expect(recorded).toContain('_lattice_gui_audit');
    expect(recorded).toContain('__lattice_user_identity');

    const rendered = join(ws.outputDir, 'AGENT.md');
    expect(existsSync(rendered)).toBe(true);

    const run = runCli(['reconcile', '--config', ws.configPath, '--output', ws.outputDir]);

    // The command works. It is not refused over internal bookkeeping the operator
    // cannot act on, in a message that names tables they have never heard of.
    expect(run.output).not.toMatch(/cleanup skipped/);
    expect(run.output).not.toMatch(/_lattice_gui/);
    expect(run.status).toBe(0);
    // ...and the workspace's OWN rendered layout is exactly where it was.
    expect(existsSync(rendered)).toBe(true);
    expect(readFileSync(rendered, 'utf8')).toMatch(/Alpha/);
  });
});

// ---------------------------------------------------------------------------
// Multi-output renders.
//
// A multi is recorded under the name it was DECLARED with, which is an arbitrary
// label — never a table name, and nothing registers a table by it. Compared
// against the live tables, every live multi read as output the workspace had
// dropped; and the repair that makes a refusal durable rebuilt the record
// without the multi's half of it, so the refusal it did produce lasted one pass.
// The two faults hid each other: one refused when it should not, the other
// stopped refusing when it should.
// ---------------------------------------------------------------------------

/** A per-key multi over `agent`, as an embedder declares one. */
function defineAgentBriefs(db: Lattice): void {
  db.defineMulti('agent-context', {
    tables: ['agent'],
    keys: () => db.query('agent', {}),
    outputFile: (key: Row) => `Briefs/${String(key.slug)}.md`,
    render: (key: Row) => `# ${String(key.name)}\n`,
  });
}

describe('a workspace whose layout includes a multi-output render', () => {
  it('is not refused over the multi it still declares', async () => {
    // Nothing about the multi changed between the two passes and it is still
    // declared, so there is nothing here to refuse. Held against the live TABLES
    // it never matched anything, and the connected source that cannot be
    // reconstructed turned that into a standing refusal of every pass — one that
    // --layout-emptied cannot clear, because it answers a different question.
    const ws = makeWorkspace('multi-still-declared', AGENT_CONFIG);
    const openWithMulti = async (body: (db: Lattice) => Promise<void>): Promise<void> => {
      const db = new Lattice({ config: ws.configPath }, { encryptionKey: ENCRYPTION_KEY });
      registerNativeEntities(db);
      defineAgentBriefs(db);
      await db.init();
      try {
        await body(db);
      } finally {
        db.close();
      }
    };

    await openWithMulti(async (db) => {
      await db.insert('agent', { id: 'a1', slug: 'alpha', name: 'Alpha' });
      await db.insert('agent', { id: 'a2', slug: 'bravo', name: 'Bravo' });
      await createConnector(db, {
        connector: 'db_source',
        toolkit: 'db_source:absent-2',
        displayName: 'Warehouse',
      });
      await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });
    expect(existsSync(join(ws.outputDir, 'Briefs', 'alpha.md'))).toBe(true);
    expect(existsSync(join(ws.outputDir, 'Briefs', 'bravo.md'))).toBe(true);

    // One row goes. Its brief is a genuine orphan and must be swept — which is
    // the half a standing refusal was also costing, on every pass, forever.
    let result;
    await openWithMulti(async (db) => {
      await db.delete('agent', 'a2');
      result = await db.reconcile(ws.outputDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    });

    expect(result!.cleanup.warnings.join('\n')).not.toMatch(/cleanup skipped/);
    expect(existsSync(join(ws.outputDir, 'Briefs', 'alpha.md'))).toBe(true);
    expect(existsSync(join(ws.outputDir, 'Briefs', 'bravo.md'))).toBe(false);
  });

  it('is refused on EVERY pass once the layout is lost, not just the first', async () => {
    // A workspace whose whole rendered baseline is a multi. The refusal held for
    // one pass and then cleared itself: the write that was supposed to preserve
    // the record rebuilt it without the multi, so the next pass found no baseline
    // at all, refused nothing, and swept the tree without a word.
    const ws = makeWorkspace('multi-baseline-layout-lost', NO_LAYOUT_CONFIG);
    const db = new Lattice({ config: ws.configPath }, { encryptionKey: ENCRYPTION_KEY });
    registerNativeEntities(db);
    db.defineMulti('agent-context', {
      keys: () => Promise.resolve([{ slug: 'alpha', name: 'Alpha' }]),
      outputFile: (key: Row) => `Briefs/${String(key.slug)}.md`,
      render: (key: Row) => `# ${String(key.name)}\n`,
    });
    await db.init();
    try {
      await db.render(ws.outputDir);
    } finally {
      db.close();
    }
    const brief = join(ws.outputDir, 'Briefs', 'alpha.md');
    expect(existsSync(brief)).toBe(true);
    expect(Object.keys(readManifest(ws.outputDir)?.multiFiles ?? {})).toContain('agent-context');

    // Every later pass by a process that does not hold the multi — the shape of
    // an open, exactly as one runs: render, then reconcile against what the
    // previous render recorded.
    for (const attempt of [1, 2, 3]) {
      const refusals: string[] = [];
      await asTheApp(ws, async (narrow) => {
        narrow.setRenderNoticeHandler((m) => {
          if (m.includes('cleanup skipped')) refusals.push(m);
        });
        const prev = readManifest(ws.outputDir);
        await narrow.render(ws.outputDir);
        const swept = await narrow.reconcileRenderedTree(
          ws.outputDir,
          prev,
          readManifest(ws.outputDir),
        );
        expect(swept.filesRemoved, `pass ${String(attempt)}`).toEqual([]);
        expect(swept.warnings.join('\n'), `pass ${String(attempt)}`).toMatch(/cleanup skipped/);
      });
      expect(refusals.length, `pass ${String(attempt)}`).toBeGreaterThan(0);
      expect(existsSync(brief), `pass ${String(attempt)}`).toBe(true);
      // The record still carries the multi's half — which is what keeps the
      // objection TRUE on the pass after this one rather than merely repeated.
      expect(
        Object.keys(readManifest(ws.outputDir)?.multiFiles ?? {}),
        `pass ${String(attempt)}`,
      ).toContain('agent-context');
    }
  });
});
