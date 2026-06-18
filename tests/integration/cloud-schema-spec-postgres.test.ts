/**
 * The owner-published entity/render LAYOUT is shared with members so they render
 * the full context tree.
 *
 * On a cloud, the entity + render layout (`entities:` + `entityContexts:`) lives
 * ONLY in the owner's local config — a joined member's generated config has
 * `entities: {}`, so the member's CLI / GUI render produces an empty / degraded
 * context tree even though they can read every RLS-permitted row.
 *
 * What this test pins:
 *   1. publishSharedSchema persists the owner's entities + entityContexts into the
 *      members-readable __lattice_shared_schema singleton.
 *   2. hydrateMemberConfigFromCloud writes that layout back into a member's config
 *      FILE — keeping the member's own scoped `db:` line — so the member then
 *      renders the full layout.
 *   3. Bug-catch: with NO published spec, hydrate is a no-op (returns false) and
 *      the member config keeps its empty entities.
 *
 * Postgres-gated (real per-test cloud database + a real member login role).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';
import { getOrCreateMasterKey } from '../../src/framework/user-config.js';
import { loadConfigDoc } from '../../src/gui/config-io.js';
import {
  publishSharedSchema,
  hydrateMemberConfigFromCloud,
} from '../../src/cloud/shared-schema.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const roles: string[] = [];
const dirs: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Write a temp lattice.config.yml with the given db + entities/contexts blocks. */
function writeConfig(opts: { db: string; entities: string; contexts?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), `schema-spec-${randomBytes(3).toString('hex')}-`));
  dirs.push(dir);
  const path = join(dir, 'lattice.config.yml');
  const body =
    `db: ${opts.db}\n` + opts.entities + (opts.contexts ? `\n${opts.contexts}` : '') + '\n';
  writeFileSync(path, body, 'utf8');
  return path;
}

/** Owner config: two real entities (projects, notes) + a per-row context for projects. */
function ownerConfigYaml(db: string): string {
  return writeConfig({
    db,
    entities: [
      'entities:',
      '  projects:',
      '    fields:',
      '      id: { type: text, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: PROJECTS.md',
      '  notes:',
      '    fields:',
      '      id: { type: text, primaryKey: true }',
      '      body: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: NOTES.md',
    ].join('\n'),
    contexts: [
      'entityContexts:',
      '  projects:',
      "    slug: '{{id}}'",
      '    directoryRoot: projects',
      '    files:',
      '      PROJECT.md:',
      '        source: self',
      '        template: default-detail',
    ].join('\n'),
  });
}

afterEach(async () => {
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

describe.skipIf(!PG_URL)('cloud shared entity/render layout', () => {
  it('owner publishes its layout; a member hydrates it (keeping its own db:)', async () => {
    const dbname = `lattice_spec_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const ownerUrl = dbUrl(dbname);
    const ownerConfigPath = ownerConfigYaml(ownerUrl);
    const key = getOrCreateMasterKey();

    const owner = new Lattice({ config: ownerConfigPath }, { encryptionKey: key });
    await owner.init();
    await secureCloud(owner); // installs the cloud bootstrap incl. __lattice_shared_schema
    await publishSharedSchema(owner, ownerConfigPath);

    // The spec landed: entities_json is non-null and contains both entities.
    const specRow = await getAsyncOrSync(
      owner.adapter,
      `SELECT "entities_json" FROM "__lattice_shared_schema" WHERE "id" = 'singleton'`,
    );
    expect(specRow?.entities_json).toBeTruthy();
    const publishedEntities = JSON.parse(specRow!.entities_json as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(publishedEntities)).toEqual(expect.arrayContaining(['projects', 'notes']));

    // Provision a real member login role.
    const role = `lm_spec_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    owner.close();

    // The member's config: its own scoped db: URL (user + password) + empty entities.
    const memberUrl = dbUrl(dbname, role, pw);
    const memberConfigPath = writeConfig({ db: memberUrl, entities: 'entities: {}' });

    // Hydrate it from the cloud.
    const hydrated = await hydrateMemberConfigFromCloud(memberConfigPath, memberUrl, key);
    expect(hydrated).toBe(true);

    // The member config now carries the owner's full layout…
    const after = loadConfigDoc(memberConfigPath).toJSON() as {
      db: string;
      entities: Record<string, unknown>;
      entityContexts?: Record<string, unknown>;
    };
    expect(after.entities.projects).toBeTruthy();
    expect(after.entities.notes).toBeTruthy();
    expect(after.entityContexts?.projects).toBeTruthy();
    // …while its db: line is untouched (still the scoped member URL, not the owner's).
    expect(after.db).toBe(memberUrl);
    expect(after.db).not.toBe(ownerUrl);
  });

  it('with no published spec, hydrate is a no-op and the member keeps empty entities', async () => {
    const dbname = `lattice_spec_empty_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const ownerUrl = dbUrl(dbname);
    const key = getOrCreateMasterKey();
    // Secure the cloud (so __lattice_shared_schema EXISTS) but DON'T publish a spec.
    const owner = new Lattice(ownerUrl, { encryptionKey: key });
    await owner.init();
    await secureCloud(owner);

    const role = `lm_specE_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    owner.close();

    const memberUrl = dbUrl(dbname, role, pw);
    const memberConfigPath = writeConfig({ db: memberUrl, entities: 'entities: {}' });

    const hydrated = await hydrateMemberConfigFromCloud(memberConfigPath, memberUrl, key);
    expect(hydrated).toBe(false);

    const after = loadConfigDoc(memberConfigPath).toJSON() as { entities: Record<string, unknown> };
    expect(Object.keys(after.entities)).toHaveLength(0);
  });
});
