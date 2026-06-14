/**
 * #3.1 / #3.4 — invite lifecycle, verified against real Postgres.
 *
 *  3.1: `lattice_claim_invite()` enforces ONE-TIME-USE + revocation + expiry. A
 *       member's first claim stamps `redeemed_at` and returns true; a replay (a
 *       leaked/replayed token) returns false; a revoked or expired invite returns
 *       false. The member can only claim its OWN invite (keyed on session_user).
 *  3.4: `revokeMemberRole` is idempotent on an already-gone role (so the re-invite
 *       orphan-cleanup can call it without a spurious failure).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import {
  provisionMemberRole,
  revokeMemberRole,
  generateMemberPassword,
} from '../../src/cloud/members.js';
import { claimMemberInvite } from '../../src/framework/cloud-connect.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

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

async function secureOwner(schema: string): Promise<Lattice> {
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const o = new Lattice(schemaUrl(schema));
  dbs.push(o);
  o.define('gadget', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'gadget.md',
  });
  await o.init();
  await installCloudRls(o);
  return o;
}

/** Provision a member role + insert an invite row for it (pending by default). */
async function inviteMember(
  o: Lattice,
  schema: string,
  opts: { redeemed?: boolean; revoked?: boolean; expired?: boolean } = {},
): Promise<{ role: string; url: string }> {
  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(o, role, pw);
  const expires = opts.expired ? `now() - interval '1 day'` : `now() + interval '7 days'`;
  await runAsyncOrSync(
    o.adapter,
    `INSERT INTO "__lattice_member_invites"
       ("id","role","email_hash","expires_at","redeemed_at","revoked_at")
     VALUES (?, ?, ?, ${expires}, ${opts.redeemed ? 'now()' : 'NULL'}, ${opts.revoked ? 'now()' : 'NULL'})`,
    [randomBytes(8).toString('hex'), role, 'hash-' + role],
  );
  return { role, url: memberUrl(schema, role, pw) };
}

describe.skipIf(!PG_URL)('#3.1/#3.4 invite lifecycle', () => {
  it('3.1: a pending invite claims once, then a replay returns false (one-time-use)', async () => {
    const schema = `inv_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    const { role, url } = await inviteMember(o, schema);

    const first = await claimMemberInvite(url);
    expect(first.claimed).toBe(true); // legitimate first redeem

    const replay = await claimMemberInvite(url);
    expect(replay.claimed).toBe(false); // leaked/replayed token — rejected

    // redeemed_at was stamped exactly once.
    const row = (await getAsyncOrSync(
      o.adapter,
      `SELECT "redeemed_at" IS NOT NULL AS redeemed FROM "__lattice_member_invites" WHERE "role" = ?`,
      [role],
    )) as { redeemed?: unknown } | undefined;
    expect(row?.redeemed === true || row?.redeemed === 't').toBe(true);
  });

  it('3.1: a revoked invite cannot be claimed', async () => {
    const schema = `inv_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    const { url } = await inviteMember(o, schema, { revoked: true });
    expect((await claimMemberInvite(url)).claimed).toBe(false);
  });

  it('3.1: an expired invite cannot be claimed', async () => {
    const schema = `inv_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    const { url } = await inviteMember(o, schema, { expired: true });
    expect((await claimMemberInvite(url)).claimed).toBe(false);
  });

  it('3.1: a member cannot claim ANOTHER member’s invite (keyed on session_user)', async () => {
    const schema = `inv_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    const a = await inviteMember(o, schema);
    const b = await inviteMember(o, schema);
    // b connects but a's invite stays pending — b's claim only ever touches b's row.
    expect((await claimMemberInvite(b.url)).claimed).toBe(true);
    const aPending = (await getAsyncOrSync(
      o.adapter,
      `SELECT "redeemed_at" IS NULL AS pending FROM "__lattice_member_invites" WHERE "role" = ?`,
      [a.role],
    )) as { pending?: unknown } | undefined;
    expect(aPending?.pending === true || aPending?.pending === 't').toBe(true);
  });

  it('3.4: revokeMemberRole is idempotent on an already-gone role', async () => {
    const schema = `inv_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    await provisionMemberRole(o, role, generateMemberPassword());
    await revokeMemberRole(o, role); // first revoke drops it
    // second revoke on the now-absent role must NOT throw (no "role does not exist")
    await expect(revokeMemberRole(o, role)).resolves.toBeUndefined();
  });
});
