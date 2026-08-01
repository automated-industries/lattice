/**
 * Nesting one table inside another on a shared cloud is OWNER-only — from every
 * door, not only the one that can answer with a status code.
 *
 * A link writes the owner's workspace file and adds a real column to a shared
 * table. Row security protects neither of those: the file is a plain write on the
 * owner's disk, and when a member has no ALTER privilege the library deliberately
 * routes the statement through an owner-side helper rather than failing it. So
 * the rule that a member may not do this is a property of the OPERATION, and a
 * version of it that lives in a request handler is a rule about clicking — the
 * browser refuses what a terminal performs, on the same connection, for the same
 * person.
 *
 * This drives both doors against one real cloud and one real scoped member role:
 * the capability a command calls, and the route a browser calls. They have to
 * agree, and the shared table has to be unchanged afterwards.
 *
 * Postgres-gated (per-test database + a provisioned member role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openConfig, disposeActive, startGuiServer } from '../../src/gui/server.js';
import type { ActiveDb, GuiServerHandle } from '../../src/gui/server.js';
import { addUserLink, removeUserLink } from '../../src/gui/schema-ops.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const actives: ActiveDb[] = [];
const servers: GuiServerHandle[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const a of actives.splice(0)) await disposeActive(a);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

/** A config file whose db: is `url`; the owner declares the layout, a member does not. */
function writeConfig(prefix: string, url: string, withEntities: boolean): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  const lines = [`db: "${url}"`, ''];
  if (!withEntities) {
    lines.push('entities: {}', '');
  } else {
    lines.push(
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: notes.md',
      '  vendors:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: vendors.md',
      '',
    );
  }
  writeFileSync(configPath, lines.join('\n'), 'utf8');
  return configPath;
}

describe.skipIf(!PG_URL)('links on a shared cloud are owner-only', () => {
  it('refuses a member at the capability and at the route, and changes nothing', async () => {
    const dbname = `lattice_lnk_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }

    const ownerCfg = writeConfig('lattice-lnk-owner-', dbUrl(dbname), true);
    const owner = await openConfig(ownerCfg, join(ownerCfg, '..', 'context'), false);
    actives.push(owner);
    await owner.converged;
    await secureCloud(owner.db);

    const role = `lm_lnk_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner.db, role, pw);

    // The member's own open — the same one a command performs before it acts.
    const memberCfg = writeConfig('lattice-lnk-member-', dbUrl(dbname, role, pw), false);
    const member = await openConfig(memberCfg, join(memberCfg, '..', 'context'), false);
    actives.push(member);

    // (1) The capability itself refuses, with a code a caller can branch on
    // rather than a status only a server could have produced.
    const added = await addUserLink(member, 'notes', 'vendors', 'sess').then(
      (ok) => ok as unknown,
      (e: unknown) => e,
    );
    expect(cloudErrorCode(added)).toBe('cloud_owner_only');
    expect((added as Error).message).toBe('Only a cloud owner can add a link');

    const removed = await removeUserLink(member, 'notes', 'vendors_id', 'sess').then(
      (ok) => ok as unknown,
      (e: unknown) => e,
    );
    expect(cloudErrorCode(removed)).toBe('cloud_owner_only');

    // (2) The browser gets the same refusal, as the status it expects — the
    // adapter maps the tagged failure rather than owning the rule.
    const gui = await startGuiServer({
      configPath: memberCfg,
      outputDir: join(memberCfg, '..', 'context'),
      port: 0,
      openBrowser: false,
    });
    servers.push(gui);
    const post = await fetch(`${gui.url}/api/schema/entities/notes/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'vendors' }),
    });
    expect(post.status).toBe(403);
    expect((await post.json()) as { error?: string }).toEqual({
      error: 'Only a cloud owner can add a link',
    });
    const del = await fetch(`${gui.url}/api/schema/entities/notes/links/vendors_id`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(403);

    // (3) Nothing landed on the shared table. This is the assertion that would
    // have failed before the rule travelled: the column really was created.
    const admin = new pg.Pool({ connectionString: dbUrl(dbname), max: 1 });
    try {
      const cols = await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notes'`,
      );
      expect(cols.rows.map((r: { column_name: string }) => r.column_name)).not.toContain(
        'vendors_id',
      );
    } finally {
      await admin.end();
    }

    // (4) And the owner is not gated — the rule is about members, not about links.
    const ownerOutcome = await addUserLink(owner, 'notes', 'vendors', 'sess');
    expect(ownerOutcome).toEqual({ ok: true, column: 'vendors_id' });
  }, 120_000);
});
