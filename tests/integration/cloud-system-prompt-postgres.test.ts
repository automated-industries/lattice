/**
 * The workspace chat system prompt is owner-controlled and app-mediated-secret:
 *
 *   - the OWNER writes it (lattice_set_cloud_setting);
 *   - a scoped MEMBER cannot write it (the setter RAISEs);
 *   - a member cannot SELECT the backing table directly (no grant — it never shows
 *     in their table browser);
 *   - BUT a member CAN read it through the SECURITY DEFINER getter, because the
 *     member's own local chat injects it. That last point is the documented ceiling
 *     (secrecy is at the product surface, not against a member's own SQL session).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import {
  installCloudSettings,
  getCloudSetting,
  setCloudSetting,
  CLOUD_SETTING_SYSTEM_PROMPT,
} from '../../src/cloud/settings.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dbs: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string): string {
  return `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
function memberUrl(schema: string, role: string, password: string): string {
  const u = new URL(PG_URL!);
  u.username = role;
  u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // best-effort
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

describe.skipIf(!PG_URL)('cloud workspace system prompt', () => {
  it('is owner-writable, member-read-via-getter, but member-write + direct-read denied', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `sp_${tag}`;
    const bob = `sp_b_${tag}`;
    schemas.push(schema);
    roles.push(bob);
    const SECRET = `formal tone; FY starts July ${tag}`;

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    // Owner secures the cloud + installs the settings store, then sets the prompt.
    const owner = new Lattice(schemaUrl(schema));
    dbs.push(owner);
    await owner.init();
    await installCloudRls(owner); // creates lattice_members (needed to provision bob)
    await installCloudSettings(owner);
    await setCloudSetting(owner, CLOUD_SETTING_SYSTEM_PROMPT, SECRET);

    // Owner reads it back.
    expect(await getCloudSetting(owner, CLOUD_SETTING_SYSTEM_PROMPT)).toBe(SECRET);

    const bobPw = generateMemberPassword();
    await provisionMemberRole(owner, bob, bobPw);

    const bobDb = new Lattice(memberUrl(schema, bob, bobPw));
    dbs.push(bobDb);
    await bobDb.init({ introspectOnly: true });

    // The member's chat injection path works (this is the accepted ceiling).
    expect(await getCloudSetting(bobDb, CLOUD_SETTING_SYSTEM_PROMPT)).toBe(SECRET);

    // The member CANNOT overwrite it — the setter RAISEs for a non-owner.
    await expect(setCloudSetting(bobDb, CLOUD_SETTING_SYSTEM_PROMPT, 'hacked')).rejects.toThrow(
      /only a cloud owner/i,
    );

    // And the value is unchanged after the failed write.
    expect(await getCloudSetting(owner, CLOUD_SETTING_SYSTEM_PROMPT)).toBe(SECRET);

    // The member cannot read the backing table directly (no grant) — so the prompt
    // never appears in their table browser / data API, only via the getter above.
    await expect(
      getAsyncOrSync(bobDb.adapter, `SELECT "value" FROM "__lattice_cloud_settings" LIMIT 1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('returns null on a database with no settings store (un-upgraded cloud / fresh)', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `sp0_${tag}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const owner = new Lattice(schemaUrl(schema));
    dbs.push(owner);
    await owner.init();
    // No installCloudSettings → the getter function doesn't exist → best-effort null.
    expect(await getCloudSetting(owner, CLOUD_SETTING_SYSTEM_PROMPT)).toBeNull();
  });
});
