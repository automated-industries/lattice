/**
 * THE ACCEPTANCE TEST: the whole product, start to finish, with no server.
 *
 * Every other guard in this tree checks a PROPERTY of the code — that a
 * capability never imports an adapter, that every state-changing route says what
 * its headless equivalent is. Those are necessary and they are structural: they
 * are satisfied by a tree in which each piece is individually reachable and the
 * pieces do not actually compose into a usable product. Somebody can pass both
 * of them and still be unable to stand a workspace up, put data in it, share it,
 * and ask it a question without opening a browser.
 *
 * So this test does not inspect the tree. It USES the product, as one continuous
 * story, through the command modules and the published library surface:
 *
 *    1. a root, and a workspace in it
 *    2. a spreadsheet imported, with the rows landing in a real table
 *    3. a schema change — a table and a link — reversed again afterwards
 *    4. the workspace moved onto a shared Postgres
 *    5. secured, with the file index and the secret store PROVEN covered
 *    6. a member invited, and the invite redeemed on a second machine
 *    7. that member reading what was shared, and refused what was not
 *    8. the assistant running a turn, its write reversible as ONE action
 *    9. the health check reporting a workspace a deploy gate would accept
 *
 * and then asserts, from a spy that was in force for all of it, that
 * `startGuiServer` was never called and no browser was ever opened. That
 * assertion is the point of the file. A journey that merely AVOIDS the server
 * proves nothing — you can write one by not calling it. This one would have
 * counted the call, and reports zero.
 *
 * HOW IT FAILS, which is what a test is for. Make any of these steps need the
 * browser app again — move an operation back inside a request handler, take a
 * command away, put a click in the middle of joining a cloud — and the step that
 * needs it fails here, by name and by number, before anybody ships it. The nine
 * steps are numbered in their titles for exactly that reason: the failure names
 * the part of the promise that broke.
 *
 * WHAT IS DELIBERATELY NOT HERE is recorded in {@link NOT_EXERCISED} rather than
 * left out quietly. Three things in the product genuinely cannot happen in a
 * test process, and each is a property of the CLIENT rather than of the
 * operation — a person has to be asked, an operating-system dialog has to open,
 * a desktop shell has to replace itself on disk. They are named, with reasons,
 * and the list is asserted, so "we skipped it" can never quietly become "we
 * forgot it".
 *
 * Postgres-gated where — and ONLY where — it needs a cloud. Steps 1-3 and 8-9
 * run everywhere; steps 4-7 need real login roles, which SQLite cannot model, so
 * they run against the disposable Postgres the suite provisions. Every database,
 * role, root and config directory below is created by this file and dropped
 * again at the end; nothing here touches a live cloud or a real machine's
 * configuration.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── The guard the whole file exists to satisfy ─────────────────────────────
//
// Installed BEFORE anything else is imported, so it is in force for every line
// of the journey. `startGuiServer` and `openUrl` are replaced by recorders that
// also THROW: a call is both counted and fatal, so a step that quietly started a
// server could not proceed to report success. Nothing in the journey imports
// this module — which is itself the finding — so the sentinel is checked at the
// end to prove the replacement was really in place rather than never reached.

const serverGuard = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../src/gui/server.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/server.js')>();
  return {
    ...actual,
    __journeyGuard: true,
    startGuiServer: (): never => {
      serverGuard.calls.push('startGuiServer');
      throw new Error('the headless journey started the browser app');
    },
    openUrl: (): never => {
      serverGuard.calls.push('openUrl');
      throw new Error('the headless journey opened a browser');
    },
  };
});

// The model, stubbed at the one seam between the assistant turn and the network.
// Everything below it — the tool dispatcher, the mutation chokepoint, the audit
// log — is the real thing. `undefined` means "ask the real resolver", which
// against an isolated configuration directory is a machine with nothing
// connected.
const scriptedModel = vi.hoisted(() => ({ provider: undefined as unknown }));

vi.mock('../../src/gui/ai/provider.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/provider.js')>();
  return {
    ...actual,
    resolveLlmProvider: async (db: Parameters<typeof actual.resolveLlmProvider>[0]) =>
      scriptedModel.provider === undefined
        ? await actual.resolveLlmProvider(db)
        : (scriptedModel.provider as Awaited<ReturnType<typeof actual.resolveLlmProvider>>),
  };
});

import { Lattice } from '../../src/lattice.js';
import { runWorkspaceCommand } from '../../src/cli-workspace.js';
import { runImportCommand } from '../../src/cli-import.js';
import { runSchemaCommand } from '../../src/cli-schema.js';
import { runCloudCommand, type CloudCommandArgs } from '../../src/cli-cloud.js';
import { runAskCommand, commandLineSessionId } from '../../src/cli-ask.js';
import { openConfiguredLattice } from '../../src/cli-open.js';
import { ensureRootAt } from '../../src/framework/lattice-root.js';
import {
  listWorkspaces,
  readRegistry,
  resolveWorkspacePaths,
  findWorkspaceByConfigPath,
} from '../../src/framework/workspace.js';
import { NATIVE_ENTITY_NAMES } from '../../src/framework/native-entities.js';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
// Through the PACKAGE, not the source tree. Reversing a schema change is the
// point of step 3, and reaching it by a path only this repository has would
// prove a capability a consumer does not have — the exact claim the manifest
// exists to stop. If this import ever has to become a deep one again, the
// capability is gone.
import { applySchemaConfig } from '../../src/index.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import { createUserEntity } from '../../src/gui/schema-ops.js';
import { getGuiEntities } from '../../src/gui/data.js';
import { parseAudit, undoGroup } from '../../src/gui/mutations.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { LlmClient, TurnParams, TurnResult } from '../../src/gui/ai/chat.js';
import type { ResolvedProvider } from '../../src/gui/ai/provider.js';
import { cloudStatus } from '../../src/cloud/status.js';
import { redeemInviteToken } from '../../src/cloud/invite.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { formatHealthReport } from '../../src/search/doctor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PG_URL = process.env.LATTICE_TEST_PG_URL;

// ── What is deliberately not exercised, and why ─────────────────────────────

/**
 * Steps of the product this journey does NOT perform, each with the reason it
 * cannot happen inside a test process.
 *
 * Written down rather than omitted. An acceptance test that silently leaves out
 * the awkward parts reports a completeness it never checked, and the awkward
 * parts are exactly the ones a reader would want listed. Each reason has to be a
 * sentence — the same bar the route census puts on a permanent browser-only
 * claim — because a one-word reason is how a real gap gets filed as an
 * impossibility.
 *
 * All three are properties of the CLIENT rather than of the operation: somebody
 * has to be asked, an operating-system dialog has to open, or a desktop shell
 * has to replace itself on disk and restart. None of them is a capability a
 * script is missing.
 */
const NOT_EXERCISED: { step: string; reason: string }[] = [
  {
    step: 'applying a desktop update',
    reason:
      'Applying an update replaces the running desktop application on disk and restarts it; a ' +
      'test process cannot be the thing that gets replaced, and faking the replacement would ' +
      'test the fake. Checking FOR an update is a different operation and is exercised as one.',
  },
  {
    step: 'an interactive consent screen',
    reason:
      'Device-code sign-in and an OAuth callback both require a person to read a screen and ' +
      'agree; there is nobody in this process to agree, and stubbing the agreement would ' +
      'assert nothing about the consent it stands in for.',
  },
  {
    step: 'choosing a folder from the operating system picker',
    reason:
      'The picker is a native dialog owned by the desktop shell; a headless caller names the ' +
      'path it wants instead, which is the path this journey takes when it hands a file to the ' +
      'importer by name.',
  },
];

/** The bar a reason has to clear, mirroring the route census. */
const MIN_REASON = 40;

// ── Scratch state ──────────────────────────────────────────────────────────

const scratchDirs: string[] = [];
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lattice-journey-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** One machine: where its credentials live and which root holds its registry. */
interface Machine {
  configDir: string;
  root: string;
  email: string;
}

/**
 * The state the journey accumulates, step by step.
 *
 * Shared deliberately: this is ONE story told in nine parts, not nine
 * independent cases, and a step that cannot find what the previous step
 * produced must fail loudly rather than skip. {@link need} is what makes that
 * happen.
 */
interface World {
  owner: Machine;
  member: Machine;
  configPath?: string;
  contextDir?: string;
  importedTable?: string;
  sharedPk?: string;
  privatePk?: string;
  /** Every step that ran to completion, by number. */
  completed: number[];
}

let world: World;

/** A value a later step depends on — absent means the story broke, not that it is optional. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the journey has no ${what} — an earlier step did not complete`);
  }
  return value;
}

/** Run `fn` as `machine`: its credential store, its root, its identity. */
async function onMachine<T>(machine: Machine, fn: () => Promise<T>): Promise<T> {
  const before = {
    cfg: process.env.LATTICE_CONFIG_DIR,
    root: process.env.LATTICE_ROOT,
    email: process.env.LATTICE_USER_EMAIL,
  };
  process.env.LATTICE_CONFIG_DIR = machine.configDir;
  process.env.LATTICE_ROOT = machine.root;
  process.env.LATTICE_USER_EMAIL = machine.email;
  try {
    return await fn();
  } finally {
    restore('LATTICE_CONFIG_DIR', before.cfg);
    restore('LATTICE_ROOT', before.root);
    restore('LATTICE_USER_EMAIL', before.email);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of [
    'LATTICE_CONFIG_DIR',
    'LATTICE_ROOT',
    'LATTICE_USER_EMAIL',
    'LATTICE_SEED_WELCOME',
    'LATTICE_CHAT_AUTOINGEST',
    'LATTICE_CLOUD_URL',
    'ANTHROPIC_API_KEY',
  ]) {
    savedEnv[key] = process.env[key];
  }
  // A new workspace starts empty, so the journey's own rows are the only rows,
  // and the assistant turn is about the tool loop rather than the pre-pass that
  // files reference material out of a message.
  process.env.LATTICE_SEED_WELCOME = '0';
  process.env.LATTICE_CHAT_AUTOINGEST = 'false';
  // No ambient credential may reach the assistant: the stub is the only model.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LATTICE_CLOUD_URL;

  const ownerHome = scratch('owner');
  const memberHome = scratch('member');
  world = {
    owner: {
      configDir: join(ownerHome, 'config'),
      root: join(ownerHome, 'root'),
      email: 'owner@example.test',
    },
    member: {
      configDir: join(memberHome, 'config'),
      root: join(memberHome, 'root'),
      email: 'newcomer@example.test',
    },
    completed: [],
  };
  for (const m of [world.owner, world.member]) mkdirSync(m.configDir, { recursive: true });
  // The process default is the owner's machine; the member's is entered
  // explicitly, so nothing can drift onto it by accident.
  process.env.LATTICE_CONFIG_DIR = world.owner.configDir;
  process.env.LATTICE_ROOT = world.owner.root;
  process.env.LATTICE_USER_EMAIL = world.owner.email;
});

afterAll(async () => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // Best-effort teardown: a connection the journey already closed is fine.
    }
  }
  if (PG_URL) {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    for (const role of roles.splice(0)) {
      await admin.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
    for (const name of databases.splice(0)) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
    }
    await admin.end();
  }
  for (const [key, value] of Object.entries(savedEnv)) restore(key, value);
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Helpers the steps use ──────────────────────────────────────────────────

/** A throwaway Postgres on the harness's server, dropped at the end. */
async function blankDatabase(): Promise<string> {
  const name = `lattice_journey_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  databases.push(name);
  return name;
}

function dbUrl(name: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

/** A small real workbook: one sheet, three rows, both text and numeric columns. */
async function writeWorkbook(): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Expenses');
  sheet.getRow(1).values = [null, 'Description', 'Amount', 'Category'];
  sheet.getRow(2).values = [null, 'Coffee beans for the office', 42, 'Supplies'];
  sheet.getRow(3).values = [null, 'Replacement keyboard', 89, 'Equipment'];
  sheet.getRow(4).values = [null, 'Domain renewal', 15, 'Software'];
  const path = join(scratch('book'), 'expenses.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/**
 * Open the journey's workspace the way every command opens one — and NOTHING
 * else.
 *
 * The open deliberately returns before its background convergence has finished,
 * because the owner does not depend on that work. This helper used to wait for it
 * anyway, and that wait was load-bearing: without it the two raced for the same
 * connection and the schema step died on a transaction collision. Waiting is not
 * something the published surface asks a caller to do, so a journey that did it
 * was certifying a product nobody else can run. The wait belongs on the
 * connection, where it now is; this open is the one a script writes.
 */
async function openJourney(): Promise<ActiveDb> {
  return openConfig(need(world.configPath, 'workspace'), need(world.contextDir, 'context tree'));
}

/** The tables holding the journey's own data — the framework's own are not ours. */
function dataTables(active: ActiveDb): string[] {
  return [...active.validTables]
    .filter((t) => !NATIVE_ENTITY_NAMES.has(t) && t !== 'files')
    .filter((t) => !active.junctionTables.has(t) && !active.hiddenLinkTables.has(t))
    .sort();
}

/** Run one cloud verb against the journey's workspace, as the real wrapper does. */
function cloud(args: Partial<CloudCommandArgs>): Promise<string[]> {
  return runCloudCommand({
    configPath: need(world.configPath, 'workspace'),
    latticeRoot: world.owner.root,
    ...args,
  });
}

/** The one line of an invite that actually carries the credential. */
function tokenFrom(lines: string[], email: string): string {
  const carriers = lines
    .map((l) => l.trim())
    .filter((line) => {
      try {
        redeemInviteToken(email, line);
        return true;
      } catch {
        return false;
      }
    });
  expect(carriers, 'exactly one line carries the invite credential').toHaveLength(1);
  return carriers[0]!;
}

/** A model that replays a fixed script, one entry per round. */
function scriptedClient(
  script: { text: string; toolUses?: { id: string; name: string; input: object }[] }[],
): LlmClient & { systems: string[] } {
  const systems: string[] = [];
  let round = 0;
  return {
    systems,
    runTurn(params: TurnParams): Promise<TurnResult> {
      systems.push(params.system);
      const turn = script[Math.min(round, script.length - 1)];
      round += 1;
      const toolUses = turn?.toolUses ?? [];
      for (const ch of turn?.text ?? '') params.onText(ch);
      return Promise.resolve({
        stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
        text: turn?.text ?? '',
        toolUses,
      });
    },
  };
}

function asProvider(client: LlmClient): ResolvedProvider {
  return { client, kind: 'anthropic', authorModel: 'stub-model', noteError: () => 'other' };
}

// ── 1-3: a workspace, data in it, and a schema change taken back ───────────

describe('with no server: a workspace, its data, and its shape', () => {
  it('1. makes a root and a workspace in it', async () => {
    const root = ensureRootAt(world.owner.root);
    const lines = await runWorkspaceCommand({
      root,
      subcommand: 'create',
      action: 'Journey',
    });
    expect(lines.join('\n')).toContain('Created workspace "Journey"');

    const [record] = listWorkspaces(root);
    expect(record, 'the registry records the workspace the command created').toBeTruthy();
    expect(readRegistry(root).activeWorkspaceId).toBe(record!.id);

    const paths = resolveWorkspacePaths(root, record!);
    expect(existsSync(paths.configPath), 'the workspace file is on disk').toBe(true);
    world.configPath = paths.configPath;
    world.contextDir = paths.contextDir;
    world.completed.push(1);
  });

  it('2. imports a spreadsheet, and the rows are really in a table', async () => {
    const workbook = await writeWorkbook();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runImportCommand(
      {
        target: workbook,
        config: need(world.configPath, 'workspace'),
        explicitConfig: true,
        root: world.owner.root,
      },
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    );
    expect(code, ['import failed:', ...err].join('\n')).toBe(0);
    expect(out.join('\n')).toMatch(/Imported expenses\.xlsx/);

    // The summary is a claim; the rows are the fact. Find the table the import
    // made and read it back through an ordinary open.
    const active = await openJourney();
    try {
      const tables = dataTables(active);
      expect(tables.length, 'the import created at least one table').toBeGreaterThan(0);
      let landed: { table: string; rows: Record<string, unknown>[] } | null = null;
      for (const table of tables) {
        const rows = (await active.db.query(table, {})) as Record<string, unknown>[];
        if (rows.length === 3) landed = { table, rows };
      }
      expect(
        landed,
        `no table holds the workbook's 3 rows (saw: ${tables.join(', ')})`,
      ).toBeTruthy();
      const text = JSON.stringify(landed!.rows);
      expect(text).toContain('Coffee beans for the office');
      expect(text).toContain('Domain renewal');
      world.importedTable = landed!.table;
    } finally {
      await disposeActive(active);
    }

    // Declare the imported table searchable. This is a line in the workspace
    // file — the product's own declaration surface, with no server on either
    // side of it — and step 9 needs it: the health check treats a workspace
    // where NOTHING declared search as unassessed rather than healthy, which is
    // the honest answer and not one a deploy gate should pass on.
    //
    // `fts: true` — the whole-table form somebody actually writes, not a
    // hand-picked column list. That distinction is deliberate: this workbook has
    // a numeric column, whole-table selection picks columns by NAME and takes it,
    // and the same declaration then has to survive the move onto Postgres in
    // step 4. Naming only the text columns here would have kept this journey
    // green over a shape no user types.
    const doc = parseYaml(readFileSync(world.configPath!, 'utf8')) as {
      entities: Record<string, { fields?: Record<string, { type?: string }>; fts?: unknown }>;
    };
    const entity = doc.entities[need(world.importedTable, 'imported table')];
    expect(entity, 'the import declared the table it created').toBeTruthy();
    const declared = need(entity, 'declaration for the imported table');
    const numericFields = Object.entries(declared.fields ?? {}).filter(
      ([, def]) => def.type === 'integer' || def.type === 'real',
    );
    expect(
      numericFields.length,
      'the workbook had a non-text column, which is what makes this worth declaring',
    ).toBeGreaterThan(0);
    declared.fts = true;
    writeFileSync(world.configPath!, stringifyYaml(doc), 'utf8');
    world.completed.push(2);
  });

  it('3. adds a table and a link, and takes the link back again', async () => {
    const child = need(world.importedTable, 'imported table');
    const sessionId = commandLineSessionId();

    // The new table, through the library capability the assistant and the data
    // model editor both call.
    const active = await openJourney();
    let created: string | null = null;
    try {
      created = await createUserEntity(active, 'vendors', ['name', 'contact'], sessionId);
    } finally {
      await disposeActive(active);
    }
    expect(created, 'the table was created').toBe('vendors');
    const parent = need(created ?? undefined, 'new table');

    // The link, through the command.
    const linked = await runSchemaCommand({
      configPath: need(world.configPath, 'workspace'),
      contextDir: need(world.contextDir, 'context tree'),
      subcommand: 'link',
      action: child,
      to: parent,
    });
    expect(linked.join('\n')).toContain(`Linked ${child} → ${parent}`);

    const listed = await runSchemaCommand({
      configPath: world.configPath!,
      contextDir: world.contextDir!,
      subcommand: 'links',
    });
    expect(listed.join('\n')).toContain(`${child}.${parent}_id → ${parent}`);

    // And now the part that matters: the change is REVERSIBLE without a server.
    // The schema op was recorded in version history; reversing it is applying
    // that entry's inverse, which is a capability call, not a request.
    let live = await openJourney();
    try {
      const rows = (await live.db.query('_lattice_gui_audit', {
        filters: [{ col: 'operation', op: 'eq', val: 'schema.add_link' }],
        orderBy: 'ts',
        orderDir: 'desc',
        limit: 5,
      })) as Record<string, unknown>[];
      expect(rows.length, 'adding a link is recorded in version history').toBeGreaterThan(0);
      const entry = parseAudit(rows[0]!);
      const reopened = await applySchemaConfig(live, entry, 'inverse', false);
      if (reopened !== live) {
        await disposeActive(live);
        live = reopened;
      }
      await live.db.update('_lattice_gui_audit', String(rows[0]!.id), { undone: 1 });

      const summary = getGuiEntities(live.configPath, live.outputDir).tables.find(
        (t) => t.name === child,
      );
      const stillLinked = Object.values(summary?.relations ?? {}).some(
        (r) => r.type === 'belongsTo' && r.table === parent,
      );
      expect(stillLinked, 'the link is gone after reversing the change').toBe(false);
      // Soft, like every other reversal here: the column and its values stay, so
      // the reversal itself can be reversed.
      expect(await live.db.introspectColumns(child)).toContain(`${parent}_id`);
      expect((await live.db.query(child, {})).length, 'no rows were lost').toBe(3);
    } finally {
      await disposeActive(live);
    }
    world.completed.push(3);
  });
});

// ── 4-7: onto a shared cloud, and a second person on it ────────────────────

describe.skipIf(!PG_URL)('with no server: onto a shared database, and a member on it', () => {
  it('4. moves the workspace onto a shared Postgres', async () => {
    const dbname = await blankDatabase();
    const url = dbUrl(dbname);

    // Piped in rather than passed as an argument: a connection string carries the
    // owner's password, and an argument is readable from the process list.
    const out = (
      await cloud({
        subcommand: 'migrate',
        urlStdin: true,
        readStdin: () => Promise.resolve(url),
        displayName: 'Journey',
      })
    ).join('\n');
    expect(out).toContain('Migrated');
    expect(out).toContain('row security is installed');

    const registered = findWorkspaceByConfigPath(world.owner.root, world.configPath!);
    expect(registered?.kind, 'the same workspace, moved — not a second one').toBe('cloud');

    // The rows really made the trip.
    const moved = await openConfiguredLattice({ config: world.configPath! });
    opened.push(moved);
    await moved.init();
    const rows = (await moved.query(need(world.importedTable, 'imported table'), {})) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(3);
    // Two rows to tell apart later: one shared with everybody, one left alone.
    world.sharedPk = String(rows[0]!.id);
    world.privatePk = String(rows[1]!.id);
    world.completed.push(4);
  });

  it('5. secures it, and the file index and the secret store are covered', async () => {
    const out = (await cloud({ subcommand: 'secure', managed: false })).join('\n');
    expect(out).toMatch(/Secured|Already a cloud/);
    expect(out).toContain('(owner)');

    // The command makes this claim itself; this is the independent check of it.
    // Securing walks the tables the workspace registered, so a partially-opened
    // workspace would secure everything EXCEPT the framework's own — the file
    // index, the secret store, the assistant's private conversations — while
    // still reporting success. Ask Postgres directly instead.
    const db = await openConfiguredLattice({ config: world.configPath! });
    opened.push(db);
    await db.init();
    const status = await cloudStatus(db);
    expect(status.standing).toBe('owner');
    expect(status.secured).toBe(true);
    expect(
      status.warnings.filter((w) => NATIVE_ENTITY_NAMES.has(w.table)),
      "the framework's own tables are not left open",
    ).toEqual([]);

    const guarded = (await allAsyncOrSync(
      db.adapter,
      `SELECT c.relname AS name, c.relrowsecurity AS enabled
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ANY(?::text[])`,
      [['files', 'secrets', need(world.importedTable, 'imported table')]],
    )) as { name: string; enabled: boolean }[];
    const byName = new Map(guarded.map((r) => [r.name, r.enabled]));
    expect(byName.get('files'), 'the file index has row security').toBe(true);
    expect(byName.get('secrets'), 'the secret store has row security').toBe(true);
    expect(byName.get(world.importedTable!), "the journey's own table too").toBe(true);
    world.completed.push(5);
  });

  it('6. invites somebody, and a second machine redeems it as its own workspace', async () => {
    const email = world.member.email;
    const invite = await cloud({ subcommand: 'invite', email });
    expect(invite.join('\n')).toContain(`Invited ${email}`);
    const token = tokenFrom(invite, email);
    roles.push(redeemInviteToken(email, token).role);

    // A different machine: its own credential store, its own registry, nothing
    // shared with the owner but the database itself.
    await onMachine(world.member, async () => {
      const joined = (
        await runCloudCommand({ subcommand: 'join', token, email, displayName: 'Shared' })
      ).join('\n');
      expect(joined).toContain(`Joined as ${email}`);
      expect(joined).toContain('scoped member');

      const registry = readRegistry(world.member.root);
      expect(registry.workspaces, 'a new workspace, not a repoint').toHaveLength(1);
      expect(registry.activeWorkspaceId).toBe(registry.workspaces[0]!.id);
      expect(registry.workspaces[0]!.kind).toBe('cloud');

      // The token is spent, and spending it again is refused BEFORE anything is
      // created for it.
      await expect(runCloudCommand({ subcommand: 'join', token, email })).rejects.toThrow();
      expect(readRegistry(world.member.root).workspaces).toHaveLength(1);
    });
    world.completed.push(6);
  });

  it('7. the member reads what was shared, and cannot read what was not', async () => {
    const table = need(world.importedTable, 'imported table');
    const shared = need(world.sharedPk, 'shared row');
    const priv = need(world.privatePk, 'private row');

    // Nothing is shared yet, so a member sees nothing — the starting position,
    // asserted so the sharing below is what changes it.
    await onMachine(world.member, async () => {
      const record = readRegistry(world.member.root).workspaces[0]!;
      const db = await openConfiguredLattice({
        config: resolveWorkspacePaths(world.member.root, record).configPath,
      });
      opened.push(db);
      await db.init();
      expect((await cloudStatus(db)).standing).toBe('member');
      expect(await db.query(table, {}), 'a member starts with nothing shared').toEqual([]);
      db.close();
    });

    const said = (
      await cloud({ subcommand: 'share', table, pk: shared, visibility: 'everyone' })
    ).join('\n');
    expect(said).toContain('everyone');

    await onMachine(world.member, async () => {
      const record = readRegistry(world.member.root).workspaces[0]!;
      const db = await openConfiguredLattice({
        config: resolveWorkspacePaths(world.member.root, record).configPath,
      });
      opened.push(db);
      await db.init();
      const visible = (await db.query(table, {})) as Record<string, unknown>[];
      expect(
        visible.map((r) => String(r.id)),
        'exactly what was shared',
      ).toEqual([shared]);
      // And the row that was not shared is not reachable by asking for it by
      // name either — the refusal is the database's, not a filtered list.
      expect(await db.get(table, priv), 'a row nobody shared').toBeNull();
      db.close();
    });
    world.completed.push(7);
  });
});

// ── 8-9: the assistant, and the health check ───────────────────────────────

describe('with no server: the assistant, and the health check', () => {
  it('8. runs an assistant turn whose change reverses as ONE action', async () => {
    const table = need(world.importedTable, 'imported table');
    const client = scriptedClient([
      {
        text: 'Adding it.',
        toolUses: [
          {
            id: 't1',
            name: 'create_row',
            input: { table, values: { description: 'added from the command line' } },
          },
        ],
      },
      { text: 'Added the row.' },
    ]);
    scriptedModel.provider = asProvider(client);

    const out: string[] = [];
    const err: string[] = [];
    let code: number;
    try {
      code = await runAskCommand(
        {
          prompt: `add a row to ${table} describing it as added from the command line`,
          config: need(world.configPath, 'workspace'),
          explicitConfig: true,
          root: world.owner.root,
        },
        { out: (l) => out.push(l), err: (l) => err.push(l) },
      );
    } finally {
      scriptedModel.provider = undefined;
    }

    expect(code, ['the turn did not finish the job:', ...err].join('\n')).toBe(0);
    expect(out.join('\n')).toContain('Added the row');
    // Not a wrapper around a model call: the model was handed this workspace's
    // real schema, so the tool it asked for could only have been about real
    // tables.
    expect(client.systems[0]).toContain(table);
    expect(err.join('\n')).toContain('create_row');

    const active = await openJourney();
    try {
      const rows = (await active.db.query(table, {})) as Record<string, unknown>[];
      expect(rows, 'the row the turn asked for is really there').toHaveLength(4);
      const written = rows.find((r) => JSON.stringify(r).includes('added from the command line'));
      expect(written).toBeTruthy();

      // Every entry the tool call wrote shares ONE operation-group id, so the
      // whole turn reverses as a single action. That is the property that makes
      // an unattended turn as safe to run as a click.
      const audit = (await active.db.query('_lattice_gui_audit', {
        filters: [{ col: 'row_id', op: 'eq', val: String(written!.id) }],
        limit: 10,
      })) as Record<string, unknown>[];
      expect(audit.length).toBeGreaterThan(0);
      const groups = new Set(audit.map((a) => String(a.op_group)));
      expect(groups.size, 'one tool call is one operation group').toBe(1);

      const undone = await undoGroup(
        {
          db: active.db,
          feed: new FeedBus(),
          softDeletable: active.softDeletable,
          source: 'gui',
          sessionId: commandLineSessionId(),
        },
        [...groups][0]!,
      );
      expect(undone.ok, JSON.stringify(undone)).toBe(true);
      expect(
        (await active.db.query(table, {})).length,
        'the turn is undone, and only the turn',
      ).toBe(3);
    } finally {
      await disposeActive(active);
    }
    world.completed.push(8);
  });

  it('9. reports a healthy workspace — what makes the health check exit zero', async () => {
    const db = await openConfiguredLattice({ config: need(world.configPath, 'workspace') });
    opened.push(db);
    await db.init();
    const report = await db.diagnoseRetrieval();

    // The exit code IS this flag: the command prints the report and exits
    // non-zero only when an error-severity issue exists, which is what lets a
    // deploy gate on it.
    const errors = [...report.issues, ...report.tables.flatMap((t) => t.issues)].filter(
      (i) => i.severity === 'error',
    );
    expect(
      errors.map((e) => `${e.kind}: ${e.message}`),
      'nothing at error severity',
    ).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.healthy ? 0 : 1, 'the exit code the command would use').toBe(0);

    // And the report a person reads is really produced, not merely computed.
    const text = formatHealthReport(report);
    expect(text).toContain('Retrieval health');
    expect(text).toContain(need(world.importedTable, 'imported table'));
    db.close();
    world.completed.push(9);
  });
});

// ── The assertions the journey exists to make ──────────────────────────────

describe('the journey never needed the browser app', () => {
  it('startGuiServer was never called, and the guard was really in force', async () => {
    // Proving the ABSENCE of a call means proving the recorder was installed —
    // an assertion on a spy that was never wired would pass for the wrong
    // reason, which is the failure mode this whole file is about.
    const module = (await import('../../src/gui/server.js')) as unknown as {
      __journeyGuard?: boolean;
    };
    expect(module.__journeyGuard, 'the guard replaced the module for the whole run').toBe(true);
    expect(serverGuard.calls, 'no server was started and no browser was opened').toEqual([]);
  });

  it('every step of the journey ran', () => {
    // A story that stopped after step two must not pass because the remaining
    // steps quietly did not assert anything. The cloud half is conditional on a
    // Postgres — and ONLY on that; when one is present it is not optional.
    const expected = PG_URL ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 8, 9];
    expect([...world.completed].sort((a, b) => a - b)).toEqual(expected);
    if (!PG_URL) {
      // Said out loud rather than passed over: without a database there is no
      // cloud to migrate onto, secure, or join.
      expect(process.env.LATTICE_TEST_PG_URL ?? '', 'steps 4-7 need a Postgres').toBe('');
    }
  });

  it('what it does not do, it says it does not do, and why', () => {
    expect(NOT_EXERCISED.length, 'the list is written down, not empty by accident').toBe(3);
    for (const entry of NOT_EXERCISED) {
      expect(entry.step.length, 'a skipped step is named').toBeGreaterThan(0);
      expect(
        entry.reason.length,
        `"${entry.step}" needs a reason, not a label`,
      ).toBeGreaterThanOrEqual(MIN_REASON);
    }
  });

  it('no way of changing something is still waiting for a headless equivalent', () => {
    // The release's number, read from the tree rather than from a summary of it:
    // every acknowledged gap is an annotation on the route that has it, so
    // counting the annotations is counting the gaps. Zero is the goal this
    // journey is the evidence for — the journey shows the product WORKS without
    // a server, and this shows nothing was left behind to make it do so.
    const outstanding: string[] = [];
    const annotated: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (text.includes('@headless-debt')) outstanding.push(full.slice(REPO.length + 1));
        if (text.includes('@capability ')) annotated.push(full.slice(REPO.length + 1));
      }
    };
    walk(join(REPO, 'src'));
    // A scan that reads nothing reports a clean tree forever, so prove it read
    // the annotated files before believing what it says about them.
    expect(annotated.length, 'the scan really reached the annotated routes').toBeGreaterThan(5);
    expect(outstanding, 'routes still marked as having no headless equivalent').toEqual([]);

    // And the pinned number agrees with the tree. Two independent facts: one
    // read from the annotations, one from the budget a human signs off on.
    const census = readFileSync(
      join(REPO, 'tests', 'unit', 'mutating-route-census.test.ts'),
      'utf8',
    );
    const pinned = /const DEBT_BUDGET = (\d+);/.exec(census)?.[1];
    expect(pinned, 'the census still pins a budget').toBeDefined();
    expect(Number(pinned), 'the pinned budget agrees with the tree').toBe(0);
  });
});
