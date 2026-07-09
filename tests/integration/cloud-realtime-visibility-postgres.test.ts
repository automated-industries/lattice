/**
 * Realtime NOTIFY fan-out is filtered PER RECIPIENT. The change feed is global
 * (every change on the whole cloud), so without a gate a member's realtime stream
 * would disclose the pk / existence of rows it cannot read.
 * `changeVisibleToActiveRole` probes the row through the same RLS visibility
 * predicate, keyed on the connecting role — so a member sees only its own /
 * everyone / granted rows. A delete's live row is gone, so it is gated from the
 * PRE-DELETE visibility snapshot the delete trigger captures (the same
 * per-recipient decision); a delete with no snapshot fails closed. Deletes are
 * also excluded from the reconnect catch-up, so a deleted private row's pk can
 * leak on neither path.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import { secureNewCloudTable } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { changeVisibleToActiveRole } from '../../src/gui/server.js';
import type { RealtimePayload } from '../../src/gui/realtime.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function memberUrl(schema: string, role: string, pw: string): string {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = pw;
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

function payload(op: string, pk: string): RealtimePayload {
  return { seq: 1, table_name: 'gadget', pk, op, owner_role: 'lm_other', created_at: '' };
}

/** Stand up a fresh secured cloud `gadget` table + N scoped member connections. */
async function setupCloud(
  nMembers: number,
): Promise<{ owner: Lattice; members: Lattice[]; memberRoles: string[] }> {
  const schema = `rt_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const owner = new Lattice(schemaUrl(schema));
  dbs.push(owner);
  owner.define('gadget', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'gadget.md',
  });
  await owner.init();
  await installCloudRls(owner);
  await secureNewCloudTable(owner, 'gadget', ['id']);
  const members: Lattice[] = [];
  const memberRoles: string[] = [];
  for (let i = 0; i < nMembers; i++) {
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    memberRoles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    const m = new Lattice(memberUrl(schema, role, pw));
    dbs.push(m);
    await m.init({ introspectOnly: true });
    members.push(m);
  }
  return { owner, members, memberRoles };
}

/** The delete-event visibility snapshot the trigger captured for `pk`, as a payload. */
async function deletePayload(owner: Lattice, pk: string): Promise<RealtimePayload> {
  const rows = (await allAsyncOrSync(
    owner.adapter,
    `SELECT "del_owner_role", "del_visibility", "del_grantees"
       FROM "__lattice_changes" WHERE table_name='gadget' AND pk=? AND op='delete'
      ORDER BY seq DESC LIMIT 1`,
    [pk],
  )) as {
    del_owner_role: string | null;
    del_visibility: string | null;
    del_grantees: string[] | null;
  }[];
  const r = rows[0];
  return {
    seq: 99,
    table_name: 'gadget',
    pk,
    op: 'delete',
    owner_role: null,
    created_at: '',
    del_owner_role: r?.del_owner_role ?? null,
    del_visibility: r?.del_visibility ?? null,
    del_grantees: r?.del_grantees ?? [],
  };
}

describe.skipIf(!PG_URL)('realtime per-recipient visibility gate', () => {
  it('drops an upsert for a row the member cannot read; passes a readable one', async () => {
    const schema = `rt_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const owner = new Lattice(schemaUrl(schema));
    dbs.push(owner);
    owner.define('gadget', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'gadget.md',
    });
    await owner.init();
    await installCloudRls(owner);
    await secureNewCloudTable(owner, 'gadget', ['id']);
    // Owner makes one PRIVATE row and one EVERYONE-visible row.
    await owner.insert('gadget', { id: 'priv', name: 'secret' });
    await owner.insertForcingVisibility('gadget', { id: 'shared', name: 'public' }, 'everyone');

    // A scoped member connects.
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    const member = new Lattice(memberUrl(schema, role, pw));
    dbs.push(member);
    await member.init({ introspectOnly: true });

    // The member must NOT be told about the owner's private-row change…
    expect(await changeVisibleToActiveRole(member, payload('upsert', 'priv'))).toBe(false);
    // …but SHOULD be told about the everyone-visible row's change.
    expect(await changeVisibleToActiveRole(member, payload('upsert', 'shared'))).toBe(true);
    // The owner sees its own private row's change.
    expect(await changeVisibleToActiveRole(owner, payload('upsert', 'priv'))).toBe(true);
  });

  it('#4.4: lattice_changes_since replays only the caller-visible upserts after a cursor, bounded', async () => {
    const schema = `rt_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const owner = new Lattice(schemaUrl(schema));
    dbs.push(owner);
    owner.define('gadget', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'gadget.md',
    });
    await owner.init();
    await installCloudRls(owner);
    await secureNewCloudTable(owner, 'gadget', ['id']);
    // Owner writes a private + an everyone row (each emits one upsert change).
    await owner.insert('gadget', { id: 'priv', name: 'secret' });
    await owner.insertForcingVisibility('gadget', { id: 'shared', name: 'public' }, 'everyone');

    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    const member = new Lattice(memberUrl(schema, role, pw));
    dbs.push(member);
    await member.init({ introspectOnly: true });

    // The member catches up from cursor 0: it must see ONLY the everyone row's
    // upsert, never the owner's private row (same gate as live fan-out).
    const seen = (await allAsyncOrSync(
      member.adapter,
      `SELECT pk, op FROM lattice_changes_since(0, 500) ORDER BY seq`,
    )) as { pk: string; op: string }[];
    expect(seen.map((r) => r.pk)).toEqual(['shared']);
    expect(seen.every((r) => r.op === 'upsert')).toBe(true);

    // The owner catches up and sees its own private row's change too.
    const ownerSeen = (await allAsyncOrSync(
      owner.adapter,
      `SELECT pk FROM lattice_changes_since(0, 500) ORDER BY seq`,
    )) as { pk: string }[];
    expect(ownerSeen.map((r) => r.pk).sort()).toEqual(['priv', 'shared']);

    // The cursor advances: nothing past the highest seq.
    const max = ownerSeen.length + 1; // both seqs are ≤ 2 in a fresh schema
    const none = (await allAsyncOrSync(
      owner.adapter,
      `SELECT pk FROM lattice_changes_since($1, 500)`,
      [max],
    )) as { pk: string }[];
    expect(none).toHaveLength(0);
  });

  it('fails closed on a delete with no visibility snapshot; never gates SQLite', async () => {
    const { owner } = await setupCloud(0);
    // A delete carrying no pre-delete snapshot (e.g. a legacy event from before the
    // snapshot columns existed) is unprovable → fail closed, never forwarded.
    expect(await changeVisibleToActiveRole(owner, payload('delete', 'whatever'))).toBe(false);

    // SQLite is single-user — no gating at all (delete or upsert).
    const sqlite = new Lattice(':memory:');
    dbs.push(sqlite);
    sqlite.define('gadget', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'gadget.md',
    });
    await sqlite.init();
    expect(await changeVisibleToActiveRole(sqlite, payload('delete', 'x'))).toBe(true);
  });

  it('does NOT forward a deleted private row to a member, but forwards a deleted everyone-row', async () => {
    const { owner, members } = await setupCloud(1);
    const member = members[0]!;
    await owner.insert('gadget', { id: 'dpriv', name: 'secret' });
    await owner.insertForcingVisibility('gadget', { id: 'dpub', name: 'public' }, 'everyone');
    // Hard-delete both as the owner — the DELETE trigger snapshots each row's
    // pre-delete visibility into the change row before its ownership record is gone.
    await runAsyncOrSync(owner.adapter, `DELETE FROM "gadget" WHERE "id" = ?`, ['dpriv']);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "gadget" WHERE "id" = ?`, ['dpub']);

    // THE KEYSTONE (run AS the scoped member): a member must never be told a row it
    // could not read was deleted — the pk + existence stay hidden. Pre-fix this
    // returned true (the leak: every delete fanned out to every member).
    expect(await changeVisibleToActiveRole(member, await deletePayload(owner, 'dpriv'))).toBe(
      false,
    );
    // …but a row everyone could see is fine to forward.
    expect(await changeVisibleToActiveRole(member, await deletePayload(owner, 'dpub'))).toBe(true);
    // The owner is told of its own deletion.
    expect(await changeVisibleToActiveRole(owner, await deletePayload(owner, 'dpriv'))).toBe(true);

    // Reconnect/catch-up can't leak it either — deletes are excluded from the
    // catch-up replay, so the deleted private pk surfaces on neither path.
    const since = (await allAsyncOrSync(
      member.adapter,
      `SELECT pk, op FROM lattice_changes_since(0, 500)`,
    )) as { pk: string; op: string }[];
    expect(since.every((r) => r.op === 'upsert')).toBe(true);
    expect(since.map((r) => r.pk)).not.toContain('dpriv');
  });

  it('forwards a deleted custom-shared row only to its grantee', async () => {
    const { owner, members, memberRoles } = await setupCloud(2);
    const [granted, other] = members as [Lattice, Lattice];
    const grantedRole = memberRoles[0]!;
    await owner.insert('gadget', { id: 'dcustom', name: 'shared' });
    await allAsyncOrSync(owner.adapter, `SELECT lattice_grant_row(?, ?, ?)`, [
      'gadget',
      'dcustom',
      grantedRole,
    ]);
    await runAsyncOrSync(owner.adapter, `DELETE FROM "gadget" WHERE "id" = ?`, ['dcustom']);

    const p = await deletePayload(owner, 'dcustom');
    expect(p.del_visibility).toBe('custom');
    expect(p.del_grantees).toContain(grantedRole);
    expect(await changeVisibleToActiveRole(granted, p)).toBe(true); // the grantee
    expect(await changeVisibleToActiveRole(other, p)).toBe(false); // a non-grantee
  });

  it('lattice_delete_visible agrees with lattice_row_visible for owner/everyone/custom (no drift)', async () => {
    const { owner, members, memberRoles } = await setupCloud(1);
    const member = members[0]!;
    const mRole = memberRoles[0]!;
    await owner.insert('gadget', { id: 'r_priv', name: 'p' });
    await owner.insertForcingVisibility('gadget', { id: 'r_all', name: 'a' }, 'everyone');
    await owner.insert('gadget', { id: 'r_cust', name: 'c' });
    await allAsyncOrSync(owner.adapter, `SELECT lattice_grant_row(?, ?, ?)`, [
      'gadget',
      'r_cust',
      mRole,
    ]);
    for (const pk of ['r_priv', 'r_all', 'r_cust']) {
      const o = (
        (await allAsyncOrSync(
          owner.adapter,
          `SELECT "owner_role", "visibility" FROM "__lattice_owners" WHERE table_name='gadget' AND pk=?`,
          [pk],
        )) as { owner_role: string; visibility: string }[]
      )[0]!;
      const g = (
        (await allAsyncOrSync(
          owner.adapter,
          `SELECT array_agg("grantee_role") AS gs FROM "__lattice_row_grants" WHERE table_name='gadget' AND pk=?`,
          [pk],
        )) as { gs: string[] | null }[]
      )[0];
      const live = (
        (await allAsyncOrSync(member.adapter, `SELECT lattice_row_visible(?, ?) AS v`, [
          'gadget',
          pk,
        ])) as { v: boolean }[]
      )[0]!;
      const del = (
        (await allAsyncOrSync(
          member.adapter,
          `SELECT lattice_delete_visible(?, ?, ?, ?::text[]) AS v`,
          ['gadget', o.owner_role, o.visibility, g?.gs ?? []],
        )) as { v: boolean }[]
      )[0]!;
      // The snapshot predicate must never drift from the live one.
      expect(del.v).toBe(live.v);
    }

    // A row visible ONLY via a standing table-share must ALSO agree between the
    // live and delete predicates — otherwise a "kept live" shared table would drop
    // the realtime delete for its grantees (stale rows until a refetch).
    await allAsyncOrSync(owner.adapter, `SELECT lattice_share_table(?, 'custom', ?::text[])`, [
      'gadget',
      [mRole],
    ]);
    await owner.insert('gadget', { id: 'r_tshare', name: 't' }); // private per-row, shared via table
    const tsOwner = (
      (await allAsyncOrSync(
        owner.adapter,
        `SELECT "owner_role", "visibility" FROM "__lattice_owners" WHERE table_name='gadget' AND pk='r_tshare'`,
      )) as { owner_role: string; visibility: string }[]
    )[0]!;
    const tsLive = (
      (await allAsyncOrSync(
        member.adapter,
        `SELECT lattice_row_visible('gadget','r_tshare') AS v`,
      )) as {
        v: boolean;
      }[]
    )[0]!;
    const tsDel = (
      (await allAsyncOrSync(
        member.adapter,
        `SELECT lattice_delete_visible(?, ?, ?, ?::text[]) AS v`,
        ['gadget', tsOwner.owner_role, tsOwner.visibility, []],
      )) as { v: boolean }[]
    )[0]!;
    expect(tsLive.v).toBe(true); // the table-share reaches the member
    expect(tsDel.v).toBe(tsLive.v); // and the delete predicate mirrors it
  });
});
