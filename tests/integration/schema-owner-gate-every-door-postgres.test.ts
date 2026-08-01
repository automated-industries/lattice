/**
 * Changing the SHAPE of a shared cloud is owner-only — from every door.
 *
 * The browser refuses a scoped member fifteen different schema operations, and
 * every one of those refusals lived in the request handler. That is not a rule
 * about the operation; it is a rule about clicking. The same person, on the same
 * connection, reaching the same operation from a command, from the assistant, or
 * from a library call, met no rule at all — and the operations are not protected
 * by row security either, because they write the workspace configuration and run
 * schema statements, neither of which row security covers. Worse, when a member
 * lacks the privilege to run a statement the library deliberately routes it
 * through an owner-side helper, so the change really lands.
 *
 * This drives the doors a person actually uses, against one real cloud and one
 * real scoped member role:
 *
 *   - the assistant's tool wiring, exactly as the `ask` command builds it;
 *   - the command body behind `lattice schema`, exactly as the wrapper calls it;
 *   - the exported capability, exactly as an embedder imports it from the
 *     package entry point;
 *   - and the browser route, which must keep answering with its status.
 *
 * Every one has to refuse with the SAME tagged failure, and the shared database
 * has to be untouched afterwards — which is the assertion that fails without the
 * change, because these really did land.
 *
 * Postgres-gated (per-test database + a provisioned member role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive, startGuiServer } from '../../src/gui/server.js';
import type { ActiveDb, GuiServerHandle } from '../../src/gui/server.js';
import { askWorkspace } from '../../src/cli-ask.js';
import { runSchemaCommand } from '../../src/cli-schema.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
// The embedder's door: the package entry point, not the module that defines it.
import {
  addUserColumn,
  createUserEntity,
  createUserJunction,
  createFileJunction,
  createUserRelation,
  softDeleteUserEntity,
  removeInboundLinks,
  renameUserEntity,
  renameUserColumn,
  aiDeleteEntity,
  purgeUserEntity,
  setTableDefinition,
  setTableRole,
  applyShapeOp,
  createComputedTable,
  updateComputedTable,
  deleteComputedTable,
  previewComputedTable,
  refreshComputedTable,
} from '../../src/index.js';
import { recordDismissal } from '../../src/gui/planner/plan-state.js';
import { executeFunction } from '../../src/gui/ai/dispatch.js';
import type { DispatchCtx } from '../../src/gui/ai/handlers/types.js';
import { applyRetypeColumn } from '../../src/gui/planner/appliers.js';
import type { ComputedTableDef } from '../../src/config/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const servers: GuiServerHandle[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const a of actives.splice(0)) await disposeActive(a);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

/**
 * A workspace file declaring the shared layout. The member gets the SAME layout —
 * which is what a joined member really has, because the owner publishes it and the
 * member hydrates their own configuration from it.
 */
function writeConfig(prefix: string, url: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      `db: "${url}"`,
      '',
      'entities:',
      '  invoices:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      amount: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: invoices.md',
      '  vendors:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: vendors.md',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

/** One secured cloud, its owner, and one scoped member — the whole fixture. */
async function sharedCloud(): Promise<{
  dbname: string;
  owner: ActiveDb;
  member: ActiveDb;
  memberCfg: string;
}> {
  const dbname = `lattice_gate_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  {
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();
  }
  const ownerCfg = writeConfig('lattice-gate-owner-', dbUrl(dbname));
  const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
  actives.push(owner);
  await owner.converged;
  await secureCloud(owner.db);

  const role = `lm_gate_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner.db, role, pw);

  const memberCfg = writeConfig('lattice-gate-member-', dbUrl(dbname, role, pw));
  const member = await openConfig(memberCfg, join(memberCfg, '..', 'context'), false);
  actives.push(member);
  return { dbname, owner, member, memberCfg };
}

/** Column names really present on a table, read as the OWNER (a member's view is masked). */
async function realColumns(dbname: string, table: string): Promise<string[]> {
  const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
  try {
    const r = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    );
    return r.rows.map((x: { column_name: string }) => x.column_name).sort();
  } finally {
    await admin.end();
  }
}

/** Every relation the shared database really holds, read as the OWNER. */
async function realRelations(dbname: string): Promise<string[]> {
  const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
  try {
    const r = await admin.query(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','p')`,
    );
    return r.rows.map((x: { name: string }) => x.name).sort();
  } finally {
    await admin.end();
  }
}

/** The browsable presentation rows a member must not be able to write. */
async function tableMetaRows(dbname: string): Promise<unknown[]> {
  const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
  try {
    const r = await admin.query(
      `SELECT entity_name, description FROM _lattice_gui_meta ORDER BY entity_name`,
    );
    return r.rows;
  } finally {
    await admin.end();
  }
}

/** The browsable column-definition rows a member must not be able to write. */
async function columnMetaRows(dbname: string): Promise<unknown[]> {
  const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
  try {
    const r = await admin.query(
      `SELECT table_name, column_name, description FROM _lattice_gui_column_meta
        ORDER BY table_name, column_name`,
    );
    return r.rows;
  } finally {
    await admin.end();
  }
}

/** Run `fn`, returning whatever it produced — a value or the failure it threw. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    (v) => v,
    (e: unknown) => e,
  );
}

/** A trivial definition, valid enough that only authorization can refuse it. */
const COMPUTED_DEF = {
  base: 'invoices',
  fields: { amount: { from: 'amount' } },
} as unknown as ComputedTableDef;

describe.skipIf(!PG_URL)('shaping a shared cloud is owner-only from every door', () => {
  it("refuses a member's column add at the assistant, the library and the browser — and no column lands", async () => {
    const { dbname, member, memberCfg } = await sharedCloud();
    const before = await realColumns(dbname, 'invoices');

    // (1) The assistant, wired exactly as the `ask` command wires it. This is the
    // call the model makes when somebody types "add a column called payout_note
    // to invoices" into a terminal.
    const viaAssistant = await outcome(() =>
      askWorkspace(member, 'sess-gate').addColumn!('invoices', 'payout_note'),
    );
    expect(cloudErrorCode(viaAssistant)).toBe('cloud_owner_only');
    expect((viaAssistant as Error).message).toBe("Only a cloud owner can change a table's columns");

    // (2) The embedder, importing the capability from the package entry point.
    const viaLibrary = await outcome(() =>
      addUserColumn(member, 'invoices', 'payout_note', 'sess-gate'),
    );
    expect(cloudErrorCode(viaLibrary)).toBe('cloud_owner_only');

    // (3) The browser keeps answering with the status it expects.
    const gui = await startGuiServer({
      configPath: memberCfg,
      outputDir: join(memberCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(gui);
    const res = await fetch(`${gui.url}/api/schema/entities/invoices/columns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'payout_note', type: 'text' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toEqual({
      error: "Only a cloud owner can change a table's columns",
    });

    // (4) The assertion that fails without the change: the column really landed
    // on the shared table, because the library routes a member's statement
    // through an owner-side helper rather than refusing it.
    expect(await realColumns(dbname, 'invoices')).toEqual(before);
    expect(await realColumns(dbname, 'invoices')).not.toContain('payout_note');
  }, 120_000);

  it('refuses every operation the browser gates, through the exported capability, changing nothing', async () => {
    const { dbname, member, memberCfg } = await sharedCloud();
    const relationsBefore = await realRelations(dbname);
    const invoiceColsBefore = await realColumns(dbname, 'invoices');
    const configBefore = readFileSync(memberCfg, 'utf8');

    const cases: [string, string, () => Promise<unknown>][] = [
      ['create a table', 'create a table', () => createUserEntity(member, 'sneaky', [], 'sess')],
      [
        'create a link table',
        'create a link table',
        () => createUserJunction(member, 'invoices', 'vendors', 'sess'),
      ],
      [
        'create a file link table',
        'create a link table',
        () => createFileJunction(member, 'invoices', 'sess'),
      ],
      [
        'relate two tables',
        'relate tables',
        () => createUserRelation(member, 'invoices', 'amount', 'vendors', 'sess'),
      ],
      ['delete a table', 'delete tables', () => softDeleteUserEntity(member, 'vendors', 'sess')],
      [
        'remove inbound links',
        'delete tables',
        () =>
          removeInboundLinks(
            member,
            'vendors',
            [],
            {
              db: member.db,
              feed: member.feed,
              softDeletable: member.softDeletable,
              configPath: member.configPath,
              outputDir: member.outputDir,
              sessionId: 'sess',
            },
            { cascade: false, rowBudget: 1000 },
            'sess',
          ),
      ],
      [
        'rename a table',
        'rename a table',
        () => renameUserEntity(member, 'vendors', 'suppliers', 'sess'),
      ],
      [
        'rename a column',
        'rename a column',
        () => renameUserColumn(member, 'invoices', 'amount', 'total', () => undefined),
      ],
      [
        'merge tables',
        'delete or merge tables',
        () => aiDeleteEntity(member, 'vendors', { move_to: 'invoices' }, 'sess'),
      ],
      ['purge a table', 'purge tables', () => purgeUserEntity(member, 'vendors')],
      [
        'describe a table',
        'describe a table',
        () => setTableDefinition(member, 'invoices', 'a member wrote this'),
      ],
      // The same store, the same ROW, one field over — and this one travelled
      // without the rule while its neighbour above carried it. What a table IS
      // and what one of its rows MEANS are read by the data-model pass, the
      // interface and the assistant, so a member rewriting them re-describes the
      // shared workspace for everybody in it.
      [
        "set a table's role",
        'apply data-model changes',
        () => setTableRole(member, 'invoices', 'fact', 'user', 'one row per invoice'),
      ],
      [
        'apply a shape proposal',
        'apply data-model changes',
        () =>
          applyShapeOp(
            member,
            {
              id: 'shape-1',
              kind: 'assign_role',
              tier: 'ASK',
              rationale: 'a member proposed this',
              target: { table: 'vendors' },
              evidence: { role: 'dimension', grain: 'one row per vendor' },
            },
            'sess',
          ),
      ],
      [
        'preview a computed table',
        'preview a computed table',
        () => previewComputedTable(member, COMPUTED_DEF, 5),
      ],
      [
        'create a computed table',
        'create a computed table',
        () => createComputedTable(member, 'cheap', COMPUTED_DEF, 'sess'),
      ],
      [
        'update a computed table',
        'update a computed table',
        () => updateComputedTable(member, 'cheap', COMPUTED_DEF, 'sess'),
      ],
      [
        'delete a computed table',
        'delete a computed table',
        () => deleteComputedTable(member, 'cheap', 'sess'),
      ],
      [
        'refresh a computed table',
        'refresh a computed table',
        () => refreshComputedTable(member, 'cheap', { sessionId: 'sess' }),
      ],
      [
        'dismiss a data-model proposal',
        'dismiss data-model proposals',
        () => recordDismissal(member.db, 'op-1'),
      ],
      [
        'retype a column',
        'change a column type',
        () => applyRetypeColumn(member, 'invoices', 'amount', 'integer', 'sess'),
      ],
    ];

    for (const [label, verb, run] of cases) {
      const got = await outcome(run);
      expect(cloudErrorCode(got), `${label} must refuse a member with the tagged failure`).toBe(
        'cloud_owner_only',
      );
      expect((got as Error).message, `${label} must say why`).toBe(
        `Only a cloud owner can ${verb}`,
      );
    }

    // Nothing was created, dropped, renamed, retyped or documented. Several of
    // these really did land before the rule travelled with the operation.
    expect(await realRelations(dbname)).toEqual(relationsBefore);
    expect(await realColumns(dbname, 'invoices')).toEqual(invoiceColsBefore);
    expect(await tableMetaRows(dbname)).toEqual([]);
    expect(readFileSync(memberCfg, 'utf8')).toBe(configBefore);
  }, 120_000);

  it('refuses a member at the schema command, and writes nothing to the shared database', async () => {
    const { dbname, member, memberCfg } = await sharedCloud();

    // The body behind `lattice schema describe <table> --text "…"`, called exactly
    // as the command wrapper calls it. It writes the browsable definition row on
    // the SHARED database — which a member really could write.
    const described = await outcome(() =>
      runSchemaCommand({
        configPath: memberCfg,
        contextDir: join(memberCfg, '..', 'context'),
        subcommand: 'describe',
        action: 'vendors',
        text: 'a member wrote this',
        open: async () => member,
      }),
    );
    expect(cloudErrorCode(described)).toBe('cloud_owner_only');
    expect((described as Error).message).toBe('Only a cloud owner can describe a table');
    expect(await tableMetaRows(dbname)).toEqual([]);
  }, 120_000);

  it("refuses a member's DEFINITION write at the assistant's own tool, and writes nothing", async () => {
    // The gate went on the schema operation that writes a definition. The
    // assistant does not call that operation — its tool calls the metadata
    // writers underneath it directly, and so do an answered question and the
    // browser. Three doors to the same shared rows, none of them a schema
    // operation, none of them gated: a member wrote what everybody sees and was
    // told "ok".
    const { dbname, member, memberCfg } = await sharedCloud();
    const ctx = askWorkspace(member, 'sess-def') as unknown as DispatchCtx;

    const onTable = await executeFunction(ctx, 'set_definition', {
      table: 'vendors',
      description: 'a member wrote this through the assistant',
    });
    expect(onTable.ok, JSON.stringify(onTable)).toBe(false);
    expect(onTable.error).toBe('Only a cloud owner can describe a table');

    const onColumn = await executeFunction(ctx, 'set_definition', {
      table: 'invoices',
      column: 'amount',
      description: 'a member wrote this column note through the assistant',
    });
    expect(onColumn.ok, JSON.stringify(onColumn)).toBe(false);
    expect(onColumn.error).toBe('Only a cloud owner can describe a column');

    // The assertion that fails without the change: both rows really landed on
    // the shared database, through a tool that answered ok.
    expect(await tableMetaRows(dbname)).toEqual([]);
    expect(await columnMetaRows(dbname)).toEqual([]);

    // The same write reached by answering a question — the command behind
    // `lattice questions answer`, which runs the identical writers.
    // And the browser, which must answer with its own status for the same rule.
    const gui = await startGuiServer({
      configPath: memberCfg,
      outputDir: join(memberCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(gui);
    const viaTable = await fetch(`${gui.url}/api/gui-meta/vendors`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'a member wrote this in the browser', icon: '🧾' }),
    });
    expect(viaTable.status).toBe(403);
    expect((await viaTable.json()) as { error?: string }).toEqual({
      error: 'Only a cloud owner can describe a table',
    });

    const viaColumn = await fetch(`${gui.url}/api/gui-meta/columns/invoices/amount`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'a member wrote this column note in the browser' }),
    });
    expect(viaColumn.status).toBe(403);
    expect((await viaColumn.json()) as { error?: string }).toEqual({
      error: 'Only a cloud owner can describe a column',
    });

    expect(await tableMetaRows(dbname)).toEqual([]);
    expect(await columnMetaRows(dbname)).toEqual([]);
  }, 120_000);

  it('does not gate the owner — the rule is about members, not about schema changes', async () => {
    const { dbname, owner } = await sharedCloud();
    const added = await addUserColumn(owner, 'invoices', 'payout_note', 'sess-owner');
    expect(added).toEqual({ ok: true, column: 'payout_note' });
    expect(await realColumns(dbname, 'invoices')).toContain('payout_note');

    await setTableDefinition(owner, 'invoices', 'what we billed');
    expect(await tableMetaRows(dbname)).toContainEqual({
      entity_name: 'invoices',
      description: 'what we billed',
    });

    // The doors the member was refused at all work for the owner, so the gate is
    // about who is asking and not about the operation being unavailable.
    const ctx = askWorkspace(owner, 'sess-owner') as unknown as DispatchCtx;
    const described = await executeFunction(ctx, 'set_definition', {
      table: 'vendors',
      column: 'name',
      description: 'who we bought from',
    });
    expect(described.ok, JSON.stringify(described)).toBe(true);
    expect(await columnMetaRows(dbname)).toContainEqual({
      table_name: 'vendors',
      column_name: 'name',
      description: 'who we bought from',
    });
  }, 120_000);
});
