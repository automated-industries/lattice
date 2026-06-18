/**
 * Phase 4 reconcile batching — the MASKED-table 2-GRANT path.
 *
 * reconcileCloudMemberAccess now grants each table in ONE round-trip; a masked
 * table batches its two GRANTs (SELECT on `<t>_v` + INSERT/UPDATE/DELETE on the
 * base) into a single multi-statement query via grantMemberTableAccessBatchSql.
 * The other reconcile tests all use UNMASKED single-GRANT tables, so a one-element
 * `.join('; ')` is byte-identical to the prior single statement and they would stay
 * green even if multi-statement batching were broken. This test is the one that
 * actually EXECUTES the masked 2-statement batch against real Postgres and asserts
 * BOTH grants landed — pinning that pg's simple-query protocol ran them in one query.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL (the global setup provisions a
 * disposable embedded Postgres for local runs).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { MEMBER_GROUP } from '../../src/cloud/rls.js';
import { reconcileCloudMemberAccess, secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';

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
  for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('reconcile batching — masked table 2-GRANT batch', () => {
  async function memberHasTablePriv(db: Lattice, table: string, priv: string): Promise<boolean> {
    const row = (await getAsyncOrSync(
      db.adapter,
      `SELECT has_table_privilege(?::text, format('%I.%I', current_schema(), ?::text), ?::text) AS ok`,
      [MEMBER_GROUP, table, priv],
    )) as { ok?: unknown } | undefined;
    return row?.ok === true || row?.ok === 't';
  }

  it('lands SELECT on <t>_v AND INSERT/UPDATE/DELETE on the base in one batched round-trip', async () => {
    const schema = `mr_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    // Declare the column audience in the schema (the documented masking path) so the
    // in-memory schema reports it — reconcile reads getColumnAudience() from there, so
    // tableNeedsAudienceView('notes') is true and reconcile takes the 2-GRANT (view
    // SELECT + base DML) path that grantMemberTableAccessBatchSql joins into one query.
    o.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
      columnAudience: { secret_note: 'owner' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await o.init();
    await secureCloud(o); // seeds the declared audience + builds the notes_v masking view

    const member = `lm_${randomBytes(4).toString('hex')}`;
    roles.push(member);
    await provisionMemberRole(o, member, generateMemberPassword());

    await reconcileCloudMemberAccess(o);

    // BOTH halves of the batched masked GRANT must have actually landed — this is
    // the assertion the existing (unmasked) reconcile tests cannot make.
    expect(await memberHasTablePriv(o, 'notes_v', 'SELECT')).toBe(true);
    expect(await memberHasTablePriv(o, 'notes', 'INSERT')).toBe(true);
    expect(await memberHasTablePriv(o, 'notes', 'UPDATE')).toBe(true);
    expect(await memberHasTablePriv(o, 'notes', 'DELETE')).toBe(true);
    // Masking still holds: the member never gets base-table SELECT (reads route via _v).
    expect(await memberHasTablePriv(o, 'notes', 'SELECT')).toBe(false);
  });

  it('does not re-expose a column masked at RUNTIME (not declared in config)', async () => {
    // Security regression: a column marked secret in the GUI (setColumnAudience at
    // runtime) masks via the _v view + __lattice_column_policy, but the in-memory
    // schema audience (config-only) stays empty. reconcile read that stale in-memory
    // source, saw the table as UNMASKED, and re-GRANTed members base SELECT on the
    // next open — exposing the secret column directly off the base table, bypassing
    // the masking view. reconcile must decide masked-ness from the DB-canonical policy.
    const schema = `mrt_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const o = new Lattice(schemaUrl(schema));
    dbs.push(o);
    // NOTE: no columnAudience in the config — the mask is applied purely at runtime.
    o.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'notes.md',
    });
    await o.init();
    await secureCloud(o);
    // The GUI "mark column secret" path: mask at runtime (builds notes_v, revokes base
    // SELECT) without ever touching the declared config.
    await setColumnAudience(
      o,
      'notes',
      'secret_note',
      'owner',
      ['id', 'body', 'secret_note', 'deleted_at'],
      ['id'],
    );

    const member = `lm_${randomBytes(4).toString('hex')}`;
    roles.push(member);
    await provisionMemberRole(o, member, generateMemberPassword());

    await reconcileCloudMemberAccess(o);

    // The runtime mask must survive reconcile: read via the view, DML on the base, but
    // NO base SELECT (the bypass granted it from the stale in-memory schema).
    expect(await memberHasTablePriv(o, 'notes_v', 'SELECT')).toBe(true);
    expect(await memberHasTablePriv(o, 'notes', 'INSERT')).toBe(true);
    expect(await memberHasTablePriv(o, 'notes', 'SELECT')).toBe(false);
  });
});
