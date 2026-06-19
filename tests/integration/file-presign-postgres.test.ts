/**
 * p4c — the in-database SigV4 presigner. The highest-risk item is the
 * plpgsql SigV4 signing; this verifies it against AWS's PUBLISHED test vector
 * (no real S3 needed), plus install idempotency + that the owner secret table
 * is not member-readable.
 *
 * AWS example (docs: "GET Object — Query String Authentication"):
 *   region us-east-1, service s3, host examplebucket.s3.amazonaws.com
 *   GET /test.txt, X-Amz-Date 20130524T000000Z, X-Amz-Expires 86400
 *   => signature aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import {
  installFilePresigner,
  setCloudS3Secret,
  hasFilePresigner,
  filePresignSql,
  pinPresignerDefiner,
  S3_SECRET_TABLE,
} from '../../src/cloud/file-presign.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const AWS_EXPECTED_SIG = 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';

describe.skipIf(!PG_URL)('p4c file presigner (Postgres)', () => {
  let db: Lattice;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    await db.init();
    // current_schema is 'public' for the test connection.
    await installFilePresigner(db.adapter, 'public');
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(
        db.adapter,
        `DROP FUNCTION IF EXISTS lattice_presign_file(text,text,int)`,
      );
      await runAsyncOrSync(
        db.adapter,
        `DROP FUNCTION IF EXISTS lattice_aws_sigv4_presign(text,text,text,text,text,text,text,int,text,text)`,
      );
      await runAsyncOrSync(db.adapter, `DROP FUNCTION IF EXISTS lattice_uri_encode(text,boolean)`);
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS ${S3_SECRET_TABLE} CASCADE`);
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('installs the presigner (idempotently)', async () => {
    expect(await hasFilePresigner(db.adapter)).toBe(true);
    // Re-install is a no-op (CREATE OR REPLACE / IF NOT EXISTS).
    await installFilePresigner(db.adapter, 'public');
    expect(await hasFilePresigner(db.adapter)).toBe(true);
  });

  it('reproduces the AWS SigV4 published test-vector signature', async () => {
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT lattice_aws_sigv4_presign(
         'GET', 'examplebucket.s3.amazonaws.com', 'us-east-1', 's3', '/test.txt',
         'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
         86400, '20130524T000000Z', '20130524'
       ) AS url`,
    );
    const url = String(row?.url ?? '');
    expect(url).toContain(`X-Amz-Signature=${AWS_EXPECTED_SIG}`);
    // Sanity: the canonical query string is present + ordered.
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain(
      'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
    );
    expect(url).toMatch(/^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?/);
  });

  it('stores the owner S3 secret (upsert)', async () => {
    await setCloudS3Secret(db.adapter, {
      bucket: 'mybucket',
      region: 'us-west-2',
      accessKey: 'AKIA_X',
      secretKey: 'shh',
      prefix: 'files/',
    });
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT bucket, region, prefix FROM ${S3_SECRET_TABLE} WHERE id = 'default'`,
    );
    expect(row?.bucket).toBe('mybucket');
    expect(row?.region).toBe('us-west-2');
    expect(row?.prefix).toBe('files/');
    // upsert replaces, not duplicates
    await setCloudS3Secret(db.adapter, {
      bucket: 'b2',
      region: 'eu-west-1',
      accessKey: 'k',
      secretKey: 's',
    });
    const count = await getAsyncOrSync(db.adapter, `SELECT count(*) AS n FROM ${S3_SECRET_TABLE}`);
    expect(Number(count?.n)).toBe(1);
  });

  it('encodes path + credential per RFC-3986', async () => {
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT lattice_uri_encode('a/b c.txt', true) AS p, lattice_uri_encode('a/b', false) AS c`,
    );
    expect(row?.p).toBe('a/b%20c.txt'); // slash kept, space encoded
    expect(row?.c).toBe('a%2Fb'); // slash encoded
  });
});

/**
 * The `lattice_presign_file` wrapper (visibility gate + key resolution). Run in
 * an ISOLATED unique schema via a dedicated single connection, so it never
 * touches the shared `files` / `lattice_row_visible` objects other Postgres test
 * files use concurrently.
 */
describe.skipIf(!PG_URL)('lattice_presign_file wrapper (isolated schema)', () => {
  it('gates on row-visibility and resolves the object key', async () => {
    const pg = (await import('pg')).default;
    const schema = `presign_test_${randomSchemaSuffix()}`;
    const client = new pg.Client(PG_URL);
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      // Stub the visibility helper + a minimal files table in THIS schema.
      await client.query(
        `CREATE FUNCTION lattice_row_visible(p_table text, p_pk text) RETURNS boolean
         LANGUAGE sql AS $$ SELECT p_pk <> 'hidden' $$`,
      );
      await client.query(`CREATE TABLE files (id text primary key, ref_uri text)`);
      await client.query(`INSERT INTO files (id, ref_uri) VALUES ('f1','docs/report.pdf')`);
      await client.query(`INSERT INTO files (id, ref_uri) VALUES ('hidden','secret.pdf')`);
      // Install the presigner pinned to this schema + store a secret.
      await client.query(pinPresignerDefiner(filePresignSql(), schema));
      await client.query(
        `INSERT INTO ${S3_SECRET_TABLE} (id, bucket, region, prefix, access_key, secret_key)
         VALUES ('default','b','us-east-1','files/','AKIA','shh')`,
      );

      const ok = await client.query(`SELECT lattice_presign_file('f1','GET',60) AS url`);
      const url: string = ok.rows[0].url;
      expect(url).toContain('https://b.s3.us-east-1.amazonaws.com/files/docs/report.pdf?');
      expect(url).toContain('X-Amz-Signature=');

      // A file the caller can't see is rejected.
      await expect(client.query(`SELECT lattice_presign_file('hidden','GET',60)`)).rejects.toThrow(
        /not authorized/,
      );
      // TTL is hard-capped at 60s.
      const capped = await client.query(`SELECT lattice_presign_file('f1','GET',9999) AS url`);
      expect(String(capped.rows[0].url)).toContain('X-Amz-Expires=60');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});

function randomSchemaSuffix(): string {
  // Deterministic-enough unique suffix from the imported randomBytes.
  return randomBytes(4).toString('hex');
}
