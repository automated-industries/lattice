/**
 * Securing a CONNECTED table must not blind the people whose rows it holds.
 *
 * A connected table is secured by its own pass rather than by the cutover that
 * secures authored tables, because its rows belong to whoever synced them rather
 * than to whoever happens to be registering the table. That pass has to write an
 * ownership record for every row that already exists, and `FORCE ROW LEVEL
 * SECURITY` applies the row-visibility policy to the table's OWNER as well — so
 * once the policies are on, a role without BYPASSRLS can no longer SELECT the
 * rows it is trying to attribute. Attribution therefore has to happen while the
 * policies are lifted, in the same transaction, or it reads through the very
 * policy it exists to populate and writes nothing at all. Nothing raises when it
 * gets this wrong: the rows stay in the table and simply stop being visible to
 * anyone, permanently.
 *
 * The connector REGISTRY is the second half of the same failure. It is owner-only
 * bookkeeping — members hold no grant on it — so putting the per-table row-security
 * primitive on it protects nothing, and with no ownership records it hid the
 * registry from a non-BYPASSRLS owner. That broke connector lookups outright, and
 * broke attribution too, since a row is attributed by joining the registry to find
 * who connected it.
 *
 * Every other Postgres suite connects as the cluster's bootstrap superuser, which
 * reads through every policy, so neither failure is observable there — the rows
 * come back either way. These tests connect as a realistic restricted owner
 * (provisionRestrictedOwner) and assert on ROW COUNTS AND VALUES, never on the
 * absence of an exception.
 *
 * Postgres-gated (real per-test cloud database, a real restricted owner role, and
 * a real scoped member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { installCloudRls, memberGroupFor, enableRlsForTable } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { enableConnectorRls } from '../../src/connectors/acl.js';
import { createConnector, getConnector, CONNECTORS_TABLE } from '../../src/connectors/registry.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import type {
  Connector,
  ConnectedModelDef,
  ToolkitPresentation,
} from '../../src/connectors/types.js';
import { provisionRestrictedOwner } from './helpers/restricted-owner.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];
const pools: pg.Pool[] = [];

const TOOLKIT = 'testkit';
const TABLE = 'conn_notes';

/** pg maps a Postgres `bool` to a JS boolean; tolerate the 't' / 1 spellings too,
 *  exactly as the product's own catalog checks do. */
const isTrue = (v: unknown): boolean => v === true || v === 't' || v === 1;

/** The connected table's definition — a natural-key PK plus the `source`
 *  descriptor, which is what adds the connector lineage columns and marks the
 *  table as one the connector pass (not the authored-table cutover) secures. */
const MODEL: ConnectedModelDef = {
  model: 'note',
  table: TABLE,
  naturalKey: 'id',
  definition: {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: `${TABLE}.md`,
    source: { connector: 'test', toolkit: TOOLKIT, model: 'note', naturalKey: 'id' },
  },
};

/**
 * A connector that exposes exactly one model. `enableConnectorRls` reads the model
 * list and nothing else; the fetch/auth half of the contract is unreachable here,
 * so it raises rather than returning a stand-in that would let a wrong call pass
 * unnoticed.
 */
const CONNECTOR: Connector = {
  connector: 'test',
  toolkits: () => [TOOLKIT],
  models: (toolkit: string) => (toolkit === TOOLKIT ? [MODEL] : []),
  presentation: (): ToolkitPresentation => ({ label: 'Test' }),
  authorize: () => {
    throw new Error('test connector: authorize is not part of this test');
  },
  completeAuth: () => {
    throw new Error('test connector: completeAuth is not part of this test');
  },
  listChanges: () => {
    throw new Error('test connector: listChanges is not part of this test');
  },
  disconnect: () => {
    throw new Error('test connector: disconnect is not part of this test');
  },
};

function memberUrl(dbname: string, user: string, password: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  u.username = user;
  u.password = password;
  return u.toString();
}

/** A restricted (non-BYPASSRLS) owner on its own database, already secured, plus a
 *  scoped member login role. */
async function newCloud(tag: string): Promise<{
  owner: Lattice;
  dbname: string;
  memberRole: string;
  memberPassword: string;
}> {
  const dbname = `lattice_${tag}_${randomBytes(4).toString('hex')}`;
  const role = `lo_${tag}_${randomBytes(3).toString('hex')}`;
  databases.push(dbname);
  const url = await provisionRestrictedOwner(PG_URL!, dbname, role);
  roles.push(role);

  const owner = new Lattice(url);
  opened.push(owner);
  await owner.init();
  await secureCloud(owner);
  // Securing mints the per-cloud member group, which is cluster-level and so
  // survives dropping the database. Track it for teardown.
  roles.push(await memberGroupFor(owner));

  const memberRole = `lm_${tag}_${randomBytes(3).toString('hex')}`;
  const memberPassword = generateMemberPassword();
  roles.push(memberRole);
  await provisionMemberRole(owner, memberRole, memberPassword);
  return { owner, dbname, memberRole, memberPassword };
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end().catch(() => undefined);
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  // Databases BEFORE roles: the restricted owner owns its database, and Postgres
  // refuses to drop a role that still owns one.
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('connector securing under a restricted (non-BYPASSRLS) owner', () => {
  it('attributes pre-existing synced rows to the member who synced them, and leaves both sides able to read', async () => {
    const { owner, dbname, memberRole, memberPassword } = await newCloud('cro');

    // Two connector instances: one the member connected, and one whose connecting
    // role no longer exists (a member who was removed). Registering either creates
    // the registry table on demand, exactly as a real connect does.
    const memberConnector = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-member',
      connectedBy: memberRole,
    });
    const ghostConnector = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-ghost',
      connectedBy: `lm_gone_${randomBytes(3).toString('hex')}`, // never provisioned
    });

    // The connected table exists and holds synced rows BEFORE anything secures it —
    // the state a member's first sync leaves, since only the owner can enable row
    // security. No trigger exists yet, so none of these rows has an ownership record.
    await owner.defineLate(TABLE, MODEL.definition);
    await owner.insert(TABLE, {
      id: 'm1',
      body: 'member one',
      _source_connector_id: memberConnector,
    });
    await owner.insert(TABLE, {
      id: 'm2',
      body: 'member two',
      _source_connector_id: memberConnector,
    });
    await owner.insert(TABLE, { id: 'g1', body: 'ghost', _source_connector_id: ghostConnector });
    await owner.insert(TABLE, { id: 'o1', body: 'no connector', _source_connector_id: null });

    await enableConnectorRls(owner, CONNECTOR, TOOLKIT);

    // Guard against a vacuous pass from either direction: a BYPASSRLS connection or
    // a table that was never actually forced would satisfy the reads below without
    // saying anything about the invariant.
    const who = (await getAsyncOrSync(
      owner.adapter,
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    )) as Record<string, unknown>;
    expect(isTrue(who.rolsuper)).toBe(false);
    expect(isTrue(who.rolbypassrls)).toBe(false);
    expect(isTrue(who.rolcreaterole)).toBe(true); // the owner gate reads this

    const rel = (await getAsyncOrSync(
      owner.adapter,
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [TABLE],
    )) as Record<string, unknown>;
    expect(isTrue(rel.relrowsecurity)).toBe(true);
    expect(isTrue(rel.relforcerowsecurity)).toBe(true);

    // The owner keeps the rows that are ITS OWN: the one with no connector, and the
    // one whose connecting role is gone (attributing a row to a role that does not
    // exist would leave it owned by nobody, i.e. dark again).
    const ownerRows = await owner.query(TABLE, {});
    expect(ownerRows.map((r) => r.id).sort()).toEqual(['g1', 'o1']);

    // …and does NOT take the member's rows. Silently re-attributing them to the
    // owner is the other way to make this test's row counts look healthy while the
    // data has been misfiled.
    expect(await owner.get(TABLE, 'm1')).toBeFalsy();
    expect(await owner.get(TABLE, 'm2')).toBeFalsy();

    // The member sees exactly the rows their connector synced.
    const member = new Lattice(memberUrl(dbname, memberRole, memberPassword));
    opened.push(member);
    await member.init();
    const memberRows = await member.query(TABLE, {});
    expect(memberRows.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
    expect((await member.get(TABLE, 'm1'))?.body).toBe('member one');

    // Securing the connected tables must leave the registry readable by the owner —
    // every connector lookup goes through it.
    expect((await getConnector(owner, memberConnector))?.connectionRef).toBe('ref-member');
  });

  it('heals a table an earlier build already forced with rows that have no ownership record', async () => {
    const { owner, dbname, memberRole, memberPassword } = await newCloud('crh');
    const memberConnector = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-member',
      connectedBy: memberRole,
    });

    await owner.defineLate(TABLE, MODEL.definition);
    await owner.insert(TABLE, {
      id: 'm1',
      body: 'member one',
      _source_connector_id: memberConnector,
    });
    await owner.insert(TABLE, { id: 'o1', body: 'no connector', _source_connector_id: null });

    // Arrange the state an earlier build left behind: the table is FORCED and its
    // rows have no ownership record. Securing it is the real path; the ownership
    // records are then removed because that build's securing wrote none, which is
    // exactly what made those rows dark.
    await enableConnectorRls(owner, CONNECTOR, TOOLKIT);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "__lattice_owners" WHERE "table_name" = $1`, [
      TABLE,
    ]);

    const member = new Lattice(memberUrl(dbname, memberRole, memberPassword));
    opened.push(member);
    await member.init();

    // Assert the arranged state really is dark, on BOTH sides — otherwise a repair
    // that did nothing could pass this test by starting from a healthy table.
    expect(await owner.query(TABLE, {})).toEqual([]);
    expect(await member.query(TABLE, {})).toEqual([]);

    // The repair reaches such a table through the per-table version key: a release
    // that changes the securing SQL bumps the key, so the SQL runs again over a
    // table that already has rows and is already forced. Dropping the recorded key
    // is what a bump does to the gate, so this drives the real securing path.
    await runAsyncOrSync(
      owner.adapter,
      `DELETE FROM "__lattice_migrations" WHERE "version" LIKE $1`,
      [`internal:cloud-rls:table:${TABLE}:%`],
    );
    await enableConnectorRls(owner, CONNECTOR, TOOLKIT);

    expect((await owner.query(TABLE, {})).map((r) => r.id)).toEqual(['o1']);
    expect((await member.query(TABLE, {})).map((r) => r.id)).toEqual(['m1']);

    // The table is still forced afterwards — a repair that healed the rows by
    // leaving row security off would satisfy the two reads above and unprotect the
    // table.
    const rel = (await getAsyncOrSync(
      owner.adapter,
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [TABLE],
    )) as Record<string, unknown>;
    expect(isTrue(rel.relrowsecurity)).toBe(true);
    expect(isTrue(rel.relforcerowsecurity)).toBe(true);

    // Securing the same table twice leaves one policy per operation, not two. Every
    // future release that changes this SQL bumps the key and runs it again, so
    // anything here that accumulated would accumulate once per release forever.
    const pol = (await getAsyncOrSync(
      owner.adapter,
      `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [TABLE],
    )) as { n?: unknown };
    expect(Number(pol.n)).toBe(4); // select, update, delete, insert
  });

  it('attributes correctly when securing runs before anything has reopened the registry', async () => {
    const { owner, dbname, memberRole, memberPassword } = await newCloud('cro2');
    const memberConnector = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-member',
      connectedBy: memberRole,
    });

    await owner.defineLate(TABLE, MODEL.definition);
    await owner.insert(TABLE, {
      id: 'm1',
      body: 'member one',
      _source_connector_id: memberConnector,
    });
    await owner.insert(TABLE, { id: 'o1', body: 'no connector', _source_connector_id: null });

    // The state an earlier build left: the registry itself row-secured with no
    // ownership records, so it reads as EMPTY to a non-BYPASSRLS owner. Bump the
    // per-table key so the securing SQL — and with it the stamp — runs again.
    await enableRlsForTable(owner, CONNECTORS_TABLE, ['id']);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "__lattice_owners" WHERE "table_name" = $1`, [
      CONNECTORS_TABLE,
    ]);
    await runAsyncOrSync(
      owner.adapter,
      `DELETE FROM "__lattice_migrations" WHERE "version" LIKE $1`,
      [`internal:cloud-rls:table:${TABLE}:%`],
    );

    // Secure WITHOUT the owner-open bootstrap having reopened the registry first.
    // A headless sync reaches this path (opening a workspace for the CLI does not
    // run that bootstrap), and in the app it runs in the background, so securing
    // cannot depend on it having finished. The stamp attributes a connected row by
    // joining the registry, so a registry that reads as empty attributes EVERY row
    // to the securing session instead — silently, and for good, because the stamp
    // only ever writes records that are missing. Nothing raises.
    await enableConnectorRls(owner, CONNECTOR, TOOLKIT);

    const stamped = (await getAsyncOrSync(
      owner.adapter,
      `SELECT "owner_role" FROM "__lattice_owners" WHERE "table_name" = $1 AND "pk" = 'm1'`,
      [TABLE],
    )) as { owner_role?: unknown };
    expect(stamped.owner_role).toBe(memberRole);

    const member = new Lattice(memberUrl(dbname, memberRole, memberPassword));
    opened.push(member);
    await member.init();
    expect((await member.query(TABLE, {})).map((r) => r.id)).toEqual(['m1']);
    expect((await owner.query(TABLE, {})).map((r) => r.id)).toEqual(['o1']);
  });

  it('reopens a connector registry that a prior build left row-secured, without exposing it to members', async () => {
    const { owner, dbname, memberRole, memberPassword } = await newCloud('crc');
    const connectorId = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-member',
      connectedBy: memberRole,
    });

    // Arrange the state a prior build left on clouds that already ran it: the
    // registry routed through the per-table user-table primitive. That is the real
    // primitive, called the way that build called it; the ownership records are then
    // removed because that build's version of it wrote none — which is precisely what
    // made the registry dark.
    await enableRlsForTable(owner, CONNECTORS_TABLE, ['id']);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "__lattice_owners" WHERE "table_name" = $1`, [
      CONNECTORS_TABLE,
    ]);

    // Assert the arranged state really is dark, so a convergence that did nothing
    // could not pass this test by starting from a healthy registry.
    expect(await getConnector(owner, connectorId)).toBeNull();
    const viewBefore = (await getAsyncOrSync(owner.adapter, `SELECT to_regclass($1) AS reg`, [
      `${CONNECTORS_TABLE}_v`,
    ])) as { reg?: unknown };
    expect(viewBefore.reg).toBeTruthy(); // the member-granted read view the securing built

    // Convergence is the owner-open bootstrap itself — no version key, no migration.
    await installCloudRls(owner);

    const rel = (await getAsyncOrSync(
      owner.adapter,
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [CONNECTORS_TABLE],
    )) as Record<string, unknown>;
    expect(isTrue(rel.relrowsecurity)).toBe(false);
    expect(isTrue(rel.relforcerowsecurity)).toBe(false);

    // The owner can read its registry again.
    expect((await getConnector(owner, connectorId))?.connectionRef).toBe('ref-member');

    // And the read view the securing had granted to members is GONE — not because
    // leaving it would leak, but because it is a member read path onto owner-only
    // bookkeeping. It carries the same row-visibility predicate the policies do, so
    // lifting row security does not widen what it returns. What actually closes the
    // leak is the revoke, asserted below: with the base-table grants still standing,
    // turning row security off flips every member from reading zero rows of the
    // registry to reading all of them.
    const viewAfter = (await getAsyncOrSync(owner.adapter, `SELECT to_regclass($1) AS reg`, [
      `${CONNECTORS_TABLE}_v`,
    ])) as { reg?: unknown };
    expect(viewAfter.reg).toBeNull();

    const memberPool = new pg.Pool({
      connectionString: memberUrl(dbname, memberRole, memberPassword),
      max: 1,
    });
    pools.push(memberPool);
    // "read" rather than an exception is the failing answer here: it means the member
    // got rows back. Both reads must be refused, and for different reasons — the view
    // because it no longer exists, the base table because the grants were taken back.
    // The base one is the leak assertion; the view one only records that the path was
    // removed.
    const refusal = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const viaView = await memberPool
      .query(`SELECT count(*)::int AS n FROM "${CONNECTORS_TABLE}_v"`)
      .then(() => 'read', refusal);
    expect(viaView).toMatch(/does not exist/i);
    const viaBase = await memberPool
      .query(`SELECT count(*)::int AS n FROM "${CONNECTORS_TABLE}"`)
      .then(() => 'read', refusal);
    expect(viaBase).toMatch(/permission denied/i);
  });

  it('repairs a registry that something else built a relation on top of', async () => {
    const { owner, memberRole } = await newCloud('crd');
    const connectorId = await createConnector(owner, {
      connector: 'test',
      toolkit: TOOLKIT,
      connectionRef: 'ref-member',
      connectedBy: memberRole,
    });
    await enableRlsForTable(owner, CONNECTORS_TABLE, ['id']);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "__lattice_owners" WHERE "table_name" = $1`, [
      CONNECTORS_TABLE,
    ]);
    // Something reading the member-granted view. Dropping a view a relation depends
    // on RAISES unless the drop cascades, and the repair sits on paths that have no
    // way to recover from a raise — the owner-open bootstrap and the securing
    // migration. Without the cascade this is a workspace that cannot be opened.
    await runAsyncOrSync(
      owner.adapter,
      `CREATE VIEW "conn_reg_reader" AS SELECT "id" FROM "${CONNECTORS_TABLE}_v"`,
    );

    await installCloudRls(owner);

    // The repair completed rather than raising, and the owner can read its registry.
    expect((await getConnector(owner, connectorId))?.connectionRef).toBe('ref-member');
    // Both relations are gone: the dependent was another reachable projection of the
    // same owner-only bookkeeping, so removing it is the point, not collateral.
    for (const rel of [`${CONNECTORS_TABLE}_v`, 'conn_reg_reader']) {
      const found = (await getAsyncOrSync(owner.adapter, `SELECT to_regclass($1) AS reg`, [
        rel,
      ])) as { reg?: unknown };
      expect(found.reg).toBeNull();
    }
  });
});
