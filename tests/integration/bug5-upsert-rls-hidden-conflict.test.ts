/**
 * Bug 5 (connector sync "A record could not be written during sync (possible
 * conflict)") root cause + fix.
 *
 * On a cloud, only the OWNER can ALTER … ENABLE ROW LEVEL SECURITY, so a connected
 * table a scoped MEMBER first syncs is born WITHOUT its ownership trigger — the
 * first-sync rows get no `__lattice_owners` record. Once the owner later
 * FORCE-enables RLS, an ownerless row is visible to NO ONE (lattice_row_visible
 * returns false for a row with no owner), so the member can neither see it nor
 * re-sync it: the sync upsert's `ON CONFLICT DO UPDATE` hits the now-invisible row
 * and Postgres raises "new row violates row-level security policy", which
 * sanitizeConnectorError genericizes to the "possible conflict" the member sees.
 *
 * The fix stamps ownership on those rows two ways:
 *   PREVENT — claimOwnerlessConnectorRows (member-side SECURITY DEFINER) runs right
 *     after a member's sync writes, stamping the member (session_user) as owner.
 *   HEAL — backfillConnectorOwnership (owner-side) runs when the owner secures the
 *     table, stamping each still-ownerless row to its connector's connected_by role.
 *
 * Postgres-gated (real per-test cloud DB + a real non-BYPASSRLS member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { enableRlsForTable } from '../../src/cloud/rls.js';
import { setTableDefaultVisibility } from '../../src/cloud/table-policy.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import {
  backfillConnectorOwnership,
  claimOwnerlessConnectorRows,
} from '../../src/connectors/acl.js';
import { createConnector } from '../../src/connectors/registry.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const opened: Lattice[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A connected-style table: a natural-key PK + the connector-lineage column the
 *  claim/backfill helpers key on. */
function defineConnNotes(db: Lattice): void {
  db.define('conn_notes', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      body: 'TEXT',
      _source_connector_id: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'conn_notes.md',
  });
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

describe.skipIf(!PG_URL)('Bug 5: ownerless connector rows heal (claim + backfill)', () => {
  /** Secure a cloud, define + RLS-secure conn_notes, mint a member, and register a
   *  connector row owned (connected_by) by that member's role. Then plant one
   *  OWNERLESS row (as the pre-RLS first sync would leave), i.e. a physical row with
   *  no __lattice_owners record. */
  async function setup(): Promise<{
    owner: Lattice;
    member: Lattice;
    role: string;
    connectorId: string;
  }> {
    const dbname = `lattice_b5_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname));
    opened.push(owner);
    defineConnNotes(owner);
    await owner.init();
    await secureCloud(owner);
    await enableRlsForTable(owner, 'conn_notes', ['id']);
    await setTableDefaultVisibility(owner, 'conn_notes', 'private');

    const role = `lm_b5_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);

    // Register the connector as connected BY this member's role (what
    // resolveConnectorIdentity records on a cloud).
    const connectorId = await createConnector(owner, {
      connector: 'test',
      toolkit: 'test',
      connectionRef: 'ref-1',
      connectedBy: role,
    });

    // Plant an ownerless row: insert as the owner (BYPASSRLS), then remove its
    // ownership record — exactly the state a member's pre-RLS first sync leaves.
    await owner.upsert('conn_notes', {
      id: 'k1',
      body: 'synced',
      _source_connector_id: connectorId,
    });
    await owner.adapter.runAsync!(
      `DELETE FROM "__lattice_owners" WHERE "table_name" = 'conn_notes' AND "pk" = 'k1'`,
      [],
    );

    const member = new Lattice(dbUrl(dbname, role, pw));
    opened.push(member);
    defineConnNotes(member);
    await member.init();
    return { owner, member, role, connectorId };
  }

  it('reproduces the "possible conflict": a member cannot re-sync an ownerless row', async () => {
    const { member, connectorId } = await setup();
    // The ownerless row is invisible to the member…
    expect(await member.get('conn_notes', 'k1')).toBeFalsy();
    // …and re-syncing it (upsert) hits the invisible row and violates RLS.
    const err = await member
      .upsert('conn_notes', { id: 'k1', body: 'resynced', _source_connector_id: connectorId })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    expect((err as Error).message).toMatch(/row-level security|violat/i);
  });

  it('PREVENT: claimOwnerlessConnectorRows lets the member own + re-sync its rows', async () => {
    const { member, connectorId } = await setup();
    const claimed = await claimOwnerlessConnectorRows(member, 'conn_notes', connectorId);
    expect(claimed).toBe(1);
    // Now visible to the member and re-syncable without conflict.
    expect((await member.get('conn_notes', 'k1'))?.body).toBe('synced');
    await member.upsert('conn_notes', {
      id: 'k1',
      body: 'resynced',
      _source_connector_id: connectorId,
    });
    expect((await member.get('conn_notes', 'k1'))?.body).toBe('resynced');
  });

  it('HEAL: backfillConnectorOwnership stamps the connector member as owner', async () => {
    const { owner, member, connectorId } = await setup();
    await backfillConnectorOwnership(owner, 'conn_notes', 'id');
    // The row is now owned by the member (its connector's connected_by) → visible.
    expect((await member.get('conn_notes', 'k1'))?.body).toBe('synced');
    await member.upsert('conn_notes', {
      id: 'k1',
      body: 'resynced',
      _source_connector_id: connectorId,
    });
    expect((await member.get('conn_notes', 'k1'))?.body).toBe('resynced');
  });

  it('claim only ever takes ownerless rows — never another member’s owned row', async () => {
    const { owner, member, connectorId } = await setup();
    // Give k1 a DIFFERENT owner (a second member role that exists but isn't us).
    const other = `lm_b5o_${randomBytes(3).toString('hex')}`;
    roles.push(other);
    await provisionMemberRole(owner, other, generateMemberPassword());
    await owner.adapter.runAsync!(
      `INSERT INTO "__lattice_owners" ("table_name","pk","owner_role","visibility") VALUES ('conn_notes','k1',$1,'private')`,
      [other],
    );
    // The claim must NOT steal it: it's owned, so nothing is claimed.
    const claimed = await claimOwnerlessConnectorRows(member, 'conn_notes', connectorId);
    expect(claimed).toBe(0);
    expect(await member.get('conn_notes', 'k1')).toBeFalsy(); // still not ours
  });
});
