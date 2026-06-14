/**
 * S3 file access rides entirely on the `files`-row RLS. The serve route resolves
 * a file's S3 key from the row it reads through the member's own connection
 * (`db.get('files', id)`), so a member only ever learns the key — and can only
 * fetch the bytes — for a row RLS lets them SELECT. This proves that at the DB
 * level on a real cloud: a member can't see an owner's private S3-backed file
 * (so the serve route 404s before touching S3) until it's shared.
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { installCloudRls, enableRlsForTable, backfillOwnership } from '../../src/cloud/rls.js';
import { provisionMemberRole, generateMemberPassword } from '../../src/cloud/members.js';

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

function defineFiles(d: Lattice): void {
  d.define('files', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      original_name: 'TEXT',
      mime: 'TEXT',
      ref_kind: 'TEXT',
      ref_provider: 'TEXT',
      ref_uri: 'TEXT',
      source_json: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: 'files.md',
  });
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // best-effort
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

describe.skipIf(!PG_URL)('S3 file access is gated by the files-row RLS', () => {
  it('a member learns an S3-backed file key only for a row it can see', async () => {
    const tag = randomBytes(4).toString('hex');
    const schema = `s3_${tag}`;
    const bob = `s3_b_${tag}`;
    schemas.push(schema);
    roles.push(bob);

    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = schemaUrl(schema);

    // Owner creates an S3-backed file row (private by default).
    const owner = new Lattice(url);
    dbs.push(owner);
    defineFiles(owner);
    await owner.init();
    await owner.upsert('files', {
      id: 'f1',
      original_name: 'secret.pdf',
      mime: 'application/pdf',
      ref_kind: 'cloud_ref',
      ref_provider: 's3',
      ref_uri: 's3://bucket/blobs/deadbeef',
      source_json: JSON.stringify({ bucket: 'bucket', key: 'blobs/deadbeef' }),
    });
    await installCloudRls(owner);
    const pk = owner.getPrimaryKey('files');
    await backfillOwnership(owner, 'files', pk);
    await enableRlsForTable(owner, 'files', pk);
    const bobPw = generateMemberPassword();
    await provisionMemberRole(owner, bob, bobPw);

    // Bob (a scoped member) cannot see the private file row — so the serve route's
    // db.get returns null → 404, and bob never learns the S3 key.
    const bobDb = new Lattice(memberUrl(schema, bob, bobPw));
    dbs.push(bobDb);
    defineFiles(bobDb);
    await bobDb.init({ introspectOnly: true });
    expect(await bobDb.get('files', 'f1')).toBeNull();

    // The owner shares the file → bob now sees the row AND its S3 key.
    const ownerPool = new pg.Pool({ connectionString: url, max: 1 });
    await ownerPool.query(`SELECT lattice_set_row_visibility('files','f1','everyone')`);
    await ownerPool.end();

    const seen = (await bobDb.get('files', 'f1')) as { source_json?: string } | null;
    expect(seen).not.toBeNull();
    const src = JSON.parse(String(seen?.source_json)) as { key: string };
    expect(src.key).toBe('blobs/deadbeef');
    await admin.end();
  });
});
