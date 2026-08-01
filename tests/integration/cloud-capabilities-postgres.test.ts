/**
 * Managing a shared cloud WITHOUT a server.
 *
 * Listing who is on a cloud, inviting somebody, removing them, joining one, and
 * sharing a row all used to exist only inside request handlers. On a machine with
 * no display the only way to reach them was to bind the browser app to a network
 * address — a surface its own help text calls unauthenticated. These tests call
 * the extracted capabilities DIRECTLY, with plain arguments, against a real
 * Postgres, which is the whole claim: no server, no request, same behavior.
 *
 * Every one of them is exercised twice — once as the cloud OWNER and once as a
 * scoped, non-bypassing member login role — because the interesting half of this
 * code is the refusals. Authority here is the Postgres role, not a session: the
 * owner checks read whether the connected role may create roles, and the mutating
 * steps are definer functions that raise for a member on their own. Extracting
 * the logic must not have weakened either, so each member case asserts the same
 * refusal the browser app produced.
 *
 * Postgres-gated: a real per-test cloud database and real member login roles.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import { listCloudMembers } from '../../src/cloud/member-directory.js';
import { inviteMember, removeMember, cloudCoordsForConfig } from '../../src/cloud/membership.js';
import { shareRow, grantRowAccess, batchRowAccess } from '../../src/cloud/sharing.js';
import { joinCloud, redeemCloudInvite } from '../../src/cloud/join.js';
import { createCloudWorkspace } from '../../src/framework/cloud-workspace.js';
import { redeemInviteToken } from '../../src/cloud/invite.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import {
  getActiveWorkspace,
  listWorkspaces,
  type WorkspaceRecord,
} from '../../src/framework/workspace.js';
import { getDbCredential } from '../../src/framework/user-config.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];
const scratchDirs: string[] = [];

/** A throwaway directory this file owns and deletes. Never a real install. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lattice-cloudcap-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** An isolated config dir + workspace root, so nothing touches a real install. */
let envRoot: string;
let prevConfigDir: string | undefined;
let prevLatticeRoot: string | undefined;

beforeAll(() => {
  envRoot = scratch('env');
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

/**
 * The user tables these clouds carry. `notes` holds the data — the owner and the
 * members both write into it — and `dashboards` holds a page that reads it. Two
 * tables rather than one because sharing the page is only half the operation: the
 * sharing tests below assert that the data behind it travels too.
 */
function defineTables(db: Lattice): void {
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  db.define('dashboards', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      html: 'TEXT',
      source_tables: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'dashboards.md',
  });
}

/** A workspace config whose connection line names `dbname`, for the invite path. */
function configFor(dbname: string): string {
  const dir = scratch('cfg');
  const path = join(dir, 'workspace.yml');
  writeFileSync(path, `name: cap-test\ndb: "${dbUrl(dbname)}"\nentities: []\n`, 'utf8');
  return path;
}

/** The tag on a thrown capability failure, or undefined when it carries none. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return cloudErrorCode(e) ?? `untagged: ${(e as Error).message}`;
  }
  return undefined;
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

describe.skipIf(!PG_URL)('cloud capabilities, called directly', () => {
  interface Cloud {
    owner: Lattice;
    dbname: string;
    configPath: string;
  }

  /** A fresh, secured cloud with nobody on it but the owner. */
  async function freshCloud(): Promise<Cloud> {
    const dbname = `lattice_cap_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname));
    opened.push(owner);
    defineTables(owner);
    await owner.init();
    await secureCloud(owner);
    return { owner, dbname, configPath: configFor(dbname) };
  }

  /** A dashboard row whose page reads `sources`, owned by whoever writes it. */
  async function makeDashboard(db: Lattice, pk: string, sources: string[]): Promise<void> {
    await db.insert('dashboards', {
      id: pk,
      title: 'Report',
      html: '<div></div>',
      source_tables: JSON.stringify(sources),
    });
  }

  /** Provision a scoped member on `cloud` and open a Lattice as that role. */
  async function addMember(
    cloud: Cloud,
    label = 'mem',
  ): Promise<{ member: Lattice; role: string }> {
    const role = `lm_${label}_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(cloud.owner, role, pw);
    const member = new Lattice(dbUrl(cloud.dbname, role, pw));
    opened.push(member);
    defineTables(member);
    await member.init();
    return { member, role };
  }

  // ── listCloudMembers ─────────────────────────────────────────────────────

  it('the owner sees the whole roster; a member sees only itself', async () => {
    const cloud = await freshCloud();
    const { role } = await addMember(cloud);
    const { member: second } = await addMember(cloud, 'two');

    const asOwner = await listCloudMembers(cloud.owner);
    expect(asOwner[0]?.status, 'the owner is first and labelled as such').toBe('owner');
    expect(asOwner[0]?.isYou).toBe(true);
    expect(asOwner.map((m) => m.role)).toContain(role);
    // A role provisioned by hand has no invite row, so it reads as joined rather
    // than pending — only a live invite makes somebody "invited".
    expect(asOwner.find((m) => m.role === role)?.status).toBe('member');

    // Enumerating the group is an owner privilege. The member is not refused with
    // an error — it simply cannot see anybody but itself, and is not told it owns
    // the cloud.
    const asMember = await listCloudMembers(second);
    expect(asMember).toHaveLength(1);
    expect(asMember[0]?.status).toBe('member');
    expect(asMember[0]?.isYou).toBe(true);
  });

  it('an invited-but-not-joined person is listed as invited, with their email', async () => {
    const cloud = await freshCloud();
    const { role } = await inviteMember(cloud.owner, {
      email: 'Pending.Person@example.test',
      configPath: cloud.configPath,
    });
    roles.push(role);

    const roster = await listCloudMembers(cloud.owner);
    const row = roster.find((m) => m.role === role);
    expect(row?.status).toBe('invited');
    expect(row?.email, 'stored lowercased for a stable lookup key').toBe(
      'pending.person@example.test',
    );
    expect(row?.name, 'named from the local part when there is no display name').toBe(
      'pending.person',
    );
  });

  it('the roster read is bounded and pages', async () => {
    const cloud = await freshCloud();
    const a = await addMember(cloud, 'a');
    const b = await addMember(cloud, 'b');
    const both = [a.role, b.role].sort();

    const firstPage = await listCloudMembers(cloud.owner, { limit: 1 });
    // The owner row identifies the caller on every page and is not part of the
    // limit; exactly one member comes with it.
    expect(firstPage).toHaveLength(2);
    expect(firstPage[1]?.role).toBe(both[0]);

    const secondPage = await listCloudMembers(cloud.owner, { limit: 1, offset: 1 });
    expect(secondPage).toHaveLength(2);
    expect(secondPage[1]?.role).toBe(both[1]);
  });

  // ── inviteMember ─────────────────────────────────────────────────────────

  it('the owner mints an invite carrying a scoped, non-privileged role', async () => {
    const cloud = await freshCloud();
    const result = await inviteMember(cloud.owner, {
      email: 'newcomer@example.test',
      configPath: cloud.configPath,
    });
    roles.push(result.role);

    // The token really carries the credential, and only the matching email opens it.
    const payload = redeemInviteToken('newcomer@example.test', result.token);
    expect(payload.role).toBe(result.role);
    expect(payload.dbname).toBe(cloud.dbname);
    expect(payload.password.length).toBeGreaterThan(0);

    // The non-privileged assertion is the security-critical step of the whole
    // flow: what leaves the machine must never be able to escalate.
    const attrs = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT rolsuper, rolcreaterole, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = ?`,
      [result.role],
    )) as
      | { rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolcanlogin: boolean }
      | undefined;
    expect(attrs).toBeDefined();
    expect(attrs?.rolsuper).toBe(false);
    expect(attrs?.rolcreaterole).toBe(false);
    expect(attrs?.rolbypassrls).toBe(false);
    expect(attrs?.rolcanlogin).toBe(true);

    // The audit ledger records the invite — hash for tamper evidence, plaintext so
    // the roster can say who it is, and never the password.
    const ledger = (await allAsyncOrSync(
      cloud.owner.adapter,
      `SELECT "role", "email", "email_hash", "redeemed_at", "revoked_at"
         FROM "__lattice_member_invites" WHERE "role" = ?`,
      [result.role],
    )) as { email: string; email_hash: string; redeemed_at: string | null }[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.email).toBe('newcomer@example.test');
    expect(ledger[0]?.email_hash.length).toBe(64);
    expect(ledger[0]?.redeemed_at).toBeNull();
  });

  it('a member cannot invite anybody', async () => {
    const cloud = await freshCloud();
    const { member } = await addMember(cloud);
    expect(
      await codeOf(() =>
        inviteMember(member, { email: 'stranger@example.test', configPath: cloud.configPath }),
      ),
    ).toBe('cloud_owner_only');
  });

  it('a managed session refuses to invite, and mints nothing', async () => {
    const cloud = await freshCloud();
    const before = await listCloudMembers(cloud.owner);
    expect(
      await codeOf(() =>
        inviteMember(cloud.owner, {
          email: 'shadow@example.test',
          configPath: cloud.configPath,
          managed: true,
        }),
      ),
    ).toBe('cloud_managed');
    // The refusal has to be a hard stop, not a warning: a role created here would
    // be invisible to the manager that owns membership.
    expect(await listCloudMembers(cloud.owner)).toEqual(before);
  });

  it('refuses an address that is not an address', async () => {
    const cloud = await freshCloud();
    expect(
      await codeOf(() =>
        inviteMember(cloud.owner, { email: 'nope', configPath: cloud.configPath }),
      ),
    ).toBe('invalid_request');
  });

  it('re-inviting the same person reclaims the role behind the stale invite', async () => {
    const cloud = await freshCloud();
    const first = await inviteMember(cloud.owner, {
      email: 'twice@example.test',
      configPath: cloud.configPath,
    });
    roles.push(first.role);
    const second = await inviteMember(cloud.owner, {
      email: 'twice@example.test',
      configPath: cloud.configPath,
    });
    roles.push(second.role);
    expect(second.role).not.toBe(first.role);

    // The first role is GONE, so its still-live token cannot be redeemed, and its
    // ledger row is stamped revoked rather than left dangling.
    const stale = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT 1 AS x FROM pg_roles WHERE rolname = ?`,
      [first.role],
    )) as { x?: number } | undefined;
    expect(stale, 'the orphaned role was dropped').toBeUndefined();
    const revoked = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT "revoked_at" FROM "__lattice_member_invites" WHERE "role" = ?`,
      [first.role],
    )) as { revoked_at: string | null } | undefined;
    expect(revoked?.revoked_at).not.toBeNull();

    const roster = await listCloudMembers(cloud.owner);
    expect(roster.map((m) => m.role)).not.toContain(first.role);
    expect(roster.map((m) => m.role)).toContain(second.role);
  });

  // ── removeMember ─────────────────────────────────────────────────────────

  it('the owner removes a member; the role and their invites go with them', async () => {
    const cloud = await freshCloud();
    const invited = await inviteMember(cloud.owner, {
      email: 'leaving@example.test',
      configPath: cloud.configPath,
    });
    roles.push(invited.role);

    expect(await removeMember(cloud.owner, invited.role)).toEqual({ role: invited.role });

    const gone = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT 1 AS x FROM pg_roles WHERE rolname = ?`,
      [invited.role],
    )) as { x?: number } | undefined;
    expect(gone).toBeUndefined();
    const stamped = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT "revoked_at" FROM "__lattice_member_invites" WHERE "role" = ?`,
      [invited.role],
    )) as { revoked_at: string | null } | undefined;
    expect(stamped?.revoked_at).not.toBeNull();
    expect((await listCloudMembers(cloud.owner)).map((m) => m.role)).not.toContain(invited.role);
  });

  it('the owner cannot remove themselves', async () => {
    const cloud = await freshCloud();
    const me = (await getAsyncOrSync(cloud.owner.adapter, `SELECT session_user AS u`)) as {
      u: string;
    };
    expect(await codeOf(() => removeMember(cloud.owner, me.u))).toBe('invalid_request');
    // Still connected, still the owner.
    expect((await listCloudMembers(cloud.owner))[0]?.status).toBe('owner');
  });

  it('a member cannot remove anybody, including themselves', async () => {
    const cloud = await freshCloud();
    const { member, role } = await addMember(cloud);
    const other = await addMember(cloud, 'other');
    expect(await codeOf(() => removeMember(member, other.role))).toBe('cloud_owner_only');
    expect(await codeOf(() => removeMember(member, role))).toBe('cloud_owner_only');
    // Neither role was touched.
    const live = (await listCloudMembers(cloud.owner)).map((m) => m.role);
    expect(live).toContain(role);
    expect(live).toContain(other.role);
  });

  it('a managed session refuses to remove a member', async () => {
    const cloud = await freshCloud();
    const { role } = await addMember(cloud);
    expect(await codeOf(() => removeMember(cloud.owner, role, { managed: true }))).toBe(
      'cloud_managed',
    );
    expect((await listCloudMembers(cloud.owner)).map((m) => m.role)).toContain(role);
  });

  // ── sharing ──────────────────────────────────────────────────────────────

  it('a row owner shares their own row; nobody else can share it', async () => {
    const cloud = await freshCloud();
    const { member } = await addMember(cloud);
    // Observed from a SECOND member, not from the owner connection: the owner
    // bypasses row-level security, so it is the wrong instrument for proving a
    // row is unshared.
    const { member: observer } = await addMember(cloud, 'obs');

    // The member writes a note of their own. Nobody else can see it yet.
    await member.insert('notes', { id: 'm1', body: 'mine' });
    expect(await observer.get('notes', 'm1')).toBeNull();

    // The member owns it, so the member may share it — the capability, not the
    // browser app, is what makes that possible from a script.
    expect(await shareRow(member, { table: 'notes', pk: 'm1', visibility: 'everyone' })).toEqual({
      table: 'notes',
      pk: 'm1',
      visibility: 'everyone',
    });
    expect((await observer.get('notes', 'm1'))?.body).toBe('mine');

    // The owner's own private note is not the member's to share: the database
    // raises, exactly as it did through a request.
    await cloud.owner.insert('notes', { id: 'o1', body: 'theirs' });
    const refused = await codeOf(() =>
      shareRow(member, { table: 'notes', pk: 'o1', visibility: 'everyone' }),
    );
    expect(refused, 'the definer function refuses a non-owner').toMatch(/^untagged:/);
    expect(await member.get('notes', 'o1'), 'and it stayed invisible').toBeNull();
    expect(await observer.get('notes', 'o1')).toBeNull();
  });

  it('refuses an incomplete share, and one against a workspace that is not a cloud', async () => {
    const cloud = await freshCloud();
    expect(
      await codeOf(() => shareRow(cloud.owner, { table: '', pk: 'x', visibility: 'everyone' })),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => shareRow(cloud.owner, { table: 'notes', pk: '', visibility: 'everyone' })),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => shareRow(cloud.owner, { table: 'notes', pk: 'x', visibility: '' })),
    ).toBe('invalid_request');
  });

  it('a row owner grants one person access, then takes it back', async () => {
    const cloud = await freshCloud();
    const { member, role } = await addMember(cloud);
    await cloud.owner.insert('notes', { id: 'o2', body: 'for you' });
    expect(await member.get('notes', 'o2')).toBeNull();

    expect(await grantRowAccess(cloud.owner, { table: 'notes', pk: 'o2', grantee: role })).toEqual({
      table: 'notes',
      pk: 'o2',
      grantee: role,
      revoked: false,
    });
    expect((await member.get('notes', 'o2'))?.body).toBe('for you');

    await grantRowAccess(cloud.owner, { table: 'notes', pk: 'o2', grantee: role, revoke: true });
    expect(await member.get('notes', 'o2')).toBeNull();
  });

  it('a member cannot grant access to a row they do not own', async () => {
    const cloud = await freshCloud();
    const { member, role } = await addMember(cloud);
    await cloud.owner.insert('notes', { id: 'o3', body: 'secret' });
    const refused = await codeOf(() =>
      grantRowAccess(member, { table: 'notes', pk: 'o3', grantee: role }),
    );
    expect(refused).toMatch(/^untagged:/);
    expect(await member.get('notes', 'o3')).toBeNull();
  });

  it('a batch settles a whole audience in one call', async () => {
    const cloud = await freshCloud();
    const a = await addMember(cloud, 'ba');
    const b = await addMember(cloud, 'bb');
    await cloud.owner.insert('notes', { id: 'o4', body: 'group read' });

    const result = await batchRowAccess(cloud.owner, {
      table: 'notes',
      pk: 'o4',
      grant: [a.role, b.role],
    });
    expect(result.granted).toEqual([a.role, b.role]);
    expect((await a.member.get('notes', 'o4'))?.body).toBe('group read');
    expect((await b.member.get('notes', 'o4'))?.body).toBe('group read');

    await batchRowAccess(cloud.owner, { table: 'notes', pk: 'o4', revoke: [a.role] });
    expect(await a.member.get('notes', 'o4')).toBeNull();
    expect((await b.member.get('notes', 'o4'))?.body, 'the other grant survived').toBe(
      'group read',
    );
  });

  it('a member cannot batch-grant a row they do not own', async () => {
    const cloud = await freshCloud();
    const { member, role } = await addMember(cloud);
    await cloud.owner.insert('notes', { id: 'o5', body: 'still secret' });
    expect(
      await codeOf(() => batchRowAccess(member, { table: 'notes', pk: 'o5', grant: [role] })),
    ).toMatch(/^untagged:/);
    expect(await member.get('notes', 'o5')).toBeNull();
  });

  // ── sharing a dashboard carries its data ─────────────────────────────────

  // Sharing a dashboard row is only half the operation: the page reads other
  // tables, so a recipient who gets the row and nothing else opens it to an empty
  // page. Carrying the data along is what makes these three functions rather than
  // the bare database primitives, and it is asserted HERE — through the calls a
  // caller actually makes — because a test that invoked the cascade directly would
  // keep passing if no caller ever reached it. Each case is read back from a
  // scoped member connection, the only instrument that can tell shared from
  // merely-marked-shared.

  it('sharing a dashboard to everyone carries the data its page reads', async () => {
    const cloud = await freshCloud();
    const { member: observer } = await addMember(cloud, 'obs');
    await cloud.owner.insert('notes', { id: 'n1', body: 'behind the page' });
    await makeDashboard(cloud.owner, 'd1', ['notes']);
    expect(await observer.get('notes', 'n1')).toBeNull();

    // Narrowing is not sharing: the same call with `private` must leave the data
    // exactly as it found it, or unsharing a page would quietly hand its tables out.
    await shareRow(cloud.owner, { table: 'dashboards', pk: 'd1', visibility: 'private' });
    expect(await observer.get('notes', 'n1')).toBeNull();

    await shareRow(cloud.owner, { table: 'dashboards', pk: 'd1', visibility: 'everyone' });
    expect((await observer.get('dashboards', 'd1'))?.title).toBe('Report');
    expect((await observer.get('notes', 'n1'))?.body, 'the page is not empty').toBe(
      'behind the page',
    );
  });

  it('granting one person a dashboard carries the data to that person only', async () => {
    const cloud = await freshCloud();
    const invitee = await addMember(cloud, 'ga');
    const bystander = await addMember(cloud, 'gb');
    await cloud.owner.insert('notes', { id: 'n2', body: 'behind the page' });
    await makeDashboard(cloud.owner, 'd2', ['notes']);

    await grantRowAccess(cloud.owner, { table: 'dashboards', pk: 'd2', grantee: invitee.role });
    expect((await invitee.member.get('notes', 'n2'))?.body).toBe('behind the page');
    expect(await bystander.member.get('notes', 'n2'), 'nobody else was named').toBeNull();

    // Taking the page back never strips the data from whoever still has it. The
    // standing share is keyed to the table, not to this one dashboard, so a revoke
    // that undid it would also empty every other page of yours reading that table.
    await grantRowAccess(cloud.owner, {
      table: 'dashboards',
      pk: 'd2',
      grantee: invitee.role,
      revoke: true,
    });
    expect(await invitee.member.get('dashboards', 'd2')).toBeNull();
    expect((await invitee.member.get('notes', 'n2'))?.body).toBe('behind the page');
  });

  it('a batch grant carries the data to everyone in the batch and nobody outside it', async () => {
    const cloud = await freshCloud();
    const first = await addMember(cloud, 'na');
    const second = await addMember(cloud, 'nb');
    const outsider = await addMember(cloud, 'nc');
    await cloud.owner.insert('notes', { id: 'n3', body: 'behind the page' });
    await makeDashboard(cloud.owner, 'd3', ['notes']);

    await batchRowAccess(cloud.owner, {
      table: 'dashboards',
      pk: 'd3',
      grant: [first.role, second.role],
    });
    expect((await first.member.get('notes', 'n3'))?.body).toBe('behind the page');
    expect((await second.member.get('notes', 'n3'))?.body).toBe('behind the page');
    expect(await outsider.member.get('notes', 'n3'), 'not in the batch').toBeNull();
  });

  // ── joining ──────────────────────────────────────────────────────────────

  it('redeeming an invite registers a workspace and claims the invite, once', async () => {
    const cloud = await freshCloud();
    const invited = await inviteMember(cloud.owner, {
      email: 'joiner@example.test',
      configPath: cloud.configPath,
    });
    roles.push(invited.role);
    const root = scratch('join-root');

    const joined = await redeemCloudInvite({
      email: 'joiner@example.test',
      token: invited.token,
      label: 'Shared cloud',
      latticeRoot: root,
    });
    expect(joined.isCloud).toBe(true);

    // A real workspace exists, is active, and its credential is the member's.
    const registered: WorkspaceRecord[] = listWorkspaces(root);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(joined.workspaceId);
    expect(registered[0]?.kind).toBe('cloud');
    expect(getActiveWorkspace(root)?.id).toBe(joined.workspaceId);
    const credential = getDbCredential('shared-cloud');
    expect(credential, 'the key is a sanitized slug of the label').toContain(invited.role);

    // The invite is now spent.
    const ledger = (await getAsyncOrSync(
      cloud.owner.adapter,
      `SELECT "redeemed_at" FROM "__lattice_member_invites" WHERE "role" = ?`,
      [invited.role],
    )) as { redeemed_at: string | null } | undefined;
    expect(ledger?.redeemed_at).not.toBeNull();
    expect((await listCloudMembers(cloud.owner)).find((m) => m.role === invited.role)?.status).toBe(
      'member',
    );

    // Replaying the same token is refused — one-time use, enforced in the database.
    expect(
      await codeOf(() =>
        redeemCloudInvite({
          email: 'joiner@example.test',
          token: invited.token,
          latticeRoot: scratch('join-replay'),
        }),
      ),
    ).toBe('cloud_invite_rejected');
  });

  it('the wrong email cannot open an invite', async () => {
    const cloud = await freshCloud();
    const invited = await inviteMember(cloud.owner, {
      email: 'right@example.test',
      configPath: cloud.configPath,
    });
    roles.push(invited.role);
    expect(
      await codeOf(() =>
        redeemCloudInvite({
          email: 'wrong@example.test',
          token: invited.token,
          latticeRoot: scratch('join-wrong'),
        }),
      ),
    ).toBe('cloud_invite_token');
  });

  it('joining with the credential directly works, and registers nothing on failure', async () => {
    const cloud = await freshCloud();
    const role = `lm_direct_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(cloud.owner, role, pw);
    const coords = cloudCoordsForConfig(cloud.configPath);
    expect(coords, 'the config resolves to the cloud it names').not.toBeNull();

    const root = scratch('direct-root');
    const joined = await joinCloud(
      {
        host: coords!.host,
        port: coords!.port,
        dbname: coords!.dbname,
        user: role,
        password: pw,
      },
      { label: 'Direct join', latticeRoot: root },
    );
    expect(listWorkspaces(root).map((w) => w.id)).toEqual([joined.workspaceId]);

    // A wrong password never gets as far as making a workspace.
    const failRoot = scratch('direct-fail');
    expect(
      await codeOf(() =>
        joinCloud(
          {
            host: coords!.host,
            port: coords!.port,
            dbname: coords!.dbname,
            user: role,
            password: 'deadbeefdeadbeefdeadbeefdeadbeef',
          },
          { label: 'Nope', latticeRoot: failRoot },
        ),
      ),
    ).toBe('cloud_unreachable');
    expect(listWorkspaces(failRoot)).toEqual([]);
  });

  it('a plain Postgres database is refused until somebody makes it a cloud', async () => {
    const dbname = `lattice_bare_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const url = new URL(dbUrl(dbname));
    const root = scratch('bare-root');
    expect(
      await codeOf(() =>
        joinCloud(
          {
            host: url.hostname,
            port: Number(url.port || '5432'),
            dbname,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          },
          { label: 'Not a cloud', latticeRoot: root },
        ),
      ),
    ).toBe('cloud_not_lattice');
    expect(listWorkspaces(root)).toEqual([]);
  });
});

describe('cloud capabilities on a workspace that is not a cloud', () => {
  // These need no Postgres at all: refusing a local, single-user workspace is
  // part of the contract, and a caller with no database server should still be
  // able to see that refusal.
  let local: Lattice | null = null;
  const dirs: string[] = [];

  afterEach(() => {
    if (local) {
      try {
        local.close();
      } catch {
        /* best-effort */
      }
      local = null;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function openLocal(): Lattice {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-cloudcap-local-'));
    dirs.push(dir);
    local = new Lattice(join(dir, 'db.sqlite'));
    local.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    return local;
  }

  it('sharing tells you plainly that it needs a cloud', async () => {
    const db = openLocal();
    await db.init();
    expect(
      await codeOf(() => shareRow(db, { table: 'notes', pk: 'n1', visibility: 'everyone' })),
    ).toBe('cloud_required');
    expect(
      await codeOf(() => grantRowAccess(db, { table: 'notes', pk: 'n1', grantee: 'lm_x' })),
    ).toBe('cloud_required');
    expect(
      await codeOf(() => batchRowAccess(db, { table: 'notes', pk: 'n1', grant: ['lm_x'] })),
    ).toBe('cloud_required');
  });

  it('inviting and removing tell you the same', async () => {
    const db = openLocal();
    await db.init();
    const dir = mkdtempSync(join(tmpdir(), 'lattice-cloudcap-cfg-'));
    dirs.push(dir);
    const configPath = join(dir, 'workspace.yml');
    writeFileSync(configPath, 'name: local\ndb: "./db.sqlite"\nentities: []\n', 'utf8');
    expect(await codeOf(() => inviteMember(db, { email: 'a@b.test', configPath }))).toBe(
      'cloud_required',
    );
    expect(await codeOf(() => removeMember(db, 'lm_x'))).toBe('cloud_required');
  });

  it('there are no members to list on a local workspace', async () => {
    const db = openLocal();
    await db.init();
    expect(await listCloudMembers(db)).toEqual([]);
  });

  it('a workspace whose open fails is rolled back, not left half-made', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-cloudcap-rollback-'));
    dirs.push(root);
    const boom = new Error('could not open the cloud');
    await expect(
      createCloudWorkspace(root, 'Broken cloud', 'broken-cloud', 'postgres://x/y', {
        open: () => Promise.reject(boom),
      }),
    ).rejects.toThrow('could not open the cloud');
    // Nothing registered, and the credential that was written first is gone —
    // otherwise a retry would collide with a workspace nobody can reach.
    expect(listWorkspaces(root)).toEqual([]);
    expect(getDbCredential('broken-cloud')).toBeNull();
  });
});
