/**
 * THE MEMBER-READABLE DATA SURFACE, asserted over the whole cloud rather than over
 * the parts someone remembered to worry about.
 *
 * Two holes motivate this file, and they are the same hole seen from two sides.
 *
 * 1. A member read an owner-masked column in CLEARTEXT through
 *    `lattice_visible_embeddings`. The base table was denied, the full-text index was
 *    denied, and `<t>_v` returned NULL for the column — every relation-level check
 *    green — while a `SECURITY DEFINER` function handed back the same text, because
 *    it filtered by ROW visibility only. A definer function granted to members is
 *    exactly as powerful as a GRANT, and Postgres gives EXECUTE to PUBLIC by default,
 *    so there is no privilege bit anywhere that describes this.
 *
 * 2. The guard that was supposed to catch that class walked every relation and then
 *    FILTERED through the owner-only registry before asserting. A relation in NEITHER
 *    registry was not asserted safe — it was skipped. `_lattice_embeddings` (the
 *    cleartext this file is about), both sharing-graph tables, `__lattice_lineage` and
 *    `__lattice_migrations` were all in that state on a real secured cloud. Granting
 *    the embeddings store to members would have left it GREEN.
 *
 * So: every relation must CLASSIFY, an unclassified one fails, the check runs against
 * the individual member ROLE as well as the group, and the function surface is walked
 * the same way — with the actual value a member reads as the assertion, never a
 * privilege bit. Every leak in this release passed a privilege-bit check.
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
import { classifyCloudRelation, classifyDefinerFunction } from '../../src/cloud/member-access.js';
import { vectorIndexName, VEC_META_TABLE } from '../../src/search/vector-index.js';
import { ftsTableName } from '../../src/search/fts.js';
import { EMBEDDINGS_TABLE } from '../../src/search/embeddings.js';
import type { EmbeddingsConfig } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
/** The value the owner marked secret. It must never reach the member, by any path. */
const SECRET = 'MASKED-CLEARTEXT-OWNER-EYES-ONLY-4417';

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

/** Deterministic token embedder — no model dependency, and every row scores > 0. */
function tokenEmbed(dim = 8) {
  return (text: string): Promise<number[]> => {
    const v = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h + ch.charCodeAt(0)) % dim;
      v[h] = (v[h] ?? 0) + 1;
    }
    return Promise.resolve(v);
  };
}
function embConfig(): EmbeddingsConfig {
  return { fields: ['body', 'secret'], embed: tokenEmbed(8), modelId: 'test-v1' };
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

interface Cloud {
  owner: Lattice;
  dbname: string;
  role: string;
  pw: string;
  group: string;
}

/**
 * A cloud whose `journal.secret` is owner-masked and ALSO an embedded + full-text
 * indexed field — so the same cleartext exists in the base table, in
 * `_lattice_embeddings`, and in `__lattice_fts_journal`, and the row itself is
 * visible to everyone. That combination is the one the mask has to survive.
 *
 * It ALSO applies the second owner action that installs cloud objects — enabling
 * cloud S3, which installs the in-database presigner and its owner-only secret table.
 *
 * That is not decoration. This fixture was built by `secureCloud` alone, so the walks
 * below only ever saw what `secureCloud` materializes, and EVERY object installed by
 * any other owner action sat outside them: `lattice_presign_file` — which was leaking
 * a masked `files.ref_uri` into the URL it hands members — and
 * `__lattice_cloud_s3_secret`, the owner's S3 key, whose non-grant nothing was
 * checking. A guard enumerating from a partial cloud measures the fixture, not the
 * product.
 */
async function maskedSearchableCloud(): Promise<Cloud> {
  const dbname = `lattice_mrs_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('journal', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
    fts: { fields: ['body', 'secret'] },
    embeddings: embConfig(),
    render: () => '',
    outputFile: 'journal.md',
  });
  // The presigner reads `files`, so the cloud needs one for that surface to exist.
  owner.define('files', {
    columns: { id: 'TEXT PRIMARY KEY', ref_uri: 'TEXT', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'files.md',
  });
  // The GUI audit log: member-readable, and the one member-readable relation that
  // stores whole row IMAGES. Defined here so the relation walk covers it and its mask
  // view together.
  owner.define('_lattice_gui_audit', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ts: 'TEXT',
      table_name: 'TEXT NOT NULL',
      row_id: 'TEXT',
      operation: 'TEXT NOT NULL',
      before_json: 'TEXT',
      after_json: 'TEXT',
      undone: 'INTEGER NOT NULL DEFAULT 0',
      session_id: 'TEXT',
      source: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-gui/audit.md',
  });
  await owner.init();
  await owner.upsert('journal', { id: 'j1', body: 'quarterly budget review', secret: SECRET });
  await owner.upsert('files', { id: 'f1', ref_uri: `s3://bkt/${SECRET}`, name: 'report.pdf' });
  await owner.insert('_lattice_gui_audit', {
    id: 'a1',
    ts: new Date().toISOString(),
    table_name: 'journal',
    row_id: 'j1',
    operation: 'update',
    before_json: JSON.stringify({ id: 'j1', body: 'quarterly budget review', secret: SECRET }),
    after_json: JSON.stringify({ id: 'j1', body: 'revised', secret: SECRET }),
    undone: 0,
    session_id: 'sess',
    source: 'gui',
  });
  await owner.refreshEmbeddings('journal');
  await secureCloud(owner);
  // The SECOND owner action: enable cloud S3. Installs `lattice_presign_file` +
  // `__lattice_cloud_s3_secret`, neither of which `secureCloud` creates.
  await installFilePresigner(owner.adapter, await cloudSchema(owner));
  await setCloudS3Secret(owner.adapter, {
    bucket: 'bkt',
    region: 'us-east-1',
    accessKey: 'AKIA_OWNER',
    secretKey: 'OWNER_S3_SECRET_KEY',
  });
  // Visible to EVERYONE at the row level: row visibility must not be what hides the
  // column, or the test proves nothing about the column mask.
  for (const [t, pk] of [
    ['journal', 'j1'],
    ['files', 'f1'],
  ] as const) {
    await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility(?, ?, 'everyone')`, [
      t,
      pk,
    ]);
  }
  await setColumnAudience(
    owner,
    'journal',
    'secret',
    'owner',
    ['id', 'body', 'secret', 'deleted_at'],
    ['id'],
  );
  await setColumnAudience(
    owner,
    'files',
    'ref_uri',
    'owner',
    ['id', 'ref_uri', 'name', 'deleted_at'],
    ['id'],
  );

  const role = `lmr_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  await reconcileCloudMemberAccess(owner);
  return { owner, dbname, role, pw, group: await memberGroupFor(owner) };
}

/** Every relation in the cloud schema. */
async function relations(owner: Lattice): Promise<string[]> {
  const rows = (await allAsyncOrSync(
    owner.adapter,
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','p')
      ORDER BY 1`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Every table-level or column-level privilege `principal` holds on `rels`.
 *
 * Both principals matter. `has_table_privilege` on the GROUP misses a privilege
 * granted straight to an individual member's login role, which is a grant the reconcile
 * pass never issues but a hand-run `GRANT` or a restore can leave behind — and it is
 * the form the previous guard could not see at all. Column privileges are a separate
 * privilege from the table-level one, and column grants are exactly what this release
 * issues, so a table-level-only check misses them by construction.
 */
async function privilegesHeld(
  owner: Lattice,
  principal: string,
  rels: readonly string[],
): Promise<string[]> {
  const held: string[] = [];
  for (const name of rels) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER']) {
      const row = (await allAsyncOrSync(
        owner.adapter,
        `SELECT has_table_privilege(CAST(? AS text), CAST(? AS regclass), CAST(? AS text)) AS ok`,
        [principal, `"${name}"`, priv],
      )) as { ok?: unknown }[];
      if (row[0]?.ok === true || row[0]?.ok === 't') held.push(`${principal} ${priv} ${name}`);
    }
    const cols = (await allAsyncOrSync(
      owner.adapter,
      `SELECT a.attname AS col
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = current_schema() AND c.relname = ?
          AND has_column_privilege(CAST(? AS text), c.oid, a.attname, 'SELECT')
        ORDER BY 1`,
      [name, principal],
    )) as { col: string }[];
    for (const c of cols) held.push(`${principal} SELECT(${c.col}) ${name}`);
  }
  return held;
}

describe.skipIf(!PG_URL)('the member-readable data surface', () => {
  it('withholds an owner-masked column from lattice_visible_embeddings', async () => {
    const { owner, dbname, role, pw } = await maskedSearchableCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // The store really does hold the masked value in clear — otherwise every
    // assertion below is a statement about an empty table.
    const stored = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "content" AS c FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = 'journal'`,
    )) as { c?: unknown }[];
    expect(String(stored[0]?.c ?? '')).toContain(SECRET);

    // The row is visible to this member, and the mask is doing its job on the read
    // path the member is supposed to use.
    const via = await member.query<{ body: string | null; secret: string | null }>(
      `SELECT "body", "secret" FROM "journal_v"`,
    );
    expect(via.rows[0]?.body).toBe('quarterly budget review');
    expect(via.rows[0]?.secret ?? null).toBeNull();

    // THE PROPERTY. Same row, same member, through the definer function — the chunk
    // vector still comes back (member semantic search keeps working), the cleartext
    // does not.
    const fn = await member.query<{ row_pk: string; content: string | null; embedding: string }>(
      `SELECT * FROM lattice_visible_embeddings('journal')`,
    );
    expect(fn.rows.length).toBeGreaterThan(0);
    expect(fn.rows.map((r) => r.row_pk)).toContain('j1');
    for (const r of fn.rows) {
      expect(r.content ?? '').not.toContain(SECRET);
      expect(r.content ?? null).toBeNull();
      expect(r.embedding).toBeTruthy();
    }

    // The OWNER of the row is unaffected: the mask never hid it from them, so the
    // withholding must not have been implemented as "nobody ever gets content".
    const asOwner = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "content" AS c FROM lattice_visible_embeddings('journal')`,
    )) as { c?: unknown }[];
    expect(String(asOwner[0]?.c ?? '')).toContain(SECRET);

    owner.close();
  }, 180_000);

  it("keeps the member's semantic search working, matched snippet included", async () => {
    // The other half of the fix, and the reason it is a CASE rather than a refusal.
    // Withholding the chunk vectors as well would have been the simpler change and
    // would have silently deleted member semantic search on every masked table —
    // masking hides the VALUE, not the row. So: the member still finds the row, still
    // reads it masked, and still gets a matched snippet, which is now re-derived from
    // the masked row rather than handed over by the database as cleartext first.
    const { owner, dbname, role, pw } = await maskedSearchableCloud();
    owner.close();

    const member = new Lattice(dbUrl(dbname, role, pw));
    member.define('journal', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
      embeddings: embConfig(),
      render: () => '',
      outputFile: 'journal.md',
    });
    await member.init();
    expect(member.isCloudMemberOpen()).toBe(true);

    const hits = await member.search('journal', 'quarterly budget', { topK: 10 });
    const hit = hits.find((h) => String(h.row.id) === 'j1');
    expect(hit, 'the member must still find the row it may see').toBeDefined();
    expect(hit!.row.secret ?? null).toBeNull();
    expect(hit!.matchedContent ?? null).not.toBeNull();
    expect(hit!.matchedContent).toContain('quarterly budget review');
    expect(hit!.matchedContent).not.toContain(SECRET);
    member.close();
  }, 180_000);

  it('leaks the masked cleartext through NO read-only member-callable definer function', async () => {
    // The generalization of the bug above. Postgres grants EXECUTE to PUBLIC by
    // default and this codebase relies on that deliberately, so "which functions is
    // the member granted" answers "all of them" and discriminates nothing. The only
    // assertion worth making is the observable one: call them AS THE MEMBER and look
    // at what comes back.
    //
    // Restricted to STABLE / IMMUTABLE functions, which is a real property and not a
    // convenience: those cannot mutate the database, so sweeping them cannot damage
    // the fixture. The VOLATILE ones are the owner-gated mutators.
    const { owner, dbname, role, pw } = await maskedSearchableCloud();
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    const fns = (await allAsyncOrSync(
      owner.adapter,
      `SELECT p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              p.provolatile AS vol
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'lattice\\_%'
        ORDER BY 1`,
    )) as { name: string; args: string; vol: string }[];
    expect(fns.length).toBeGreaterThan(10); // the definer surface really is walked

    /** A plausible literal for one parameter, by name first and type second. */
    const argFor = (decl: string): string => {
      const [pname = '', ...rest] = decl.trim().split(/\s+/);
      const type = rest.join(' ');
      if (type.endsWith('[]')) {
        const inner = /pks?$/.test(pname) ? `'j1'` : `'journal'`;
        return `ARRAY[${inner}]::${type}`;
      }
      if (pname.includes('ttl')) return '60';
      if (/bigint|integer|smallint|numeric|double/.test(type)) return '0';
      if (type === 'boolean') return 'false';
      if (pname.endsWith('pk')) return `'j1'`;
      // The presigner takes a files row id and an HTTP method. Without these the
      // generic caller passed 'journal' for both, the function raised on the first
      // one, and the sweep recorded a `continue` — i.e. it swept a function it never
      // actually reached, which reads exactly like a pass.
      if (pname.includes('file_id')) return `'f1'`;
      if (pname.includes('method')) return `'GET'`;
      if (pname.includes('visibility')) return `'everyone'`;
      if (pname.includes('role')) return `'${role}'`;
      if (pname.includes('column')) return `'secret'`;
      return `'journal'`;
    };

    const leaked: string[] = [];
    const swept: string[] = [];
    let embeddingsCalled = 0;
    for (const f of fns) {
      if (f.vol !== 's' && f.vol !== 'i') continue;
      swept.push(f.name);
      const args = f.args === '' ? '' : f.args.split(', ').map(argFor).join(', ');
      let rows: Record<string, unknown>[];
      try {
        rows = (await member.query(`SELECT * FROM ${f.name}(${args})`)).rows;
      } catch {
        // A raise, a permission denial, or an argument this generic caller could not
        // guess. Either way nothing came back, which is not a leak.
        continue;
      }
      if (f.name === 'lattice_visible_embeddings') embeddingsCalled = rows.length;
      for (const row of rows) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v === 'string' && v.includes(SECRET)) leaked.push(`${f.name}.${col}`);
        }
      }
    }

    // Non-vacuous: the sweep really did reach the function that used to leak, and
    // really did get rows back from it.
    expect(embeddingsCalled).toBeGreaterThan(0);
    // ...and it reaches the OTHER one, which it could not before. `lattice_presign_file`
    // returns a URL with the `files.ref_uri` object key spliced into it — row-derived
    // data by any honest reading — and it declared itself VOLATILE, so this sweep (which
    // only calls STABLE/IMMUTABLE functions, because a VOLATILE one could damage the
    // fixture) skipped it entirely while it leaked. Both halves are asserted: it must be
    // in the swept set, and every entry the registry marks as returning row data must be.
    expect(swept).toContain('lattice_presign_file');
    const rowDataFns = fns
      .map((f) => classifyDefinerFunction(f.name, f.args))
      .filter((e) => e?.returnsRowData)
      .map((e) => e!.name);
    expect(rowDataFns.length).toBeGreaterThan(1);
    for (const name of rowDataFns) {
      expect(swept, `${name} returns row data but the sweep never calls it`).toContain(name);
    }
    expect({ leaked }).toEqual({ leaked: [] });

    owner.close();
  }, 180_000);

  it('classifies EVERY definer function, so a new one cannot land outside the rule', async () => {
    const { owner } = await maskedSearchableCloud();
    const fns = (await allAsyncOrSync(
      owner.adapter,
      `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.prosecdef AND p.proname LIKE 'lattice\\_%'
        ORDER BY 1`,
    )) as { name: string; args: string }[];

    const unclassified = fns
      .filter((f) => classifyDefinerFunction(f.name, f.args) === null)
      .map((f) => `${f.name}(${f.args})`);
    expect({ unclassified }).toEqual({ unclassified: [] });

    // And the ones that CAN return row data are declared as such, so the sweep above
    // has something to be about. `lattice_presign_file` is the second, and it is here
    // only because the fixture now performs the owner action that installs it — the
    // walk saw nothing of the presigner while the fixture was `secureCloud` alone.
    const rowData = fns
      .map((f) => classifyDefinerFunction(f.name, f.args))
      .filter((e) => e?.returnsRowData)
      .map((e) => e?.name);
    expect(rowData).toContain('lattice_visible_embeddings');
    expect(rowData).toContain('lattice_presign_file');

    // Every entry that returns row data must ALSO declare that it applies the column
    // mask. The registry type admits no third answer, so this is the guard that a new
    // definer function cannot be added as "returns row data, gated on rows only".
    for (const f of fns) {
      const e = classifyDefinerFunction(f.name, f.args);
      if (e?.returnsRowData) expect(e.columnMask, `${e.name} must apply the mask`).toBe('applies');
    }

    owner.close();
  }, 180_000);

  it('classifies EVERY relation, and members hold nothing on the owner-only ones', async () => {
    const { owner, group, role } = await maskedSearchableCloud();

    // Stand up the second per-table derived family so the walk actually covers it.
    // pgvector is not present on the test cluster, so the index is created with the
    // shipping name helper and the same `content` column buildVectorIndex populates
    // from the embeddings store — the name and the cleartext are the parts that
    // matter here, not the vector type.
    const vec = vectorIndexName('journal');
    await runAsyncOrSync(
      owner.adapter,
      `CREATE TABLE "${vec}" (row_pk TEXT, chunk_index INTEGER, content TEXT)`,
    );
    await runAsyncOrSync(
      owner.adapter,
      `INSERT INTO "${vec}" (row_pk, chunk_index, content)
         SELECT "row_pk", "chunk_index", "content" FROM "${EMBEDDINGS_TABLE}"
          WHERE "table_name" = 'journal'`,
    );
    await runAsyncOrSync(owner.adapter, `CREATE TABLE "${VEC_META_TABLE}" (table_name TEXT)`);

    const rels = await relations(owner);
    // The families this is about are really present.
    expect(rels).toContain(ftsTableName('journal'));
    expect(rels).toContain(EMBEDDINGS_TABLE);
    expect(rels).toContain(vec);
    expect(rels).toContain(VEC_META_TABLE);
    // …and so are the relations only a SECOND owner action creates. The S3 secret
    // table holds the cloud owner's storage credential and was never in this walk,
    // because the fixture never enabled S3.
    expect(rels).toContain(S3_SECRET_TABLE);
    // The member read path onto the audit log, whose base now carries only a narrowed
    // column grant. A `<t>_v` over BOOKKEEPING does not classify by the user-table
    // rule, so this is the relation that proves the classifier follows a mask view to
    // the relation it is named for.
    expect(rels).toContain('_lattice_gui_audit_v');
    expect(classifyCloudRelation('_lattice_gui_audit_v')).toBe('member-readable');

    // (1) THE SHAPE. Nothing may be merely absent from both registries. This is the
    // whole fix: the previous guard filtered the walk through the owner-only list
    // before asserting, so an unlisted relation was silently skipped rather than
    // checked, and five of them were in exactly that state.
    const byClass = rels.map((name) => ({ name, klass: classifyCloudRelation(name) }));
    const unclassified = byClass.filter((r) => r.klass === 'unclassified').map((r) => r.name);
    const contradictory = byClass.filter((r) => r.klass === 'contradictory').map((r) => r.name);
    expect({ unclassified, contradictory }).toEqual({ unclassified: [], contradictory: [] });

    // (2) The owner-only set is substantial and includes the cleartext-bearing ones,
    // so (3) is not asserting over an empty list.
    const ownerOnly = byClass.filter((r) => r.klass === 'owner-only').map((r) => r.name);
    expect(ownerOnly).toContain(EMBEDDINGS_TABLE);
    expect(ownerOnly).toContain(ftsTableName('journal'));
    expect(ownerOnly).toContain(vec);
    expect(ownerOnly).toContain(VEC_META_TABLE);
    expect(ownerOnly).toContain('__lattice_table_shares');
    expect(ownerOnly).toContain('__lattice_table_share_grants');
    expect(ownerOnly).toContain('__lattice_lineage');
    expect(ownerOnly).toContain(S3_SECRET_TABLE);

    // (3) …and neither the group nor the individual member role holds anything on
    // any of them. Reported as the full list so a failure names every leak.
    const held = [
      ...(await privilegesHeld(owner, group, ownerOnly)),
      ...(await privilegesHeld(owner, role, ownerOnly)),
    ];
    expect({ held }).toEqual({ held: [] });

    owner.close();
  }, 180_000);

  it('the guard catches a privilege granted DIRECTLY to a member role', async () => {
    // Self-test of the check above, on the axis it used to be blind to. A member
    // inherits from the group, so a group grant shows up either way; a grant made
    // straight to the login role shows up ONLY if the role is a principal. Proven by
    // making the leak real rather than by reading the query.
    const { owner, dbname, role, pw, group } = await maskedSearchableCloud();
    await runAsyncOrSync(owner.adapter, `GRANT SELECT ON "${EMBEDDINGS_TABLE}" TO "${role}"`);

    // The group-only principal — the old shape — sees nothing.
    expect(await privilegesHeld(owner, group, [EMBEDDINGS_TABLE])).toEqual([]);
    // The role principal sees it.
    expect(await privilegesHeld(owner, role, [EMBEDDINGS_TABLE])).toContain(
      `${role} SELECT ${EMBEDDINGS_TABLE}`,
    );

    // And it is not theoretical: with that grant the member reads the cleartext
    // straight out of the store, which is what the guard exists to prevent.
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);
    const raw = await member.query<{ content: string }>(
      `SELECT "content" FROM "${EMBEDDINGS_TABLE}" WHERE "table_name" = 'journal'`,
    );
    expect(raw.rows.some((r) => r.content.includes(SECRET))).toBe(true);

    owner.close();
  }, 180_000);
});
