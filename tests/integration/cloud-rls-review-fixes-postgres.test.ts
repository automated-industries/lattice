/**
 * v3.1 adversarial-review regression suite. Each test guards a specific finding
 * from the cloud-config-in-Postgres security review:
 *
 *  #1 (CRITICAL) — a SECURITY DEFINER helper with an unpinned search_path lets a
 *     member plant a `pg_temp.__lattice_owners` shadow to bypass row RLS. The pin
 *     (`SET search_path = "<schema>", pg_temp`, pg_temp LAST) defeats it.
 *  #2 (HIGH) — full-fidelity changelog history (every column in cleartext, incl.
 *     masked ones) must be OWNER-ONLY, not readable by anyone who can see the row.
 *  #4 (HIGH) — private-mode create must be atomic: the row never momentarily
 *     carries the table's `everyone` default before being demoted.
 *  #6 (MED) — flagging a table never-share must retroactively privatize already-
 *     shared rows and drop their grants.
 *  #10 (LOW) — the YAML→DB column-policy seed runs once; a later secureCloud must
 *     not re-mask a column the owner has since cleared.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import {
  installCloudRls,
  backfillOwnership,
  enableRlsForTable,
  enableChangelogRls,
} from '../../src/cloud/rls.js';
import { setTableDefaultVisibility, setTableNeverShare } from '../../src/cloud/table-policy.js';
import {
  setColumnAudience,
  seedColumnPolicyFromYaml,
  loadColumnPolicy,
} from '../../src/cloud/audience.js';
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
function uniqSchema(): string {
  const s = `rf_${randomBytes(4).toString('hex')}`;
  schemas.push(s);
  return s;
}
type DefineFn = (d: Lattice) => void;
function defineNotes(d: Lattice): void {
  d.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
}
function defineNotesWithChangelog(d: Lattice): void {
  d.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
    changelog: true,
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

describe.skipIf(!PG_URL)('v3.1 cloud RLS — adversarial-review regressions', () => {
  async function secure(schema: string, define: DefineFn, changelog = false): Promise<Lattice> {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const owner = new Lattice(schemaUrl(schema), changelog ? { changelog: {} } : undefined);
    dbs.push(owner);
    define(owner);
    await owner.init();
    await installCloudRls(owner);
    const pk = owner.getPrimaryKey('notes');
    await backfillOwnership(owner, 'notes', pk);
    await enableRlsForTable(owner, 'notes', pk);
    if (changelog) await enableChangelogRls(owner);
    return owner;
  }
  async function member(schema: string, define: DefineFn): Promise<{ m: Lattice; role: string }> {
    const role = `rf_m_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(dbs[0], role, pw);
    const m = new Lattice(memberUrl(schema, role, pw));
    dbs.push(m);
    define(m);
    await m.init({ introspectOnly: true });
    return { m, role };
  }

  // ── #1 CRITICAL ────────────────────────────────────────────────────────────
  it('a pg_temp __lattice_owners shadow cannot bypass row RLS (search_path pinned)', async () => {
    const schema = uniqSchema();
    const owner = await secure(schema, defineNotes);
    // A private, owner-owned row the member must never see.
    await owner.upsert('notes', { id: 'secret1', body: 'owner-only' });
    const { m } = await member(schema, defineNotes);
    expect(await m.get('notes', 'secret1')).toBeNull(); // sanity: hidden

    // Attack: plant a temp table shadowing the ownership bookkeeping the
    // SECURITY DEFINER visibility check reads, claiming the row is public.
    await runAsyncOrSync(
      m.adapter,
      `CREATE TEMP TABLE "__lattice_owners" ("table_name" text, "pk" text, "owner_role" text, "visibility" text)`,
    );
    await runAsyncOrSync(
      m.adapter,
      `INSERT INTO pg_temp."__lattice_owners" VALUES ('notes','secret1','attacker','everyone')`,
    );
    // With search_path pinned (pg_temp LAST), lattice_row_visible resolves the
    // REAL bookkeeping, so the shadow is inert and the row stays hidden.
    expect(await m.get('notes', 'secret1')).toBeNull();
  });

  // ── #2 HIGH ──────────────────────────────────────────────────────────────--
  it('changelog history of a shared row is owner-only (masked columns never leak via history)', async () => {
    const schema = uniqSchema();
    const owner = await secure(schema, defineNotesWithChangelog, true);
    await owner.upsert('notes', { id: 'n1', body: 'visible', secret_note: 'EYES ONLY' });
    await runAsyncOrSync(
      owner.adapter,
      `SELECT lattice_set_row_visibility('notes','n1','everyone')`,
    );

    const { m } = await member(schema, defineNotesWithChangelog);
    // The row itself is visible to the member…
    expect(await m.get('notes', 'n1')).not.toBeNull();
    // …but its full-fidelity history (incl. secret_note in cleartext) is not.
    const seen = (await allAsyncOrSync(
      m.adapter,
      `SELECT * FROM "__lattice_changelog" WHERE "table_name"='notes' AND "row_id"='n1'`,
    )) as unknown[];
    expect(seen.length).toBe(0);
  });

  // ── #4 HIGH ──────────────────────────────────────────────────────────────--
  it('insertForcingVisibility lands the row private atomically even when the default is everyone', async () => {
    const schema = uniqSchema();
    const owner = await secure(schema, defineNotes);
    await setTableDefaultVisibility(owner, 'notes', 'everyone');

    await owner.insertForcingVisibility('notes', { id: 'p1', body: 'forced private' }, 'private');
    const rec = (await getAsyncOrSync(
      owner.adapter,
      `SELECT "visibility" FROM "__lattice_owners" WHERE "table_name"='notes' AND "pk"='p1'`,
    )) as { visibility?: string } | undefined;
    // Stamped private from the very first INSERT — never the everyone default.
    expect(rec?.visibility).toBe('private');

    const { m } = await member(schema, defineNotes);
    expect(await m.get('notes', 'p1')).toBeNull(); // forced-private row: hidden
    // Control: a PLAIN insert under the same default IS visible — proving the
    // default still applies and only the forced row was privatized.
    await owner.insert('notes', { id: 'p2', body: 'default shared' });
    expect(await m.get('notes', 'p2')).not.toBeNull();
  });

  // ── #6 MED ───────────────────────────────────────────────────────────────--
  it('marking a table never-share retroactively privatizes shared rows and drops grants', async () => {
    const schema = uniqSchema();
    const owner = await secure(schema, defineNotes);
    await owner.upsert('notes', { id: 'r1', body: 'shared everyone' });
    await owner.upsert('notes', { id: 'r2', body: 'granted custom' });
    await runAsyncOrSync(
      owner.adapter,
      `SELECT lattice_set_row_visibility('notes','r1','everyone')`,
    );

    const { m, role } = await member(schema, defineNotes);
    await runAsyncOrSync(owner.adapter, `SELECT lattice_grant_row('notes','r2',?)`, [role]);
    expect(await m.get('notes', 'r1')).not.toBeNull(); // shared → visible
    expect(await m.get('notes', 'r2')).not.toBeNull(); // granted → visible

    await setTableNeverShare(owner, 'notes', true);

    // Both rows are now private; the member can see neither, and the grant is gone.
    expect(await m.get('notes', 'r1')).toBeNull();
    expect(await m.get('notes', 'r2')).toBeNull();
    const grants = (await allAsyncOrSync(
      owner.adapter,
      `SELECT 1 FROM "__lattice_row_grants" WHERE "table_name"='notes'`,
    )) as unknown[];
    expect(grants.length).toBe(0);
  });

  // ── #10 LOW ──────────────────────────────────────────────────────────────--
  it('YAML column-policy seed is one-time: a cleared audience is not re-masked on a later secureCloud', async () => {
    const schema = uniqSchema();
    const owner = await secure(schema, defineNotes);

    // First seed (the YAML→DB migration) masks secret_note as owner-only.
    await seedColumnPolicyFromYaml(owner, 'notes', { secret_note: 'owner' });
    expect(await loadColumnPolicy(owner, 'notes')).toMatchObject({ secret_note: 'owner' });

    // The owner deliberately CLEARS the audience through the DB (un-masks it).
    await setColumnAudience(
      owner,
      'notes',
      'secret_note',
      '',
      ['id', 'body', 'secret_note'],
      ['id'],
    );
    expect(await loadColumnPolicy(owner, 'notes')).toEqual({});

    // A later secureCloud re-runs the seed — the marker gate must keep it a no-op,
    // so the owner's clear is NOT silently reverted to masked.
    await seedColumnPolicyFromYaml(owner, 'notes', { secret_note: 'owner' });
    expect(await loadColumnPolicy(owner, 'notes')).toEqual({});
  });
});
