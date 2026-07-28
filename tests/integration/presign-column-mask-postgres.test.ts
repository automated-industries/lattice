/**
 * `lattice_presign_file` must not hand a member a value the column mask hides.
 *
 * It is a `SECURITY DEFINER` function, granted EXECUTE to the member group, gated on
 * `lattice_row_visible` — ROW visibility — and it returns a URL with the object key
 * taken VERBATIM from `files.ref_uri` spliced into it. Row visibility is the wrong
 * test for a column: a files row can be visible to everyone while `ref_uri` carries
 * an owner-only audience, which is the whole point of the mask. So a member read
 * `files_v.ref_uri` as NULL and, one call later, read the same string out of a
 * presigned URL — plus got a working credential for the bytes.
 *
 * This is the identical shape as the `lattice_visible_embeddings` leak that was
 * closed the round before. That fix closed the INSTANCE; this file is about the
 * second member of the same class, so the assertions are about the observable value
 * (what string comes back to a real member login) rather than about a gate.
 *
 * Postgres-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud, reconcileCloudMemberAccess } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import { cloudSchema } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';
import { installFilePresigner, setCloudS3Secret } from '../../src/cloud/file-presign.js';
import { allAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

/** The object key. If a member can read this string, the mask has been read around. */
const OBJECT_KEY = 'private/2026/OWNER-EYES-ONLY-OBJECT-KEY-9931.pdf';

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

interface Cloud {
  owner: Lattice;
  dbname: string;
  role: string;
  pw: string;
}

/**
 * A cloud with S3 enabled and one `files` row that EVERY member may see. `maskRefUri`
 * decides whether `files.ref_uri` carries the owner-only audience — the single
 * variable this file is about. Both arms exist because the fix has to be a mask, not
 * a refusal: withholding from everyone would "pass" the leak test and silently delete
 * keyless member file access, which is the entire feature.
 */
async function s3Cloud(maskRefUri: boolean): Promise<Cloud> {
  const dbname = `lattice_pfm_${randomBytes(4).toString('hex')}`;
  databases.push(dbname);
  const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
  await admin.query(`CREATE DATABASE "${dbname}"`);
  await admin.end();

  const owner = new Lattice(dbUrl(dbname));
  owner.define('files', {
    columns: { id: 'TEXT PRIMARY KEY', ref_uri: 'TEXT', name: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'files.md',
  });
  await owner.init();
  await owner.upsert('files', {
    id: 'f1',
    ref_uri: `s3://bkt/${OBJECT_KEY}`,
    name: 'report.pdf',
  });
  await secureCloud(owner);
  await installFilePresigner(owner.adapter, await cloudSchema(owner));
  await setCloudS3Secret(owner.adapter, {
    bucket: 'bkt',
    region: 'us-east-1',
    accessKey: 'AKIA_OWNER',
    secretKey: 'OWNER_S3_SECRET_KEY',
  });
  // Row-level: visible to everyone. The mask, not row visibility, must be what
  // decides — otherwise the test proves nothing about columns.
  await runAsyncOrSync(owner.adapter, `SELECT lattice_set_row_visibility('files','f1','everyone')`);
  if (maskRefUri) {
    await setColumnAudience(
      owner,
      'files',
      'ref_uri',
      'owner',
      ['id', 'ref_uri', 'name', 'deleted_at'],
      ['id'],
    );
  }

  const role = `lpf_${randomBytes(3).toString('hex')}`;
  roles.push(role);
  const pw = generateMemberPassword();
  await provisionMemberRole(owner, role, pw);
  await reconcileCloudMemberAccess(owner);
  return { owner, dbname, role, pw };
}

describe.skipIf(!PG_URL)('lattice_presign_file and the column mask', () => {
  it('never returns a masked ref_uri to a member, by any path', async () => {
    const { owner, dbname, role, pw } = await s3Cloud(true);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // The value really is stored, and the row really is visible to this member —
    // otherwise every assertion below is about an empty table.
    const stored = (await allAsyncOrSync(
      owner.adapter,
      `SELECT "ref_uri" AS r FROM "files" WHERE "id" = 'f1'`,
    )) as { r?: unknown }[];
    expect(String(stored[0]?.r ?? '')).toContain(OBJECT_KEY);
    const via = await member.query<{ id: string; ref_uri: string | null; name: string | null }>(
      `SELECT "id", "ref_uri", "name" FROM "files_v"`,
    );
    expect(via.rows.map((r) => r.id)).toContain('f1');
    expect(via.rows[0]?.name).toBe('report.pdf'); // the row is readable…
    expect(via.rows[0]?.ref_uri ?? null).toBeNull(); // …and the column is masked.

    // THE PROPERTY. Same row, same member, through the definer function. Whatever
    // comes back — a URL, an error — it must not contain the masked object key.
    let presigned: string | null = null;
    let raised: string | null = null;
    try {
      const r = await member.query<{ u: string | null }>(
        `SELECT lattice_presign_file('f1','GET',60) AS u`,
      );
      presigned = r.rows[0]?.u ?? null;
    } catch (e) {
      raised = (e as Error).message;
    }
    expect(presigned ?? '', 'the presigned URL must not carry the masked object key').not.toContain(
      OBJECT_KEY,
    );
    // …and specifically it is REFUSED, rather than handing back a URL to some other
    // object — a signed URL built from a key the caller may not see would be a
    // capability leak even with the key percent-mangled out of recognition.
    expect(presigned).toBeNull();
    expect(raised ?? '').toMatch(/no readable object reference/i);

    // The OWNER is unaffected. The mask never hid the column from them, so the fix
    // must not have been implemented as "nobody ever presigns a masked row".
    const asOwner = (await allAsyncOrSync(
      owner.adapter,
      `SELECT lattice_presign_file('f1','GET',60) AS u`,
    )) as { u?: unknown }[];
    expect(String(asOwner[0]?.u ?? '')).toContain('X-Amz-Signature=');
    expect(String(asOwner[0]?.u ?? '')).toContain('OWNER-EYES-ONLY-OBJECT-KEY');

    owner.close();
  }, 180_000);

  it('still presigns for a member when ref_uri is NOT masked', async () => {
    // The other half, and the reason the fix reads the value through the mask rather
    // than refusing non-owners outright. A member holds NO base SELECT on `files` at
    // all — not even on the unmasked columns, once reconcile has converged — so
    // "refuse anyone who cannot read the base column" would have failed here too and
    // deleted keyless member file access for every cloud.
    const { owner, dbname, role, pw } = await s3Cloud(false);
    const member = new pg.Pool({ connectionString: dbUrl(dbname, role, pw), max: 1 });
    pools.push(member);

    // The member genuinely cannot read the column off the BASE table…
    await expect(member.query(`SELECT "ref_uri" FROM "files"`)).rejects.toThrow(
      /permission denied/i,
    );
    // …reads it through the view (it is not masked here)…
    const via = await member.query<{ ref_uri: string | null }>(`SELECT "ref_uri" FROM "files_v"`);
    expect(via.rows[0]?.ref_uri ?? '').toContain(OBJECT_KEY);
    // …and presigning works, with the object key in the path.
    const r = await member.query<{ u: string }>(`SELECT lattice_presign_file('f1','GET',60) AS u`);
    expect(r.rows[0]?.u).toContain('X-Amz-Signature=');
    expect(r.rows[0]?.u).toContain('OWNER-EYES-ONLY-OBJECT-KEY');
    // The owner S3 credential never rides along.
    expect(r.rows[0]?.u).not.toContain('OWNER_S3_SECRET_KEY');

    // Row visibility is still enforced independently of the column mask.
    await runAsyncOrSync(
      owner.adapter,
      `SELECT lattice_set_row_visibility('files','f1','private')`,
    );
    await expect(member.query(`SELECT lattice_presign_file('f1','GET',60)`)).rejects.toThrow(
      /not authorized/i,
    );

    owner.close();
  }, 180_000);
});
