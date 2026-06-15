/**
 * #4.3 — realtime NOTIFY fan-out is filtered PER RECIPIENT. The change feed is
 * global (every change on the whole cloud), so without a gate a member's realtime
 * stream would leak the pk / existence / editor of rows it cannot read.
 * `changeVisibleToActiveRole` probes the row through the same RLS visibility
 * function, keyed on the connecting role — so a member sees only its own /
 * everyone / granted rows. Deletes (unprobeable post-trigger) are always
 * forwarded but the editor is stripped by the caller.
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
import { allAsyncOrSync } from '../../src/db/adapter.js';

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

describe.skipIf(!PG_URL)('#4.3 realtime per-recipient visibility gate', () => {
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

  it('always forwards deletes (caller strips the editor) and never gates SQLite', async () => {
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
    // A delete is unprobeable (the ownership row is gone) → forwarded.
    expect(await changeVisibleToActiveRole(owner, payload('delete', 'whatever'))).toBe(true);

    // SQLite is single-user — no gating.
    const sqlite = new Lattice(':memory:');
    dbs.push(sqlite);
    sqlite.define('gadget', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'gadget.md',
    });
    await sqlite.init();
    expect(await changeVisibleToActiveRole(sqlite, payload('upsert', 'x'))).toBe(true);
  });
});
