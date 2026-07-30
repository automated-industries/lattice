/**
 * `lattice cloud` against a real cloud — as the owner, and as a member.
 *
 * The interesting half of a command that administers a shared database is the
 * half that refuses. Authority on a cloud is the Postgres role you connect as,
 * not a session a caller can assert: the owner checks read `rolcreaterole` for
 * the live role, and the mutating steps are definer functions that raise for a
 * member on their own. Putting a command line in front of that must not have
 * weakened it — so every verb here is exercised twice, once from each side, and
 * the member cases assert the same refusal the browser app produced.
 *
 * These drive the subcommand module, not the process, and every connection is a
 * throwaway database with throwaway roles this file creates and drops.
 *
 * Postgres-gated: it needs real login roles, which SQLite cannot model.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { redeemInviteToken } from '../../src/cloud/invite.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { runCloudCommand, type CloudCommandArgs } from '../../src/cli-cloud.js';
import { openConfiguredLattice } from '../../src/cli-open.js';
import { ensureRootAt } from '../../src/framework/lattice-root.js';
import {
  addWorkspace,
  findWorkspaceByConfigPath,
  readRegistry,
  resolveWorkspacePaths,
  type WorkspaceRecord,
} from '../../src/framework/workspace.js';
import { readDbLine } from '../../src/framework/db-pointer.js';
import { getDbCredential } from '../../src/framework/user-config.js';
import { probeCloud } from '../../src/framework/cloud-connect.js';
import { cloudStatus, type CloudStatus } from '../../src/cloud/status.js';
import type { CloudMember } from '../../src/cloud/member-directory.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const KEY = Buffer.alloc(32, 5).toString('base64');

const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lattice-clicloud-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

let prevConfigDir: string | undefined;
let prevLatticeRoot: string | undefined;

beforeAll(() => {
  const envRoot = scratch('env');
  prevConfigDir = process.env.LATTICE_CONFIG_DIR;
  prevLatticeRoot = process.env.LATTICE_ROOT;
  process.env.LATTICE_CONFIG_DIR = join(envRoot, 'config');
  process.env.LATTICE_ROOT = join(envRoot, 'root');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.LATTICE_ROOT, { recursive: true });
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = prevConfigDir;
  if (prevLatticeRoot === undefined) delete process.env.LATTICE_ROOT;
  else process.env.LATTICE_ROOT = prevLatticeRoot;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A workspace config whose connection line names `dbname` — what invite reads. */
function configFor(dbname: string): string {
  const path = join(scratch('cfg'), 'workspace.yml');
  writeFileSync(path, `name: cli-cloud-test\ndb: "${dbUrl(dbname)}"\nentities: []\n`, 'utf8');
  return path;
}

/**
 * A connection opened exactly the way the command does: the workspace's own
 * table plus the built-in ones, then init — which detects a scoped member and
 * skips the DDL it has no privilege for.
 */
function opener(url: string): () => Promise<Lattice> {
  return async () => {
    const db = new Lattice(url, { encryptionKey: KEY });
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    registerNativeEntities(db);
    await db.init();
    return db;
  };
}

afterEach(async () => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
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

describe.skipIf(!PG_URL)('lattice cloud, against a real cloud', () => {
  interface Cloud {
    /** A long-lived owner connection for assertions the command does not make. */
    owner: Lattice;
    dbname: string;
    configPath: string;
    ownerUrl: string;
  }

  /** A throwaway Postgres with the workspace applied. Secured unless asked not to be. */
  async function freshCloud(opts: { secure?: boolean } = {}): Promise<Cloud> {
    const dbname = `lattice_cli_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const ownerUrl = dbUrl(dbname);
    const owner = await opener(ownerUrl)();
    opened.push(owner);
    if (opts.secure !== false) await secureCloud(owner);
    return { owner, dbname, configPath: configFor(dbname), ownerUrl };
  }

  /** Provision a scoped member and return the URL it connects with. */
  async function addMember(cloud: Cloud, label = 'mem'): Promise<{ url: string; role: string }> {
    const role = `lm_${label}_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const password = generateMemberPassword();
    await provisionMemberRole(cloud.owner, role, password);
    return { url: dbUrl(cloud.dbname, role, password), role };
  }

  /** Run one verb over a connection, exactly as the CLI wrapper does. */
  function cli(url: string, cloud: Cloud, args: Partial<CloudCommandArgs>): Promise<string[]> {
    return runCloudCommand({
      configPath: cloud.configPath,
      latticeRoot: null,
      ...args,
      open: opener(url),
    });
  }

  /** `relforcerowsecurity` for each of `tables`, keyed by name. */
  async function forcedRls(db: Lattice, tables: string[]): Promise<Map<string, boolean>> {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT c.relname AS name, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ANY(?::text[])`,
      [tables],
    )) as { name: string; forced: boolean }[];
    return new Map(rows.map((r) => [r.name, r.forced]));
  }

  // ── members ──────────────────────────────────────────────────────────────

  it('the owner sees the whole roster; a member sees only itself', async () => {
    const cloud = await freshCloud();
    const first = await addMember(cloud, 'one');
    const second = await addMember(cloud, 'two');

    const asOwner = (await cli(cloud.ownerUrl, cloud, { subcommand: 'members' })).join('\n');
    expect(asOwner).toContain(first.role);
    expect(asOwner).toContain(second.role);
    expect(asOwner.split('\n')[0]?.startsWith('*'), 'the owner row is the caller').toBe(true);

    // Enumerating the group is an owner privilege. A member is not told it owns
    // the cloud, and is not shown anybody else on it.
    const asMember = (await cli(second.url, cloud, { subcommand: 'members' })).join('\n');
    expect(asMember).not.toContain(first.role);
    expect(asMember).toContain(second.role);
    expect(asMember).toContain('member');
  });

  it('gives the roster as JSON when asked, for both sides', async () => {
    const cloud = await freshCloud();
    const member = await addMember(cloud);

    const [ownerJson] = await cli(cloud.ownerUrl, cloud, { subcommand: 'members', json: true });
    const ownerRoster = JSON.parse(ownerJson ?? '') as CloudMember[];
    expect(ownerRoster[0]?.status).toBe('owner');
    expect(ownerRoster.map((m) => m.role)).toContain(member.role);

    const [memberJson] = await cli(member.url, cloud, { subcommand: 'members', json: true });
    const memberRoster = JSON.parse(memberJson ?? '') as CloudMember[];
    expect(memberRoster).toHaveLength(1);
    expect(memberRoster[0]?.status).toBe('member');
  });

  // ── invite ───────────────────────────────────────────────────────────────

  it('the owner mints an invite, and the token is printed exactly once', async () => {
    const cloud = await freshCloud();
    const email = 'newcomer@example.test';
    const out = await cli(cloud.ownerUrl, cloud, { subcommand: 'invite', email });

    // The token is a credential: it is never stored, so the one printing is the
    // only one there will ever be. Find it by redeeming, not by position.
    const tokenLines = out.filter((line) => {
      try {
        redeemInviteToken(email, line.trim());
        return true;
      } catch {
        return false;
      }
    });
    expect(tokenLines, 'exactly one line carries the credential').toHaveLength(1);

    const payload = redeemInviteToken(email, tokenLines[0]!.trim());
    roles.push(payload.role);
    expect(payload.dbname).toBe(cloud.dbname);
    expect(payload.password.length).toBeGreaterThan(0);

    // The guidance a person needs to act on it travels with it.
    const text = out.join('\n');
    expect(text).toContain(`Invited ${email}`);
    expect(text).toMatch(/bound to that email/);
    expect(text).toMatch(/7 days/);

    // …and the roster now shows them as invited rather than joined.
    const roster = (await cli(cloud.ownerUrl, cloud, { subcommand: 'members' })).join('\n');
    expect(roster).toContain(payload.role);
    expect(roster).toContain('invited');
  });

  it('a member cannot invite anybody, and nothing is minted when they try', async () => {
    const cloud = await freshCloud();
    const member = await addMember(cloud);
    const before = await cli(cloud.ownerUrl, cloud, { subcommand: 'members', json: true });

    await expect(
      cli(member.url, cloud, { subcommand: 'invite', email: 'stranger@example.test' }),
    ).rejects.toThrow(/Only a cloud owner can invite members/);

    // The refusal is a hard stop, not a partial run: no role, no invite row.
    const after = await cli(cloud.ownerUrl, cloud, { subcommand: 'members', json: true });
    expect(after).toEqual(before);
  });

  // ── revoke ───────────────────────────────────────────────────────────────

  it('the owner removes a member by the email the roster showed', async () => {
    const cloud = await freshCloud();
    const email = 'leaver@example.test';
    const out = await cli(cloud.ownerUrl, cloud, { subcommand: 'invite', email });
    const token = out
      .map((l) => l.trim())
      .find((l) => {
        try {
          redeemInviteToken(email, l);
          return true;
        } catch {
          return false;
        }
      });
    const { role } = redeemInviteToken(email, token!);
    roles.push(role);

    const removed = (
      await cli(cloud.ownerUrl, cloud, { subcommand: 'revoke', action: email })
    ).join('\n');
    expect(removed).toContain(role);

    const roster = (await cli(cloud.ownerUrl, cloud, { subcommand: 'members' })).join('\n');
    expect(roster).not.toContain(role);
  });

  it('a member cannot remove anybody — the database refuses, not the roster', async () => {
    const cloud = await freshCloud();
    const victim = await addMember(cloud, 'victim');
    const attacker = await addMember(cloud, 'attacker');

    // A member cannot enumerate, so the reference is passed straight through and
    // the refusal that comes back is the authorization one — not a misleading
    // "no such member" invented locally.
    await expect(
      cli(attacker.url, cloud, { subcommand: 'revoke', action: victim.role }),
    ).rejects.toThrow(/Only a cloud owner can remove members/);

    const roster = (await cli(cloud.ownerUrl, cloud, { subcommand: 'members' })).join('\n');
    expect(roster, 'still on the cloud').toContain(victim.role);
  });

  // ── status ───────────────────────────────────────────────────────────────

  it('tells each side which side it is on', async () => {
    const cloud = await freshCloud();
    const member = await addMember(cloud);

    const [ownerJson] = await cli(cloud.ownerUrl, cloud, { subcommand: 'status', json: true });
    const ownerStatus = JSON.parse(ownerJson ?? '') as CloudStatus;
    expect(ownerStatus.standing).toBe('owner');
    expect(ownerStatus.secured).toBe(true);
    expect(ownerStatus.warnings, 'a freshly secured cloud is clean').toEqual([]);

    const [memberJson] = await cli(member.url, cloud, { subcommand: 'status', json: true });
    const memberStatus = JSON.parse(memberJson ?? '') as CloudStatus;
    expect(memberStatus.standing).toBe('member');
    expect(memberStatus.role).toBe(member.role);

    const text = (await cli(member.url, cloud, { subcommand: 'status' })).join('\n');
    expect(text).toContain('You are:    a member');
  });

  it('says an unsecured Postgres is not a cloud yet, and names the fix', async () => {
    const cloud = await freshCloud({ secure: false });
    const text = (await cli(cloud.ownerUrl, cloud, { subcommand: 'status' })).join('\n');
    expect(text).toContain('NOT installed');
    expect(text).toContain('lattice cloud secure');
  });

  // ── secure ───────────────────────────────────────────────────────────────

  it('securing headlessly covers the file index and the secret store', async () => {
    // The whole risk of a headless secure: it walks the tables the workspace
    // registered, so a partial open would protect `notes` and leave files,
    // secrets and private conversations readable by every member — while
    // reporting success. Assert the protection landed, not just the exit.
    const cloud = await freshCloud({ secure: false });
    const out = (await cli(cloud.ownerUrl, cloud, { subcommand: 'secure' })).join('\n');
    expect(out).toContain('Secured.');
    expect(out).toContain('lattice cloud invite');

    const guarded = ['notes', 'files', 'secrets', 'chat_threads', 'chat_messages'];
    const forced = await forcedRls(cloud.owner, guarded);
    for (const table of guarded) {
      expect(forced.get(table), `${table} must have row security forced`).toBe(true);
    }
  });

  it('re-securing an existing cloud says so instead of pretending it is new', async () => {
    const cloud = await freshCloud();
    const out = (await cli(cloud.ownerUrl, cloud, { subcommand: 'secure' })).join('\n');
    expect(out).toContain('Already a cloud');
  });

  it('a member cannot secure the cloud they are on', async () => {
    const cloud = await freshCloud();
    const member = await addMember(cloud);
    await expect(cli(member.url, cloud, { subcommand: 'secure' })).rejects.toThrow(
      /Only a cloud owner can secure a cloud/,
    );
  });

  it('an owner on a managed deployment cannot secure it either, and nothing is touched', async () => {
    // The one refusal the command dropped when this moved off the browser app.
    // A managed session connects AS the owner — it holds role creation, or
    // inviting would not work — so the owner check passes and the whole security
    // bootstrap re-runs against a database the manager provisioned: row
    // ownership re-stamped, member access re-applied. Refusing is the point, and
    // it has to refuse before anything runs.
    const cloud = await freshCloud({ secure: false });
    await expect(
      cli(cloud.ownerUrl, cloud, { subcommand: 'secure', managed: true }),
    ).rejects.toThrow(/managed by your team/);

    const forced = await forcedRls(cloud.owner, ['notes']);
    expect(forced.get('notes') ?? false, 'the refusal ran before any security DDL').toBe(false);
  });

  // ── share ────────────────────────────────────────────────────────────────

  it('the owner shares one row with one member, and takes it back', async () => {
    const cloud = await freshCloud();
    const email = 'reader@example.test';
    const out = await cli(cloud.ownerUrl, cloud, { subcommand: 'invite', email });
    const token = out
      .map((l) => l.trim())
      .find((l) => {
        try {
          redeemInviteToken(email, l);
          return true;
        } catch {
          return false;
        }
      });
    const { role } = redeemInviteToken(email, token!);
    roles.push(role);
    await cloud.owner.insert('notes', { id: 'n1', body: 'private by default' });

    const shared = (
      await cli(cloud.ownerUrl, cloud, {
        subcommand: 'share',
        table: 'notes',
        pk: 'n1',
        to: email,
      })
    ).join('\n');
    expect(shared, 'named by the person, not the role').toContain('reader');

    const revoked = (
      await cli(cloud.ownerUrl, cloud, {
        subcommand: 'share',
        table: 'notes',
        pk: 'n1',
        to: email,
        revoke: true,
      })
    ).join('\n');
    expect(revoked).toContain('Revoked');
  });

  it("a member cannot change the audience of somebody else's row", async () => {
    const cloud = await freshCloud();
    const member = await addMember(cloud);
    await cloud.owner.insert('notes', { id: 'n2', body: 'the owner writes this' });

    // Sharing is gated in the database by row ownership, so the command inherits
    // the refusal rather than checking anything itself.
    await expect(
      cli(member.url, cloud, {
        subcommand: 'share',
        table: 'notes',
        pk: 'n2',
        visibility: 'everyone',
      }),
    ).rejects.toThrow();
  });
});

/**
 * The two verbs that do not administer a shared workspace but CREATE the
 * relationship with one: an owner moving a local workspace onto a shared
 * database, and a member on a different machine redeeming the invite that comes
 * out of it.
 *
 * Both were browser-only, and both are the reason the browser-on-a-network
 * workaround existed at all — a server with no display could not become a shared
 * workspace and could not join one. So this drives the whole arc against a real
 * database: local rows in, invite out, second machine in, and the member reading
 * exactly what a member is allowed to read.
 *
 * Two separate machines are simulated by swapping the two things that make a
 * machine a machine here: where credentials are stored and which root holds the
 * workspace registry. Nothing is shared between them but the database itself,
 * which is the point.
 */
describe.skipIf(!PG_URL)('lattice cloud migrate + join, against a real database', () => {
  /** A `.lattice` root with one local workspace holding real rows. */
  async function localWorkspace(name: string): Promise<{
    root: string;
    configPath: string;
    dbPath: string;
    record: WorkspaceRecord;
  }> {
    const root = ensureRootAt(scratch('local'));
    const record = addWorkspace(root, { displayName: name, makeActive: true });
    const paths = resolveWorkspacePaths(root, record);
    writeFileSync(
      paths.configPath,
      [
        `name: "${name}"`,
        'db: ./Data/database.db',
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: text, primaryKey: true }',
        '      body: { type: text }',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
      'utf8',
    );
    const db = await openConfiguredLattice({ config: paths.configPath });
    await db.init();
    await db.insert('notes', { id: 'n-1', body: 'written before the move' });
    await db.insert('notes', { id: 'n-2', body: 'written before the move too' });
    db.close();
    return {
      root,
      configPath: paths.configPath,
      dbPath: join(paths.dataDir, 'database.db'),
      record,
    };
  }

  /** A blank Postgres nobody has secured yet — what a migration needs. */
  async function blankDatabase(): Promise<string> {
    const dbname = `lattice_mig_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();
    return dbname;
  }

  /** A database somebody has ALREADY made their cloud — not a migration target. */
  async function takenDatabase(): Promise<string> {
    const dbname = await blankDatabase();
    const owner = new Lattice(dbUrl(dbname), { encryptionKey: KEY });
    owner.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    registerNativeEntities(owner);
    await owner.init();
    opened.push(owner);
    await secureCloud(owner);
    return dbname;
  }

  /** Run a verb the way the wrapper does: real config, real open, real root. */
  function run(
    workspace: { configPath: string; root: string },
    args: Partial<CloudCommandArgs>,
  ): Promise<string[]> {
    return runCloudCommand({
      configPath: workspace.configPath,
      latticeRoot: workspace.root,
      ...args,
    });
  }

  it('moves a local workspace onto a shared database, rows and all', async () => {
    const ws = await localWorkspace('Field-Notes');
    const dbname = await blankDatabase();

    const out = (await run(ws, { subcommand: 'migrate', action: dbUrl(dbname) })).join('\n');
    expect(out).toContain('Migrated');
    expect(out).toContain('row security is installed');

    // The config and the registry both point at the shared database now, and the
    // credential behind the reference really resolves.
    const dbLine = readDbLine(ws.configPath);
    expect(dbLine).toBe(`\${LATTICE_DB:${dbname}}`);
    expect(getDbCredential(dbname)).toBe(dbUrl(dbname));
    const registered = findWorkspaceByConfigPath(ws.root, ws.configPath);
    expect(registered?.kind).toBe('cloud');
    expect(registered?.id, 'the same workspace, moved — not a second one').toBe(ws.record.id);

    // The local file was retired by rename, so the bytes are still recoverable.
    expect(existsSync(ws.dbPath)).toBe(false);
    expect(existsSync(`${ws.dbPath}.local-bak`)).toBe(true);

    // And the rows are really in the shared database, which is now a cloud.
    const probe = await probeCloud(dbUrl(dbname));
    expect(probe.isCloud, 'the target is a secured cloud afterwards').toBe(true);
    const moved = await openConfiguredLattice({ config: ws.configPath });
    opened.push(moved);
    await moved.init();
    const rows = await moved.query('notes', {});
    expect(rows.map((r) => r.id).sort()).toEqual(['n-1', 'n-2']);
  });

  it('refuses a database that is already somebody else s cloud, and changes nothing', async () => {
    const ws = await localWorkspace('Second-Notes');
    const taken = await takenDatabase();

    await expect(run(ws, { subcommand: 'migrate', action: dbUrl(taken) })).rejects.toThrow(
      /already a Lattice cloud/,
    );

    // Untouched: still local, still named by its own file, still holding rows.
    expect(readDbLine(ws.configPath)).toBe('./Data/database.db');
    expect(findWorkspaceByConfigPath(ws.root, ws.configPath)?.kind).toBe('local');
    expect(existsSync(ws.dbPath), 'the local database was not archived').toBe(true);
    const still = await openConfiguredLattice({ config: ws.configPath });
    opened.push(still);
    await still.init();
    expect((await still.query('notes', {})).length).toBe(2);
  });

  it('a second machine joins with the token the first machine printed', async () => {
    const ws = await localWorkspace('Shared-Notes');
    const dbname = await blankDatabase();
    await run(ws, { subcommand: 'migrate', action: dbUrl(dbname) });

    // The owner mints an invite for somebody who has never seen this database.
    const email = 'joiner@example.test';
    const invite = await run(ws, { subcommand: 'invite', email });
    const token = invite
      .map((l) => l.trim())
      .find((line) => {
        try {
          redeemInviteToken(email, line);
          return true;
        } catch {
          return false;
        }
      });
    expect(token, 'the invite carried exactly one redeemable token').toBeTruthy();

    // A different machine: its own credential store, its own registry, nothing
    // shared but the database.
    const otherConfig = join(scratch('machine2'), 'config');
    const otherRoot = join(scratch('machine2'), 'root');
    mkdirSync(otherConfig, { recursive: true });
    const restore = {
      cfg: process.env.LATTICE_CONFIG_DIR,
      root: process.env.LATTICE_ROOT,
    };
    process.env.LATTICE_CONFIG_DIR = otherConfig;
    process.env.LATTICE_ROOT = otherRoot;
    try {
      const joined = (await runCloudCommand({ subcommand: 'join', token, email })).join('\n');
      expect(joined).toContain('Joined as joiner@example.test');
      expect(joined).toContain('scoped member');

      // A NEW workspace, active, in the second machine s registry — never a
      // repoint of anything that was already there.
      const registry = readRegistry(otherRoot);
      expect(registry.workspaces).toHaveLength(1);
      const record = registry.workspaces[0]!;
      expect(registry.activeWorkspaceId).toBe(record.id);
      expect(record.kind).toBe('cloud');

      // And it really connects, as a MEMBER: the owner s rows are not visible to
      // it, which is the whole contract of joining rather than being handed the
      // owner s connection string.
      const memberDb = await openConfiguredLattice({
        config: resolveWorkspacePaths(otherRoot, record).configPath,
      });
      opened.push(memberDb);
      await memberDb.init();
      const status = await cloudStatus(memberDb);
      expect(status.standing).toBe('member');
      expect(await memberDb.query('notes', {}), 'a member starts with nothing shared').toEqual([]);

      // The token is spent. Replaying it is refused, and refused BEFORE a second
      // workspace could be created for it.
      await expect(runCloudCommand({ subcommand: 'join', token, email })).rejects.toThrow();
      expect(readRegistry(otherRoot).workspaces, 'no half-made second workspace').toHaveLength(1);
    } finally {
      if (restore.cfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
      else process.env.LATTICE_CONFIG_DIR = restore.cfg;
      if (restore.root === undefined) delete process.env.LATTICE_ROOT;
      else process.env.LATTICE_ROOT = restore.root;
    }
  });
});
