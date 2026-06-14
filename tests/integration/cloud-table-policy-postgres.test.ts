/**
 * v3.1 cloud-config-in-Postgres: per-table policy + never-share + owner-audience,
 * all DB-enforced (a raw member connection obeys them).
 *
 *  - default_row_visibility: a table defaulted to 'everyone' stamps NEW rows
 *    'everyone' (the insert trigger reads __lattice_table_policy) — proven by a
 *    member seeing a row the owner never explicitly shared.
 *  - never_share: set_row_visibility/grant_row/grant_cell RAISE, and new rows are
 *    forced private even if a default was set.
 *  - owner column audience: a secret column reads NULL for a non-owner member and
 *    the value for the row owner, via the regenerated mask view.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, backfillOwnership, enableRlsForTable } from '../../src/cloud/rls.js';
import {
  setTableDefaultVisibility,
  setTableNeverShare,
  getTablePolicy,
} from '../../src/cloud/table-policy.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync, runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';

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
function defineNotes(d: Lattice): void {
  d.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
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

describe.skipIf(!PG_URL)(
  'cloud table policy (default visibility + never-share + owner audience)',
  () => {
    async function secure(schema: string) {
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      const owner = new Lattice(schemaUrl(schema));
      dbs.push(owner);
      defineNotes(owner);
      await owner.init();
      await installCloudRls(owner);
      const pk = owner.getPrimaryKey('notes');
      await backfillOwnership(owner, 'notes', pk);
      await enableRlsForTable(owner, 'notes', pk);
      return owner;
    }
    async function member(schema: string) {
      const role = `tp_m_${randomBytes(3).toString('hex')}`;
      roles.push(role);
      const pw = generateMemberPassword();
      const owner = dbs[0];
      await provisionMemberRole(owner, role, pw);
      const m = new Lattice(memberUrl(schema, role, pw));
      dbs.push(m);
      defineNotes(m);
      await m.init({ introspectOnly: true });
      return m;
    }

    it('default_row_visibility=everyone stamps new rows everyone (DB-enforced via the trigger)', async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `tp_${tag}`;
      schemas.push(schema);
      const owner = await secure(schema);

      await setTableDefaultVisibility(owner, 'notes', 'everyone');
      expect(await getTablePolicy(owner, 'notes')).toMatchObject({
        defaultRowVisibility: 'everyone',
      });

      // Owner inserts WITHOUT calling set_row_visibility — the trigger applies the default.
      await owner.upsert('notes', { id: 'n1', body: 'team note' });
      const m = await member(schema);
      // The member sees it even though the owner never explicitly shared it.
      expect(await m.get('notes', 'n1')).not.toBeNull();
    });

    it('never_share blocks sharing + forces new rows private, by any client', async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `tp_${tag}`;
      schemas.push(schema);
      const owner = await secure(schema);

      await setTableDefaultVisibility(owner, 'notes', 'everyone'); // even with a shared default…
      await setTableNeverShare(owner, 'notes', true); // …never-share wins.
      expect(await getTablePolicy(owner, 'notes')).toMatchObject({
        neverShare: true,
        defaultRowVisibility: 'private',
      });

      await owner.upsert('notes', { id: 'n1', body: 'secret' });
      // New row forced private despite the everyone default.
      const m = await member(schema);
      expect(await m.get('notes', 'n1')).toBeNull();

      // The owner cannot elevate it — the SECURITY DEFINER functions raise.
      await expect(
        runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility('notes','n1','everyone')`),
      ).rejects.toThrow(/private-only/i);
    });

    it('owner column audience masks a secret column for members, reveals to the row owner', async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `tp_${tag}`;
      schemas.push(schema);
      const owner = await secure(schema);

      // Share the row so the member can SELECT it, but mark `secret_note` owner-only.
      await owner.upsert('notes', { id: 'n1', body: 'visible', secret_note: 'EYES ONLY' });
      await runAsyncOrSync(
        owner.adapter,
        `SELECT lattice_set_row_visibility('notes','n1','everyone')`,
      );
      await setColumnAudience(
        owner,
        'notes',
        'secret_note',
        'owner',
        ['id', 'body', 'secret_note'],
        ['id'],
      );

      const m = await member(schema);
      // Member reads the masked view: row visible, body visible, secret_note NULL.
      const seen = (await getAsyncOrSync(
        m.adapter,
        `SELECT "body", "secret_note" FROM "notes_v" WHERE "id" = 'n1'`,
      )) as { body?: string; secret_note?: string | null } | undefined;
      expect(seen?.body).toBe('visible');
      expect(seen?.secret_note ?? null).toBeNull();

      // The owner still sees the secret value (via the base table they own).
      const ownerRow = (await getAsyncOrSync(
        owner.adapter,
        `SELECT "secret_note" FROM "notes" WHERE "id" = 'n1'`,
      )) as { secret_note?: string } | undefined;
      expect(ownerRow?.secret_note).toBe('EYES ONLY');

      // The column policy is stored canonically in the DB.
      const policy = (await allAsyncOrSync(
        owner.adapter,
        `SELECT "audience" FROM "__lattice_column_policy" WHERE "table_name"='notes' AND "column_name"='secret_note'`,
      )) as { audience: string }[];
      expect(policy[0]?.audience).toBe('owner');
    });

    it('a member cannot set a table policy (owner-gated)', async () => {
      const tag = randomBytes(4).toString('hex');
      const schema = `tp_${tag}`;
      schemas.push(schema);
      await secure(schema);
      const m = await member(schema);
      await expect(setTableNeverShare(m, 'notes', true)).rejects.toThrow(/only a cloud owner/i);
    });
  },
);
