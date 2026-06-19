/**
 * Per-viewer freshness of the open-time render cursor (case 3), end to end on a
 * real cloud.
 *
 * The open-time gate must SKIP an unchanged tree but never skip a STALE one — and
 * for a cloud MEMBER "stale" includes two changes that move no entity row's count:
 *   (a) a new member-visible change-log row (a plain edit OR a derived observation
 *       the member can see), and
 *   (b) an owner SHARE / UN-SHARE that changes what the member can see.
 *
 * Both must read as STALE through the MEMBER's own RLS connection — the same scope
 * the render reads through — so a per-viewer tree is recomputed on the next open.
 * This drives `computeRenderCursor` + `cursorIsFresh` against a member connection,
 * proving the cursor is genuinely per-viewer and not a global fingerprint.
 *
 * Postgres-gated: runs in CI's postgres job, skipped locally without
 * LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableRlsForTable } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { computeRenderCursor, cursorIsFresh } from '../../src/lifecycle/render-cursor.js';
import { TEMPLATE_VERSION } from '../../src/lifecycle/manifest.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const lattices: Lattice[] = [];
const schemas: string[] = [];
const roles: string[] = [];

function schemaUrl(schema: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  if (user) u.username = user;
  if (password) u.password = password;
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

afterEach(async () => {
  for (const l of lattices.splice(0)) l.close();
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('render-on-open cursor — per-viewer freshness (cloud member)', () => {
  it('a new member-visible edit AND an owner un-share each read as STALE through the member scope', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `oc_${tag}`;
    const member = `oc_m_${tag}`;
    schemas.push(schema);
    roles.push(member);

    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    // Owner builds the cloud + a shared row the member can see.
    const owner = new Lattice(schemaUrl(schema));
    lattices.push(owner);
    owner.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      changelog: true,
      render: () => '',
      outputFile: 'notes.md',
    });
    await owner.init();
    await installCloudRls(owner);
    await enableRlsForTable(owner, 'notes', owner.getPrimaryKey('notes'));
    const memberPw = generateMemberPassword();
    await provisionMemberRole(owner, member, memberPw);
    // Owner writes two rows: one shared to everyone, one shared specifically to
    // the member. (Owner-owned; the helpers run as the owner connection.)
    await owner.insert('notes', { id: 'n1', body: 'shared-all' });
    await owner.insert('notes', { id: 'n2', body: 'shared-member' });
    const ownerPool = new pg.Pool({ connectionString: schemaUrl(schema), max: 1 });
    await ownerPool.query(`SELECT lattice_set_row_visibility('notes','n1','everyone')`);
    await ownerPool.query(`SELECT lattice_grant_row('notes','n2',$1)`, [member]);

    // Open the MEMBER connection (its own scoped role) and snapshot the cursor.
    const memberDb = new Lattice(schemaUrl(schema, member, memberPw));
    lattices.push(memberDb);
    await memberDb.init({ introspectOnly: true });
    const c0 = await computeRenderCursor(memberDb.adapter);
    const recorded0 = { templateVersion: TEMPLATE_VERSION, cursor: c0 };
    // Nothing changed yet → the member's tree is fresh against its own snapshot.
    expect(cursorIsFresh(recorded0, await computeRenderCursor(memberDb.adapter))).toBe(true);

    // (a) Owner edits a row the member can see → a new member-visible change-log
    // row. The member's changelog mark advances → STALE.
    await owner.update('notes', 'n1', { body: 'edited' });
    const cAfterEdit = await computeRenderCursor(memberDb.adapter);
    expect(cursorIsFresh(recorded0, cAfterEdit)).toBe(false);

    // Re-baseline, then prove an UN-SHARE is also caught. Snapshot after the edit.
    const recorded1 = { templateVersion: TEMPLATE_VERSION, cursor: cAfterEdit };
    expect(cursorIsFresh(recorded1, await computeRenderCursor(memberDb.adapter))).toBe(true);

    // (b) Owner un-shares n2 from the member. This writes NO entity row and NO
    // changelog row — only the sharing graph + change feed move. The member's
    // sharing-graph mark (via the member-visible change feed) advances → STALE.
    await ownerPool.query(`SELECT lattice_revoke_row('notes','n2',$1)`, [member]);
    await ownerPool.end();
    const cAfterUnshare = await computeRenderCursor(memberDb.adapter);
    expect(cursorIsFresh(recorded1, cAfterUnshare)).toBe(false);
  });
});
