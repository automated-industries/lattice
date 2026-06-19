/**
 * Backwards-compat regression: a cloud provisioned BEFORE per-cloud member groups
 * has its members in the legacy CLUSTER-GLOBAL `lattice_members` role, not its own
 * per-cloud group — so after upgrading to 4.0 they would lose access. On the
 * owner's next open, reconcileCloudMemberAccess re-grants THIS cloud's per-cloud
 * group to its OWN members (the cloud-local `__lattice_member_invites` registry).
 *
 * The security-critical property pinned here: the re-grant is SCOPED to the cloud's
 * own invite registry and NEVER enumerates the cluster-global legacy group — so a
 * role that belonged to a DIFFERENT cloud (also in `lattice_members`) is NOT granted
 * this cloud's group. A naive "re-grant everyone in lattice_members" would cross-
 * pollinate members between unrelated clouds — exactly what per-cloud groups fix.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, memberGroupFor, LEGACY_MEMBER_GROUP } from '../../src/cloud/rls.js';
import { reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { registerPostgresPolyfills } from '../../src/db/postgres.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
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
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.end();
});

describe.skipIf(!PG_URL)('cloud member re-grant (backwards-compat, scoped)', () => {
  async function ownerCloud(prefix: string): Promise<Lattice> {
    const schema = `${prefix}_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    o.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await o.init();
    await registerPostgresPolyfills((sql) => runAsyncOrSync(o.adapter, sql));
    await installCloudRls(o);
    return o;
  }

  async function legacyMemberRole(db: Lattice, prefix: string): Promise<string> {
    const r = `${prefix}_${randomBytes(4).toString('hex')}`;
    roles.push(r);
    const pw = randomBytes(16).toString('hex');
    await runAsyncOrSync(
      db.adapter,
      `CREATE ROLE "${r}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pw}'`,
    );
    // Ensure the legacy cluster-global group exists, then put the role in it — the
    // pre-4.0 state every member was in.
    await runAsyncOrSync(
      db.adapter,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${LEGACY_MEMBER_GROUP}')
         THEN CREATE ROLE ${LEGACY_MEMBER_GROUP} NOLOGIN; END IF; END $$;`,
    );
    await runAsyncOrSync(db.adapter, `GRANT ${LEGACY_MEMBER_GROUP} TO "${r}"`);
    return r;
  }

  async function isMember(db: Lattice, role: string, group: string): Promise<boolean> {
    const row = (await getAsyncOrSync(db.adapter, `SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [
      role,
      group,
    ])) as { m?: boolean } | undefined;
    return row?.m === true;
  }

  it("re-grants the per-cloud group to the cloud's OWN members but never a cluster-global stranger", async () => {
    const o = await ownerCloud('rg');
    const group = await memberGroupFor(o);

    // (1) OWN member: a legacy member role registered in THIS cloud's invite registry.
    const own = await legacyMemberRole(o, 'lm_own');
    await runAsyncOrSync(
      o.adapter,
      `INSERT INTO "__lattice_member_invites" (id, role, email_hash, expires_at)
         VALUES ('${randomBytes(6).toString('hex')}', '${own}', 'h', now() + interval '1 day')`,
    );

    // (2) STRANGER: a legacy member role in the cluster-global group but NOT in THIS
    // cloud's invites (a member of some OTHER cloud on the same Postgres cluster).
    const stranger = await legacyMemberRole(o, 'lm_stranger');

    // Pre-state: legacy group only — neither is in this cloud's per-cloud group.
    expect(await isMember(o, own, group)).toBe(false);
    expect(await isMember(o, stranger, group)).toBe(false);

    await reconcileCloudMemberAccess(o);

    // The cloud's OWN member regained access via the per-cloud group...
    expect(await isMember(o, own, group)).toBe(true);
    // ...the stranger (another cloud's member) was NOT granted — scoped, no leak.
    expect(await isMember(o, stranger, group)).toBe(false);
  });
});
