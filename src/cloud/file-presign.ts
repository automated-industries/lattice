/**
 * Seamless cloud file-byte access — an in-database presigned-URL broker.
 *
 * After joining a cloud via invite, a scoped member connects directly to the
 * cloud's Postgres as their own least-privilege role. They can SELECT a `files`
 * row they're allowed to see, but they hold no S3 credential, so fetching the
 * bytes would otherwise fail. This installs a `SECURITY DEFINER` function that,
 * **inside Postgres** (the only place the owner's key lives, away from members),
 * gates on the member's row-visibility and computes a short-lived AWS SigV4
 * presigned URL for exactly that object — so the member fetches/uploads bytes
 * with zero config and never holds a key.
 *
 * Why sign in plpgsql: the secret must never leave the database for a member's
 * process, so a Node-side presign is out — the signature is computed in-DB via
 * `pgcrypto` HMAC-SHA256. Correctness of the SigV4 chain is verified against
 * AWS's published test vectors (no real S3 needed).
 *
 * Postgres + a cloud only. SQLite is single-user with local bytes — no-op.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';

/**
 * Pin the presigner's `SECURITY DEFINER` function search_path to the cloud
 * schema FIRST, then `public` (where `pgcrypto`'s `digest`/`hmac` live), with
 * `pg_temp` LAST. Cloud setup revokes `CREATE ON SCHEMA public` from members, so
 * including `public` can't let a member shadow anything; `pg_temp` last means a
 * member's temp objects are never resolved before the real ones.
 */
export function pinPresignerDefiner(sql: string, schema: string): string {
  const safe = schema.replace(/"/g, '""');
  return sql.replace(
    /SECURITY DEFINER AS/g,
    `SECURITY DEFINER SET search_path = "${safe}", public, pg_temp AS`,
  );
}

/** Owner-only table holding the least-privilege S3 key. Never member-granted. */
export const S3_SECRET_TABLE = '__lattice_cloud_s3_secret';

/**
 * SQL that installs the presigner: `pgcrypto`, the owner-only secret table, the
 * SigV4 signer, and the visibility-gated `lattice_presign_file` wrapper. All
 * `SECURITY DEFINER` bodies are search_path-pinned by the caller.
 *
 * `lattice_aws_sigv4_presign(...)` is parameterized on the date/time so it can be
 * verified deterministically against AWS test vectors; `lattice_presign_file`
 * derives the date from `now()` at call time.
 */
export function filePresignSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Owner-only S3 credential store. A single row (id = 'default').
CREATE TABLE IF NOT EXISTS ${S3_SECRET_TABLE} (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  bucket      TEXT NOT NULL,
  region      TEXT NOT NULL,
  prefix      TEXT NOT NULL DEFAULT '',
  endpoint    TEXT,                -- host override (e.g. for S3-compatible stores)
  access_key  TEXT NOT NULL,
  secret_key  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT now()::text
);

-- RFC-3986 URI encoding (AWS canonical form): unreserved chars pass; everything
-- else is %XX. The caller controls which chars to leave (e.g. '/' in a path).
CREATE OR REPLACE FUNCTION lattice_uri_encode(p_in text, p_keep_slash boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $uri$
DECLARE
  ch text;
  out text := '';
  i int;
BEGIN
  IF p_in IS NULL THEN RETURN ''; END IF;
  FOR i IN 1 .. length(p_in) LOOP
    ch := substr(p_in, i, 1);
    IF ch ~ '[A-Za-z0-9._~-]' OR (p_keep_slash AND ch = '/') THEN
      out := out || ch;
    ELSE
      out := out || upper('%' || encode(convert_to(ch, 'UTF8'), 'hex'));
    END IF;
  END LOOP;
  RETURN out;
END;
$uri$;

-- Compute an AWS SigV4 presigned URL. Deterministic given the date params.
CREATE OR REPLACE FUNCTION lattice_aws_sigv4_presign(
  p_method text, p_host text, p_region text, p_service text, p_path text,
  p_access_key text, p_secret_key text, p_expires int, p_amz_date text, p_datestamp text
) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $sig$
DECLARE
  canonical_uri text;
  credential text;
  canonical_qs text;
  canonical_headers text;
  signed_headers text := 'host';
  canonical_request text;
  scope text;
  string_to_sign text;
  k_date bytea;
  k_region bytea;
  k_service bytea;
  k_signing bytea;
  signature text;
BEGIN
  canonical_uri := lattice_uri_encode(p_path, true);
  scope := p_datestamp || '/' || p_region || '/' || p_service || '/aws4_request';
  credential := lattice_uri_encode(p_access_key || '/' || scope, false);
  -- Query params must be sorted by key; values URI-encoded.
  canonical_qs :=
    'X-Amz-Algorithm=AWS4-HMAC-SHA256' ||
    '&X-Amz-Credential=' || credential ||
    '&X-Amz-Date=' || p_amz_date ||
    '&X-Amz-Expires=' || p_expires::text ||
    '&X-Amz-SignedHeaders=' || signed_headers;
  canonical_headers := 'host:' || p_host || E'\\n';
  canonical_request :=
    p_method || E'\\n' ||
    canonical_uri || E'\\n' ||
    canonical_qs || E'\\n' ||
    canonical_headers || E'\\n' ||
    signed_headers || E'\\n' ||
    'UNSIGNED-PAYLOAD';
  string_to_sign :=
    'AWS4-HMAC-SHA256' || E'\\n' ||
    p_amz_date || E'\\n' ||
    scope || E'\\n' ||
    encode(digest(convert_to(canonical_request, 'UTF8'), 'sha256'), 'hex');
  k_date := hmac(convert_to(p_datestamp, 'UTF8'), convert_to('AWS4' || p_secret_key, 'UTF8'), 'sha256');
  k_region := hmac(convert_to(p_region, 'UTF8'), k_date, 'sha256');
  k_service := hmac(convert_to(p_service, 'UTF8'), k_region, 'sha256');
  k_signing := hmac(convert_to('aws4_request', 'UTF8'), k_service, 'sha256');
  signature := encode(hmac(convert_to(string_to_sign, 'UTF8'), k_signing, 'sha256'), 'hex');
  RETURN 'https://' || p_host || canonical_uri || '?' || canonical_qs ||
         '&X-Amz-Signature=' || signature;
END;
$sig$;

-- Member-facing entry: presign GET/PUT for a files row the caller can see.
CREATE OR REPLACE FUNCTION lattice_presign_file(p_file_id text, p_method text, p_ttl int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $pf$
DECLARE
  s ${S3_SECRET_TABLE}%ROWTYPE;
  object_key text;
  object_path text;
  host text;
  amz_date text;
  datestamp text;
  ttl int;
BEGIN
  -- Visibility gate: the member may presign ONLY a row they can see.
  IF NOT lattice_row_visible('files', p_file_id) THEN
    RAISE EXCEPTION 'not authorized for file %', p_file_id USING ERRCODE = '42501';
  END IF;
  IF upper(p_method) NOT IN ('GET', 'PUT') THEN
    RAISE EXCEPTION 'unsupported method %', p_method;
  END IF;
  ttl := least(greatest(coalesce(p_ttl, 60), 1), 60); -- hard cap 60s

  SELECT * INTO s FROM ${S3_SECRET_TABLE} WHERE id = 'default';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cloud S3 not configured';
  END IF;

  -- Resolve the VERBATIM S3 object key from the files row. The key was finalized
  -- at upload time (it already includes any configured prefix) and is stored in
  -- the row''s s3://bucket/<key> ref_uri, so the owner read path and this presigner
  -- both use it as-is. The prefix is NEVER re-prepended here -- doing so would
  -- double it (e.g. <prefix>/<prefix>/<sha>) and 404 on the default config.
  SELECT ref_uri INTO object_key FROM files WHERE id = p_file_id;
  IF object_key IS NULL THEN
    RAISE EXCEPTION 'no object reference for file %', p_file_id;
  END IF;
  object_key := substring(object_key from '^s3://[^/]+/(.+)$');
  IF object_key IS NULL OR object_key = '' THEN
    RAISE EXCEPTION 'file % is not an s3:// reference', p_file_id;
  END IF;

  -- AWS uses VIRTUAL-HOSTED style (bucket in the host). A custom endpoint — an
  -- S3-compatible store such as MinIO — uses PATH style: the bucket goes in the
  -- URL path, not the host. The path is exactly what gets signed, so the SigV4
  -- signature stays valid either way; only the host/path split differs.
  IF s.endpoint IS NOT NULL THEN
    host := s.endpoint;
    object_path := '/' || s.bucket || '/' || object_key;
  ELSE
    host := s.bucket || '.s3.' || s.region || '.amazonaws.com';
    object_path := '/' || object_key;
  END IF;
  amz_date := to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
  datestamp := to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD');

  RETURN lattice_aws_sigv4_presign(
    upper(p_method), host, s.region, 's3', object_path,
    s.access_key, s.secret_key, ttl, amz_date, datestamp);
END;
$pf$;
`;
}

/**
 * Install the presigner into the current Postgres schema. No-op on SQLite.
 * `schema` is used to pin the `SECURITY DEFINER` search_path (reuse
 * {@link cloudSchema} to resolve it) — required to prevent a member from
 * shadowing `files` / the visibility helpers via `pg_temp`.
 */
export async function installFilePresigner(adapter: StorageAdapter, schema: string): Promise<void> {
  if (adapter.dialect !== 'postgres') return;
  const sql = pinPresignerDefiner(filePresignSql(), schema);
  await runAsyncOrSync(adapter, sql);
}

export interface CloudS3Secret {
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Optional key prefix applied to every object. */
  prefix?: string;
  /** Optional host override for S3-compatible stores. */
  endpoint?: string;
}

/** Store/replace the owner's least-privilege S3 key (owner-only; never granted). */
export async function setCloudS3Secret(
  adapter: StorageAdapter,
  secret: CloudS3Secret,
): Promise<void> {
  if (adapter.dialect !== 'postgres') return;
  await runAsyncOrSync(
    adapter,
    `INSERT INTO ${S3_SECRET_TABLE} (id, bucket, region, prefix, endpoint, access_key, secret_key, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, now()::text)
     ON CONFLICT (id) DO UPDATE SET
       bucket = excluded.bucket, region = excluded.region, prefix = excluded.prefix,
       endpoint = excluded.endpoint, access_key = excluded.access_key,
       secret_key = excluded.secret_key, updated_at = excluded.updated_at`,
    [
      secret.bucket,
      secret.region,
      secret.prefix ?? '',
      secret.endpoint ?? null,
      secret.accessKey,
      secret.secretKey,
    ],
  );
}

/**
 * Grant a member group EXECUTE on the presigner (so every current + future
 * member can presign their own visible files), WITHOUT granting any access to
 * the owner-only secret table. Idempotent.
 */
export async function grantPresignerToMemberGroup(
  adapter: StorageAdapter,
  memberGroup: string,
): Promise<void> {
  if (adapter.dialect !== 'postgres') return;
  const g = memberGroup.replace(/"/g, '""');
  await runAsyncOrSync(
    adapter,
    `GRANT EXECUTE ON FUNCTION lattice_presign_file(text, text, int) TO "${g}"`,
  );
  // Defense-in-depth: ensure the secret table is NOT readable by the group.
  await runAsyncOrSync(adapter, `REVOKE ALL ON ${S3_SECRET_TABLE} FROM "${g}"`);
}

/** Whether the presigner function is installed in the current schema. */
export async function hasFilePresigner(adapter: StorageAdapter): Promise<boolean> {
  if (adapter.dialect !== 'postgres') return false;
  // `pg_proc` always exists, so a query failure here is a real connection/auth
  // error — let it surface rather than masquerading as "presigner not installed"
  // (which would trigger a misleading reinstall instead of reporting the fault).
  const row = await getAsyncOrSync(
    adapter,
    `SELECT count(*) AS n FROM pg_proc WHERE proname = 'lattice_presign_file'`,
  );
  return Number(row?.n ?? 0) > 0;
}
