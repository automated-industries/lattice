/**
 * #2.2 / #2.3 — RLS hardening, verified against real Postgres.
 *  2.2: a table secured via secureNewCloudTable has RLS enabled + forced (so a
 *       runtime-created cloud table isn't left wide open).
 *  2.3: the changelog SELECT policy FAILS CLOSED on a derived row with an empty
 *       source set — a member must not see it (v2 leaked it).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableChangelogRls } from '../../src/cloud/rls.js';
import { secureNewCloudTable } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
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
  await o.ensureObservationSubstrate();
  await enableChangelogRls(o);
  return o;
}

describe.skipIf(!PG_URL)('#2.2/#2.3 cloud RLS hardening', () => {
  it('2.2: secureNewCloudTable enables + forces RLS on the table', async () => {
    const schema = `p2_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    await secureNewCloudTable(o, 'gadget', ['id']);
    const row = (await getAsyncOrSync(
      o.adapter,
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = 'gadget' AND relnamespace = ($1)::regnamespace`,
      [`"${schema}"`],
    )) as { relrowsecurity?: boolean; relforcerowsecurity?: boolean } | undefined;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });

  it('2.3: a member cannot see a derived changelog row with an EMPTY source set', async () => {
    const schema = `p2_${randomBytes(4).toString('hex')}`;
    const o = await secureOwner(schema);
    // Owner inserts a derived observation with an empty source_ref array.
    await runAsyncOrSync(
      o.adapter,
      `INSERT INTO "__lattice_changelog"
         (id, table_name, row_id, operation, change_kind, source_ref, created_at)
       VALUES ('cl-empty', 'gadget', 'r1', 'update', 'derived', '[]', '2026-01-01T00:00:00Z')`,
    );

    // A scoped member connects and reads the changelog.
    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(o, role, pw);
    const member = new Lattice(memberUrl(schema, role, pw));
    dbs.push(member);
    await member.init({ introspectOnly: true });

    const seen = (await getAsyncOrSync(
      member.adapter,
      `SELECT count(*)::int AS n FROM "__lattice_changelog" WHERE id = 'cl-empty'`,
    )) as { n?: number } | undefined;
    expect(seen?.n).toBe(0); // fail-closed: empty-source derived row is hidden (v2 leaked it)
  });
});
