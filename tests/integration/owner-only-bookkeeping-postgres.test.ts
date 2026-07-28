/**
 * The owner-only rule, enforced over the REAL SCHEMA rather than over a hand-written
 * list of names.
 *
 * The existing check enumerates the tables it worries about, so an object nobody
 * thought to add is not "asserted safe" — it is simply not asserted about. That is
 * how `__lattice_fts_<table>` ended up outside the guard: not declared readable, not
 * declared owner-only, holding purely because no code happens to grant it. And it is
 * not a small thing to leave un-guarded. The full-text index stores base-table
 * CLEARTEXT — its trigger concatenates the row's own columns into `body`, masked ones
 * included — and the indexed search branch matches `f.tsv` and returns `ts_headline`
 * snippets over `f.body`. A single careless GRANT turns it into a read path around the
 * mask that the `<t>_v` view is not even in.
 *
 * So this walks every relation the cloud actually has, asks the registry which ones
 * are owner-only (by name OR by prefix), and asserts the member group holds nothing on
 * any of them. A new per-table bookkeeping family is covered the day it is declared,
 * and a grant added to an existing one fails here.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { memberGroupFor, cloudSchema } from '../../src/cloud/rls.js';
import {
  installFilePresigner,
  setCloudS3Secret,
  S3_SECRET_TABLE,
} from '../../src/cloud/file-presign.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import {
  isOwnerOnlyBookkeeping,
  classifyCloudRelation,
  OWNER_ONLY_BOOKKEEPING_PREFIXES,
} from '../../src/cloud/member-access.js';
import { ftsTableName } from '../../src/search/fts.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SECRET = 'FTS-CLEARTEXT-EYES-ONLY';
const databases: string[] = [];
const roles: string[] = [];
const pools: pg.Pool[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

afterEach(async () => {
  for (const p of pools.splice(0)) await p.end().catch(() => undefined);
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

/**
 * A cloud with a MASKED column that is also FULL-TEXT INDEXED — the combination the
 * index makes dangerous, and the one a policy-only view of the world cannot see.
 */
async function maskedIndexedCloud(): Promise<{
  owner: Lattice;
  dbname: string;
  role: string;
  pw: string;
}> {
  const dbname = `lattice_oob_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('journal', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
    // Both columns indexed, so the index holds the masked value in clear.
    fts: { fields: ['body', 'secret'] },
    render: () => '',
    outputFile: 'journal.md',
  });
  await owner.init();
  await secureCloud(owner);
  // The SECOND owner action that installs cloud objects — enabling cloud S3. Without
  // it this walk never sees `__lattice_cloud_s3_secret` (the owner's storage
  // credential), because the fixture was `secureCloud` alone and every object any
  // OTHER owner action installs was simply absent from the schema being walked.
  await installFilePresigner(owner.adapter, await cloudSchema(owner));
  await setCloudS3Secret(owner.adapter, {
    bucket: 'bkt',
    region: 'us-east-1',
    accessKey: 'AKIA_OWNER',
    secretKey: 'OWNER_S3_SECRET_KEY',
  });
  await owner.insert('journal', { id: 'j1', body: 'visible', secret: SECRET });
  await runAsyncOrSync(
    owner.adapter,
    `SELECT lattice_set_row_visibility('journal','j1','everyone')`,
  );
  await setColumnAudience(
    owner,
    'journal',
    'secret',
    'owner',
    ['id', 'body', 'secret', 'deleted_at'],
    ['id'],
  );

  const role = `lm_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  await reconcileCloudMemberAccess(owner);
  return { owner, dbname, role, pw };
}

describe.skipIf(!PG_URL)('owner-only bookkeeping is owner-only, over the whole schema', () => {
  it('grants the member group nothing on any owner-only relation, FTS index included', async () => {
    const { owner, role } = await maskedIndexedCloud();
    const group = await memberGroupFor(owner);
    const fts = ftsTableName('journal');

    // The index really does hold the masked value in CLEARTEXT. Without this the
    // assertion below would be a statement about an empty table.
    const stored = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "body" AS b FROM "${fts}" WHERE "row_id" = 'j1'`,
    )) as { b?: unknown }[];
    expect(String(stored[0]?.b ?? '')).toContain(SECRET);

    // Every relation this cloud actually has, classified by the registry.
    const rels = (await allAsyncOrSync(
      owner.adapter,
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','p')
        ORDER BY 1`,
    )) as { name: string }[];
    // AN UNCLASSIFIED RELATION IS A FAILURE, NOT A SKIP.
    //
    // This filtered the walk through the owner-only registry before asserting, which
    // reproduced the exact weakness the comment at the top of this file describes: a
    // relation in NEITHER registry was not "asserted safe", it was silently dropped.
    // Five relations were in that state on a real secured cloud —
    // `_lattice_embeddings` (whose `content` is base-row cleartext, masked columns
    // included), both sharing-graph tables, `__lattice_lineage`, `__lattice_migrations`
    // — so granting the embeddings store to members left this test GREEN while a
    // member read every masked column in clear. Classifying first, and failing on an
    // unclassified name, is what makes adding a bookkeeping table a deliberate act.
    const byClass = rels.map((r) => ({ name: r.name, klass: classifyCloudRelation(r.name) }));
    const unclassified = byClass.filter((r) => r.klass === 'unclassified').map((r) => r.name);
    const contradictory = byClass.filter((r) => r.klass === 'contradictory').map((r) => r.name);
    expect({ unclassified, contradictory }).toEqual({ unclassified: [], contradictory: [] });

    const ownerOnly = byClass.filter((r) => r.klass === 'owner-only').map((r) => r.name);

    // The registry has to match something here, or this test proves nothing — and in
    // particular it has to match the per-table FTS family, which is the whole reason
    // the prefix concept exists.
    expect(ownerOnly).toContain(fts);
    // …and the S3 credential store, which only exists because the fixture now performs
    // the owner action that creates it.
    expect(ownerOnly).toContain(S3_SECRET_TABLE);
    expect(ownerOnly.length).toBeGreaterThan(1);

    // Both principals. The member's login role INHERITS from the group, so a group
    // grant shows up either way — but a privilege granted straight to an individual
    // member role is invisible to a group-only check, and that is a form a hand-run
    // GRANT or a restore can leave behind.
    const held: { principal: string; relation: string; priv: string }[] = [];
    for (const principal of [group, role]) {
      for (const name of ownerOnly) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES']) {
          const row = (await allAsyncOrSync(
            owner.adapter,
            `SELECT has_table_privilege(CAST(? AS text), CAST(? AS regclass), CAST(? AS text)) AS ok`,
            [principal, `"${name}"`, priv],
          )) as { ok?: unknown }[];
          if (row[0]?.ok === true || row[0]?.ok === 't') {
            held.push({ principal, relation: name, priv });
          }
        }
      }
    }
    // Reported as the full list so a failure names every leak, not just the first.
    expect({ held }).toEqual({ held: [] });

    // Column-level grants are a separate privilege that a table-level check misses
    // entirely — and column grants are exactly what this release has been issuing.
    // Checked for the role as well, for the same reason the table-level pass is.
    const colGrants: { principal: string; rel: string; col: string }[] = [];
    for (const principal of [group, role]) {
      const rows = (await allAsyncOrSync(
        owner.adapter,
        `SELECT c.relname AS rel, a.attname AS col
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = current_schema()
            AND c.relname = ANY(?)
            AND has_column_privilege(CAST(? AS text), c.oid, a.attname, 'SELECT')
          ORDER BY 1, 2`,
        [ownerOnly, principal],
      )) as { rel: string; col: string }[];
      for (const r of rows) colGrants.push({ principal, ...r });
    }
    expect({ colGrants }).toEqual({ colGrants: [] });

    owner.close();
  }, 180_000);

  it('the member cannot read the FTS index, and its own search does not leak the snippet', async () => {
    const { owner, dbname, role, pw } = await maskedIndexedCloud();
    const fts = ftsTableName('journal');
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // The observable property, not the privilege bit: the member cannot read the
    // cleartext out of the index, directly...
    await expect(member.query(`SELECT "body" FROM "${fts}"`)).rejects.toThrow(/permission denied/i);
    // ...nor through the snippet the search path builds from it, which is the shape
    // that would actually reach a person.
    await expect(
      member.query(
        `SELECT ts_headline('simple', f.body, plainto_tsquery('simple', $1)) AS s
           FROM "${fts}" f WHERE f.tsv @@ plainto_tsquery('simple', $1)`,
        [SECRET],
      ),
    ).rejects.toThrow(/permission denied/i);

    // The member's real read path still works and still masks.
    const via = await member.query<{ secret: string | null; body: string | null }>(
      `SELECT "secret", "body" FROM "journal_v"`,
    );
    expect(via.rows[0]?.body).toBe('visible');
    expect(via.rows[0]?.secret ?? null).toBeNull();

    owner.close();
  }, 180_000);

  it('the prefix rule classifies the per-table index family, not just one name', () => {
    // A prefix, not a literal: the guard has to cover a table nobody has created yet.
    expect(OWNER_ONLY_BOOKKEEPING_PREFIXES).toContain('__lattice_fts_');
    expect(isOwnerOnlyBookkeeping(ftsTableName('anything_at_all'))).toBe(true);
    expect(isOwnerOnlyBookkeeping('__lattice_owners')).toBe(true);
    // ...and does not sweep up member-readable bookkeeping or user tables.
    expect(isOwnerOnlyBookkeeping('__lattice_changelog')).toBe(false);
    expect(isOwnerOnlyBookkeeping('journal')).toBe(false);
    expect(isOwnerOnlyBookkeeping('journal_v')).toBe(false);
  });
});
