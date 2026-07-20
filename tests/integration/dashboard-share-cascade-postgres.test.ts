/**
 * Dashboard-share cascade: sharing a dashboard makes the data it reads visible to
 * the SAME audience, so recipients get a populated page instead of an empty one.
 * The cascade grants a standing TABLE-LEVEL share of each dependency table, scoped
 * to the sharer's OWN rows, so it:
 *   - shows the shared data (existing AND future rows — kept live, no re-share),
 *   - matches the audience exactly (everyone, or only the granted people),
 *   - is one-way (unsharing the dashboard never revokes the data),
 *   - can NEVER expose another member's private rows in a shared table,
 *   - skips never-share dependencies.
 *
 * All assertions run through a SCOPED MEMBER login role (RLS-enforced), never the
 * owner/BYPASSRLS connection — the only way to prove the isolation actually holds.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls } from '../../src/cloud/rls.js';
import { secureNewCloudTable } from '../../src/cloud/setup.js';
import {
  provisionMemberRole,
  generateMemberPassword,
  setRowVisibility,
} from '../../src/cloud/members.js';
import { cascadeDashboardDataShare } from '../../src/gui/dashboard-share-cascade.js';
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

/** Stand up a secured cloud with `widget` + `secretstuff` data tables, a
 *  `dashboards` table, and N scoped member connections. */
async function setup(
  nMembers: number,
): Promise<{ owner: Lattice; members: Lattice[]; memberRoles: string[] }> {
  const schema = `dsc_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const owner = new Lattice(schemaUrl(schema));
  dbs.push(owner);
  const data = { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' } as const;
  owner.define('widget', { columns: { ...data }, render: () => '', outputFile: 'widget.md' });
  owner.define('secretstuff', {
    columns: { ...data },
    render: () => '',
    outputFile: 'secretstuff.md',
  });
  owner.define('dashboards', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      html: 'TEXT',
      spec: 'TEXT',
      source_tables: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'dashboards.md',
  });
  await owner.init();
  await installCloudRls(owner);
  for (const t of ['widget', 'secretstuff', 'dashboards']) {
    await secureNewCloudTable(owner, t, ['id']);
  }
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

/** The row ids a member's RLS-scoped connection can actually SELECT from `table`. */
async function memberSees(m: Lattice, table: string): Promise<string[]> {
  const rows = (await allAsyncOrSync(m.adapter, `SELECT "id" FROM "${table}" ORDER BY "id"`)) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

async function makeDashboard(owner: Lattice, id: string, sources: string[]): Promise<void> {
  await owner.insert('dashboards', {
    id,
    title: 'Report',
    html: '<div></div>',
    source_tables: JSON.stringify(sources),
  });
}

describe.skipIf(!PG_URL)('dashboard-share cascade', () => {
  it('sharing a dashboard to everyone makes its data visible to a member — including rows added later', async () => {
    const { owner, members } = await setup(1);
    const m = members[0]!;
    await owner.insert('widget', { id: 'w1', name: 'a' });
    await owner.insert('widget', { id: 'w2', name: 'b' });
    await makeDashboard(owner, 'd1', ['widget']);

    expect(await memberSees(m, 'widget')).toEqual([]); // private by default

    const res = await cascadeDashboardDataShare(owner, 'd1', 'everyone');
    expect(res.shared).toEqual(['widget']);
    expect(await memberSees(m, 'widget')).toEqual(['w1', 'w2']);

    // Kept live: a row added AFTER the share is visible with no re-share.
    await owner.insert('widget', { id: 'w3', name: 'c' });
    expect(await memberSees(m, 'widget')).toEqual(['w1', 'w2', 'w3']);
  });

  it('sharing a dashboard with specific people shares its data with EXACTLY those people (incl. future rows)', async () => {
    const { owner, members, memberRoles } = await setup(2);
    const [a, b] = members;
    const roleA = memberRoles[0]!;
    await owner.insert('widget', { id: 'w1', name: 'a' });
    await makeDashboard(owner, 'd1', ['widget']);

    await cascadeDashboardDataShare(owner, 'd1', 'custom', [roleA]);
    expect(await memberSees(a!, 'widget')).toEqual(['w1']); // granted
    expect(await memberSees(b!, 'widget')).toEqual([]); // not granted

    await owner.insert('widget', { id: 'w2', name: 'b' });
    expect(await memberSees(a!, 'widget')).toEqual(['w1', 'w2']); // kept live for A
    expect(await memberSees(b!, 'widget')).toEqual([]); // still nothing for B
  });

  it('unsharing the dashboard does NOT revoke the data share (one-way)', async () => {
    const { owner, members } = await setup(1);
    const m = members[0]!;
    await owner.insert('widget', { id: 'w1', name: 'a' });
    await makeDashboard(owner, 'd1', ['widget']);
    await cascadeDashboardDataShare(owner, 'd1', 'everyone');
    expect(await memberSees(m, 'widget')).toEqual(['w1']);

    // Owner flips the DASHBOARD back to private. No cascade fires on unshare, so the
    // underlying data stays shared (the intended one-way behavior).
    await setRowVisibility(owner, 'dashboards', 'd1', 'private');
    expect(await memberSees(m, 'widget')).toEqual(['w1']);
  });

  it('never exposes ANOTHER member’s private rows in a shared table (owner-keyed)', async () => {
    const { owner, members, memberRoles } = await setup(2);
    const [a, b] = members;
    const roleA = memberRoles[0]!;
    // The owner owns w_owner; member B owns w_b (private to B). Both live in `widget`.
    await owner.insert('widget', { id: 'w_owner', name: 'o' });
    await runAsyncOrSync(
      b!.adapter,
      `INSERT INTO "widget" ("id","name") VALUES ('w_b','b-private')`,
    );
    await makeDashboard(owner, 'd1', ['widget']);

    // Owner shares the dashboard (dep = widget) with member A.
    await cascadeDashboardDataShare(owner, 'd1', 'custom', [roleA]);

    // A sees the OWNER's row — but NEVER member B's private row.
    expect(await memberSees(a!, 'widget')).toEqual(['w_owner']);
    // And B still sees only its own row (the owner's share didn't touch it).
    expect(await memberSees(b!, 'widget')).toEqual(['w_b']);
  });

  it('skips a never-share dependency instead of sharing it or erroring', async () => {
    const { owner, members } = await setup(1);
    const m = members[0]!;
    await owner.insert('widget', { id: 'w1', name: 'a' });
    await owner.insert('secretstuff', { id: 's1', name: 'top-secret' });
    await runAsyncOrSync(
      owner.adapter,
      `SELECT lattice_set_table_never_share('secretstuff', true)`,
    );
    await makeDashboard(owner, 'd1', ['widget', 'secretstuff']);

    const res = await cascadeDashboardDataShare(owner, 'd1', 'everyone');
    expect(res.shared).toEqual(['widget']);
    expect(res.skipped).toEqual(['secretstuff']);

    expect(await memberSees(m, 'widget')).toEqual(['w1']); // shared
    expect(await memberSees(m, 'secretstuff')).toEqual([]); // never-share, not leaked
  });

  it('widening from specific-people to everyone is monotonic (custom → everyone)', async () => {
    const { owner, members, memberRoles } = await setup(2);
    const [a, b] = members;
    const roleA = memberRoles[0]!;
    await owner.insert('widget', { id: 'w1', name: 'a' });
    await makeDashboard(owner, 'd1', ['widget']);

    await cascadeDashboardDataShare(owner, 'd1', 'custom', [roleA]);
    expect(await memberSees(b!, 'widget')).toEqual([]); // B not yet granted

    // Later shared to everyone → B now sees it, and A still does.
    await cascadeDashboardDataShare(owner, 'd1', 'everyone');
    expect(await memberSees(a!, 'widget')).toEqual(['w1']);
    expect(await memberSees(b!, 'widget')).toEqual(['w1']);
  });

  it('a MEMBER can share their OWN dashboard end-to-end (cascade runs under the scoped member role)', async () => {
    // Regression: the cascade's never-share check must NOT read the owner-only
    // __lattice_table_policy directly — a scoped member has no grant on it, so a
    // raw read raises "permission denied" and breaks every member-owned share. The
    // check goes through the member-callable lattice_never_share_tables DEFINER fn.
    const { members } = await setup(2);
    const [m, b] = members;
    // Member M owns a dashboard + its data, inserted through M's OWN scoped role.
    await runAsyncOrSync(m!.adapter, `INSERT INTO "widget" ("id","name") VALUES ('wm','m-data')`);
    await runAsyncOrSync(
      m!.adapter,
      `INSERT INTO "dashboards" ("id","title","html","source_tables") VALUES ('dm','D','<div></div>', ?)`,
      [JSON.stringify(['widget'])],
    );
    expect(await memberSees(b!, 'widget')).toEqual([]); // the other member sees nothing yet

    // M shares its dashboard to everyone — must NOT raise, and must cascade.
    const res = await cascadeDashboardDataShare(m!, 'dm', 'everyone');
    expect(res.shared).toEqual(['widget']);

    // The other member now sees M's data (and only M's).
    expect(await memberSees(b!, 'widget')).toEqual(['wm']);
  });
});
