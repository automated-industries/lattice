import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import { getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { LATTICE_MIGRATION_LOCK_ID } from '../db/lock-ids.js';

/**
 * Run idempotent cloud-bootstrap DDL directly, serialized by the SAME
 * transaction-scoped advisory lock the migration path uses. Going direct (rather
 * than a one-shot version-gated migration) is what makes the bootstrap CONVERGE
 * on every owner open; the advisory lock is what keeps two concurrent runners (a
 * second owner open, or an open racing `secure`) from colliding on catalog
 * updates ("tuple concurrently updated"). The DDL is all CREATE … IF NOT EXISTS /
 * CREATE OR REPLACE, so re-running is cheap + safe. No-op-safe on adapters
 * without `withClient` (falls back to a plain run).
 */
export async function runCloudBootstrapSql(db: Lattice, sql: string): Promise<void> {
  const adapter = db.adapter;
  if (adapter.withClient) {
    await adapter.withClient(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock($1::bigint)', [
        LATTICE_MIGRATION_LOCK_ID.toString(),
      ]);
      await tx.run(sql);
    });
  } else {
    await runAsyncOrSync(adapter, sql);
  }
}

/**
 * Database-enforced row-level security for a shared cloud Postgres.
 *
 * Model: a cloud is a shared Postgres database. Each member connects DIRECTLY
 * as their own scoped, non-superuser login role — there is no server process,
 * no bearer token, and no application-layer filter. Postgres itself prevents a
 * member from reading or writing another member's rows, via:
 *
 *   - out-of-band ownership bookkeeping (`__lattice_owners` / `__lattice_row_grants`),
 *     never injected into user tables and never directly readable by members;
 *   - a `SECURITY DEFINER` visibility check keyed on `session_user` (the member's
 *     LOGIN role — definer-invariant, and members always connect as that role);
 *   - `ENABLE` + `FORCE ROW LEVEL SECURITY` on every shared table, with policies
 *     that call the visibility check; and
 *   - a per-table `SECURITY DEFINER` ownership trigger that stamps the inserting
 *     member as owner (members cannot write the bookkeeping tables directly).
 *
 * This is Postgres-only: SQLite has no roles or RLS and is the single-user local
 * backend, so every installer here is a no-op on SQLite. The pk text written to
 * `__lattice_owners.pk` uses the same canonical serialization as the rest of
 * lattice — `CAST(col AS TEXT)` joined by a TAB (`chr(9)`), single keys bare — so
 * ownership rows line up with change-log / lookup keys.
 *
 * Verified empirically: two non-superuser roles connecting directly cannot see,
 * update, or delete each other's private rows; cannot read the bookkeeping; cannot
 * `DISABLE ROW LEVEL SECURITY`; cannot `SET ROLE` to another member.
 */

/** RLS lives only on Postgres clouds. */
function isPg(db: Lattice): boolean {
  return db.getDialect() === 'postgres';
}

/** Canonical pk SQL expression, matching `Lattice._pkSqlExpr` but with a caller-chosen
 *  column prefix: `''` for a policy row context (`CAST("id" AS TEXT)`), or `NEW.`/`OLD.`
 *  for a trigger (`CAST(NEW."id" AS TEXT)`). Single column → bare (no separator). */
export function pkSqlExpr(pkCols: readonly string[], prefix: string): string {
  if (pkCols.length === 0) {
    throw new Error('cloud RLS: cannot key a table with no primary key column');
  }
  return pkCols.map((c) => `CAST(${prefix}"${c}" AS TEXT)`).join(` || chr(9) || `);
}

/**
 * One-time bootstrap for a cloud: the ownership bookkeeping tables and the shared
 * `SECURITY DEFINER` helpers. Idempotent (`CREATE TABLE IF NOT EXISTS`,
 * `CREATE OR REPLACE FUNCTION`). Multi-statement — Postgres-only, so it never hits
 * the single-statement SQLite migration path.
 *
 * Every `SECURITY DEFINER` helper below gets `search_path` pinned at install time
 * via {@link pinDefinerSearchPath} (see its doc for the threat it closes). The pin
 * is applied in {@link installCloudRls}, not baked into the literal here, because
 * the cloud's schema name is only known at runtime (`current_schema()`).
 */
/**
 * Group role every cloud member inherits. Table privileges are granted to the
 * group, so adding a shared table or a member is a single GRANT — while RLS still
 * filters rows per individual login role (`session_user`). The group grants
 * *access*, never *visibility*.
 */
export const MEMBER_GROUP = 'lattice_members';

/**
 * Pin `search_path` on every `SECURITY DEFINER` function in a cloud SQL blob.
 *
 * A `SECURITY DEFINER` function with no `SET search_path` resolves unqualified
 * relation names using the CALLER's search_path — and Postgres searches the
 * caller's `pg_temp` schema FIRST for relations unless `pg_temp` is named
 * explicitly later in the path. A scoped member could therefore
 * `CREATE TEMP TABLE __lattice_owners(...)` to SHADOW the ownership bookkeeping
 * these helpers read, and make `lattice_row_visible` / `lattice_is_owner` return
 * whatever they like — a full RLS bypass. Pinning `search_path = "<schema>",
 * pg_temp` (real schema first, `pg_temp` LAST) forces every unqualified name to
 * resolve against the genuine cloud schema and never a member's temp object.
 *
 * The regex matches the `SECURITY DEFINER AS` that introduces each function body.
 * The only non-DEFINER function in these blobs (`lattice_notify_change`) is plain
 * `AS` with no `SECURITY DEFINER`, so it is intentionally left untouched.
 */
export function pinDefinerSearchPath(sql: string, schema: string): string {
  const safe = schema.replace(/"/g, '""');
  return sql.replace(
    /SECURITY DEFINER AS/g,
    `SECURITY DEFINER SET search_path = "${safe}", pg_temp AS`,
  );
}

/**
 * The schema the cloud bookkeeping lives in (where the bootstrap created its tables
 * and where unqualified names must resolve). Read at install time so the
 * `search_path` pin baked into each DEFINER function names the real schema. Throws
 * rather than guessing if `current_schema()` is unexpectedly empty.
 */
export async function cloudSchema(db: Lattice): Promise<string> {
  const row = (await getAsyncOrSync(db.adapter, `SELECT current_schema() AS schema`)) as
    | { schema?: string | null }
    | undefined;
  const s = row?.schema;
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('cloud RLS: could not resolve current_schema() for search_path pinning');
  }
  return s;
}

/**
 * Defense-in-depth companion to the `search_path` pin: revoke the schema-level
 * `CREATE` that (pre-PG15) `public` grants to `PUBLIC` by default, so a member
 * cannot plant a PERMANENT object to shadow the bookkeeping either. Best-effort —
 * a cloud whose installer doesn't own the schema simply skips it (the pin above is
 * the actual guarantee; this only narrows the attack surface further).
 */
function revokeSchemaCreateSql(schema: string): string {
  const lit = `'${schema.replace(/'/g, "''")}'`;
  return `
DO $LATTICE_REVOKE$ BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', ${lit});
EXCEPTION WHEN OTHERS THEN
  NULL; -- not the schema owner, or already revoked
END $LATTICE_REVOKE$;
`;
}

export const CLOUD_RLS_BOOTSTRAP_SQL = `
-- Member group (NOLOGIN). Members inherit schema/connect/table privileges from it;
-- RLS filters per the individual member's login role, so the group never widens
-- what a member can see. Idempotent.
DO $LATTICE$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MEMBER_GROUP}') THEN
    CREATE ROLE ${MEMBER_GROUP} NOLOGIN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${MEMBER_GROUP}', current_schema());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${MEMBER_GROUP}', current_database());
END $LATTICE$;

CREATE TABLE IF NOT EXISTS "__lattice_owners" (
  "table_name" text NOT NULL,
  "pk"         text NOT NULL,
  "owner_role" text NOT NULL,
  "visibility" text NOT NULL DEFAULT 'private' CHECK ("visibility" IN ('private','everyone','custom')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("table_name", "pk")
);

CREATE TABLE IF NOT EXISTS "__lattice_row_grants" (
  "table_name"   text NOT NULL,
  "pk"           text NOT NULL,
  "grantee_role" text NOT NULL,
  "granted_by"   text NOT NULL,
  "granted_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("table_name", "pk", "grantee_role")
);

CREATE INDEX IF NOT EXISTS "idx_lattice_row_grants_grantee"
  ON "__lattice_row_grants" ("grantee_role", "table_name", "pk");

-- Per-table policy: the owner-controlled defaults that govern a whole table.
-- default_row_visibility is the visibility NEW rows are stamped with (the insert
-- trigger reads it); never_share is a hard exclusion — the share/grant functions
-- refuse to elevate such a table and the trigger forces its rows private. Owner-
-- managed; members have no grant (it never appears in their data API).
CREATE TABLE IF NOT EXISTS "__lattice_table_policy" (
  "table_name"             text PRIMARY KEY,
  "default_row_visibility" text NOT NULL DEFAULT 'private'
    CHECK ("default_row_visibility" IN ('private','everyone')),
  "never_share"            boolean NOT NULL DEFAULT false,
  "updated_by"             text NOT NULL DEFAULT session_user,
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);

-- Per-column audience policy: the CANONICAL store of which column carries which
-- audience spec (role: / subject: / source: / owner / everyone). Previously the
-- spec lived only in the owner's on-disk YAML and was compiled into the mask view
-- once at init; storing it here makes it cloud-canonical and member-consistent.
-- The generated <table>_v mask view is regenerated from THIS table on change.
-- Owner-managed; members have no grant.
CREATE TABLE IF NOT EXISTS "__lattice_column_policy" (
  "table_name"  text NOT NULL,
  "column_name" text NOT NULL,
  "audience"    text NOT NULL,
  "updated_by"  text NOT NULL DEFAULT session_user,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("table_name", "column_name")
);

-- Owner-only audit of issued member invites: which scoped role was minted for
-- which email (HASHED — the plaintext email is never stored), when it expires,
-- and whether it was redeemed/revoked. No plaintext password is ever stored
-- (the credential lives only inside the email-bound token the owner delivers).
-- Owner-managed; members have no grant. Named distinctly from any legacy
-- team-model invitations table so a pre-existing cloud never collides.
CREATE TABLE IF NOT EXISTS "__lattice_member_invites" (
  "id"          text PRIMARY KEY,
  "role"        text NOT NULL,
  "email_hash"  text NOT NULL,
  "email"       text,
  "created_by"  text NOT NULL DEFAULT session_user,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "redeemed_at" timestamptz,
  "revoked_at"  timestamptz
);
-- Plaintext invitee email (owner-only table; members have no grant) so the
-- owner's Members list can show who each member is. Added via ALTER so clouds
-- created before this column converge to it on the owner's next open (the
-- bootstrap is now run directly + idempotently, not version-gated).
ALTER TABLE "__lattice_member_invites" ADD COLUMN IF NOT EXISTS "email" text;

-- #3.1 — one-time-use + revocation enforcement. After a member authenticates to
-- the cloud with their minted credential, the join path calls this to CLAIM the
-- invite. The single atomic UPDATE stamps redeemed_at and returns true ONLY when
-- an invite for the CALLING role (session_user) is still pending: not already
-- redeemed (one-time-use), not revoked, and not expired. A replayed redeem of a
-- leaked token, a revoked invite, or an expired one returns false, so the caller
-- rejects the join. Members have no direct grant on the owner-only
-- __lattice_member_invites table — this SECURITY DEFINER function is the only
-- path, and it can claim ONLY the caller's own invite (keyed on session_user,
-- never a caller-supplied parameter, so one member can't burn another's invite).
CREATE OR REPLACE FUNCTION lattice_claim_invite()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_ok boolean;
BEGIN
  UPDATE "__lattice_member_invites"
     SET "redeemed_at" = now()
   WHERE "role" = session_user
     AND "redeemed_at" IS NULL
     AND "revoked_at" IS NULL
     AND "expires_at" > now()
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $fn$;

-- Visibility check. SECURITY DEFINER so it reads bookkeeping the member can't;
-- keyed on session_user (the member's login role). A row with no ownership record
-- is visible to nobody.
CREATE OR REPLACE FUNCTION lattice_row_visible(p_table text, p_pk text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "__lattice_owners" o
     WHERE o."table_name" = p_table AND o."pk" = p_pk
       AND ( o."owner_role" = session_user
          OR o."visibility" = 'everyone'
          OR ( o."visibility" = 'custom' AND EXISTS (
                 SELECT 1 FROM "__lattice_row_grants" g
                  WHERE g."table_name" = o."table_name" AND g."pk" = o."pk"
                    AND g."grantee_role" = session_user)))
  );
$fn$;

-- Shared owner gate: raises unless the connected member owns (p_table, p_pk).
-- p_action is spliced into the message so every caller keeps its exact wording.
-- SECURITY DEFINER + session_user (never current_user), the cloud identity invariant.
CREATE OR REPLACE FUNCTION lattice_require_owner(p_table text, p_pk text, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_owner text;
BEGIN
  SELECT o."owner_role" INTO v_owner FROM "__lattice_owners" o
    WHERE o."table_name" = p_table AND o."pk" = p_pk;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'lattice: no ownership record for %/%', p_table, p_pk; END IF;
  IF v_owner <> session_user THEN RAISE EXCEPTION 'lattice: only the row owner may %', p_action; END IF;
END $fn$;

-- Shared never-share check: is p_table flagged private-only?
CREATE OR REPLACE FUNCTION lattice_table_is_never_share(p_table text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT COALESCE(
    (SELECT "never_share" FROM "__lattice_table_policy" WHERE "table_name" = p_table),
    false
  )
$fn$;

-- Owner-only: change a row's visibility. Raises if the caller is not the owner.
CREATE OR REPLACE FUNCTION lattice_set_row_visibility(p_table text, p_pk text, p_visibility text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF p_visibility NOT IN ('private','everyone','custom') THEN
    RAISE EXCEPTION 'lattice: invalid visibility %', p_visibility;
  END IF;
  IF p_visibility <> 'private' AND lattice_table_is_never_share(p_table) THEN
    RAISE EXCEPTION 'lattice: "%" is a private-only table and cannot be shared', p_table;
  END IF;
  PERFORM lattice_require_owner(p_table, p_pk, 'change its sharing');
  UPDATE "__lattice_owners" SET "visibility" = p_visibility, "updated_at" = now()
    WHERE "table_name" = p_table AND "pk" = p_pk;
  -- Emit a change-feed entry so the realtime NOTIFY fires: a sharing change alters
  -- what members may see, so their clients must refetch + re-render even though no
  -- user-table row was written.
  INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
    VALUES (p_table, p_pk, 'upsert', session_user);
END $fn$;

-- Owner-only: grant a specific member access to a row (sets visibility = 'custom').
CREATE OR REPLACE FUNCTION lattice_grant_row(p_table text, p_pk text, p_grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF lattice_table_is_never_share(p_table) THEN
    RAISE EXCEPTION 'lattice: "%" is a private-only table and cannot be shared', p_table;
  END IF;
  PERFORM lattice_require_owner(p_table, p_pk, 'grant access');
  UPDATE "__lattice_owners" SET "visibility" = 'custom', "updated_at" = now()
    WHERE "table_name" = p_table AND "pk" = p_pk;
  INSERT INTO "__lattice_row_grants" ("table_name","pk","grantee_role","granted_by")
    VALUES (p_table, p_pk, p_grantee, session_user)
    ON CONFLICT ("table_name","pk","grantee_role") DO NOTHING;
  -- Change-feed entry → realtime NOTIFY so the granted member re-renders.
  INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
    VALUES (p_table, p_pk, 'upsert', session_user);
END $fn$;

-- Owner-only: revoke a member's access to a row.
CREATE OR REPLACE FUNCTION lattice_revoke_row(p_table text, p_pk text, p_grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  PERFORM lattice_require_owner(p_table, p_pk, 'revoke access');
  DELETE FROM "__lattice_row_grants"
    WHERE "table_name" = p_table AND "pk" = p_pk AND "grantee_role" = p_grantee;
  -- Change-feed entry → realtime NOTIFY so the revoked member re-renders (their
  -- now-stale derived values revert to ground truth on the next render).
  INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
    VALUES (p_table, p_pk, 'upsert', session_user);
END $fn$;

-- Can the connected member see a source? Reduces to the source row's own RLS, so
-- file-sharing drives enrichment visibility for free. p_source_ref is the
-- source's primary key in the files table.
CREATE OR REPLACE FUNCTION lattice_source_visible(p_source_ref text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT lattice_row_visible('files', p_source_ref)
$fn$;

-- Is the connected member the OWNER of this row? Used by the "owner" column
-- audience (a secret column reveals only to the row owner). SECURITY DEFINER +
-- session_user, like the other predicates.
CREATE OR REPLACE FUNCTION lattice_is_owner(p_table text, p_pk text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "__lattice_owners" o
     WHERE o."table_name" = p_table AND o."pk" = p_pk AND o."owner_role" = session_user
  )
$fn$;

-- Owner-only: set a table's default row visibility for NEW rows. Raises unless the
-- caller can create roles (a cloud owner / DBA). Rejects 'everyone' on a
-- never-share table.
CREATE OR REPLACE FUNCTION lattice_set_table_default_visibility(p_table text, p_visibility text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may set a table''s default visibility';
  END IF;
  IF p_visibility NOT IN ('private','everyone') THEN
    RAISE EXCEPTION 'lattice: invalid default visibility %', p_visibility;
  END IF;
  IF p_visibility = 'everyone' AND lattice_table_is_never_share(p_table) THEN
    RAISE EXCEPTION 'lattice: "%" is a private-only table; its rows cannot default to everyone', p_table;
  END IF;
  INSERT INTO "__lattice_table_policy" ("table_name","default_row_visibility","updated_by","updated_at")
    VALUES (p_table, p_visibility, session_user, now())
    ON CONFLICT ("table_name") DO UPDATE
      SET "default_row_visibility" = EXCLUDED."default_row_visibility",
          "updated_by" = session_user, "updated_at" = now();
END $fn$;

-- Owner-only: mark a table never-shareable (Secrets/Messages-class). When true the
-- share/grant functions raise and the insert trigger forces new rows private; the
-- default visibility is also forced private. Turning it ON also RETROACTIVELY
-- privatizes the table: any row currently shared ('everyone'/'custom') is reset to
-- 'private' and every existing row grant on the table is dropped — otherwise
-- flagging a table never-share would leave already-leaked rows visible, defeating
-- the point. Idempotent: re-running with already-private rows updates nothing.
CREATE OR REPLACE FUNCTION lattice_set_table_never_share(p_table text, p_on boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may change a table''s never-share flag';
  END IF;
  INSERT INTO "__lattice_table_policy" ("table_name","never_share","default_row_visibility","updated_by","updated_at")
    VALUES (p_table, p_on, CASE WHEN p_on THEN 'private' ELSE 'private' END, session_user, now())
    ON CONFLICT ("table_name") DO UPDATE
      SET "never_share" = EXCLUDED."never_share",
          "default_row_visibility" = CASE WHEN EXCLUDED."never_share"
                                          THEN 'private' ELSE "__lattice_table_policy"."default_row_visibility" END,
          "updated_by" = session_user, "updated_at" = now();
  IF p_on THEN
    UPDATE "__lattice_owners" SET "visibility" = 'private', "updated_at" = now()
      WHERE "table_name" = p_table AND "visibility" <> 'private';
    DELETE FROM "__lattice_row_grants" WHERE "table_name" = p_table;
  END IF;
END $fn$;

-- Owner-only: set (or clear) a column's audience spec in the canonical DB store.
-- An empty/null spec removes the policy row (column becomes unmasked). The GUI/lib
-- regenerates the table's mask view from this store after calling this.
CREATE OR REPLACE FUNCTION lattice_set_column_audience(p_table text, p_column text, p_audience text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may set a column audience';
  END IF;
  IF p_audience IS NULL OR btrim(p_audience) = '' THEN
    DELETE FROM "__lattice_column_policy" WHERE "table_name" = p_table AND "column_name" = p_column;
  ELSE
    INSERT INTO "__lattice_column_policy" ("table_name","column_name","audience","updated_by","updated_at")
      VALUES (p_table, p_column, p_audience, session_user, now())
      ON CONFLICT ("table_name","column_name") DO UPDATE
        SET "audience" = EXCLUDED."audience", "updated_by" = session_user, "updated_at" = now();
  END IF;
END $fn$;

-- Append-only change feed. The per-table ownership trigger records one row per
-- INSERT/UPDATE/DELETE; the AFTER INSERT trigger here fires pg_notify so a
-- connected member's realtime broker refreshes. Members get no direct access —
-- the NOTIFY carries only (table, pk, op) metadata, and the SPA refetches the row
-- itself through RLS, so another member's content is never broadcast.
CREATE TABLE IF NOT EXISTS "__lattice_changes" (
  "seq"        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "table_name" text NOT NULL,
  "pk"         text NOT NULL,
  "op"         text NOT NULL CHECK ("op" IN ('upsert','delete')),
  "owner_role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION lattice_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('lattice_changes', json_build_object(
    'seq', NEW."seq",
    'table_name', NEW."table_name",
    'pk', NEW."pk",
    'op', NEW."op",
    'owner_role', NEW."owner_role",
    'created_at', NEW."created_at"
  )::text);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS "lattice_notify_change_trg" ON "__lattice_changes";
CREATE TRIGGER "lattice_notify_change_trg" AFTER INSERT ON "__lattice_changes"
  FOR EACH ROW EXECUTE FUNCTION lattice_notify_change();

-- #4.4 — seq-based catch-up after a realtime gap. NOTIFY is fire-and-forget, so a
-- broker that drops its LISTEN (network blip, laptop sleep) misses every change
-- during the gap. The broker tracks the highest seq it delivered and, on
-- reconnect, replays what it missed via this function. Members have NO direct
-- grant on __lattice_changes (reading it raw would leak every change on the
-- cloud), so this SECURITY DEFINER function is the only path and it returns ONLY
-- the rows the CALLING role can see: keyed on session_user via lattice_row_visible
-- (same gate as live fan-out, #4.3). Deletes are excluded — the ownership record
-- is gone post-delete so visibility can't be verified, and replaying them would
-- leak deleted-row pks (the client reconciles deletes on its reconnect refetch).
-- Bounded (LIMIT clamped ≤ 1000) so a long gap can't stream the whole table (Rule:
-- bounded reads on a hot path).
CREATE OR REPLACE FUNCTION lattice_changes_since(p_seq bigint, p_limit int)
RETURNS TABLE(seq bigint, table_name text, pk text, op text, owner_role text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT c."seq", c."table_name", c."pk", c."op", c."owner_role", c."created_at"
    FROM "__lattice_changes" c
   WHERE c."seq" > p_seq
     AND c."op" = 'upsert'
     AND lattice_row_visible(c."table_name", c."pk")
   ORDER BY c."seq" ASC
   LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 500), 1000));
$fn$;

-- #2.1 — per-row access summary for the connecting role. The GUI attaches this as
-- each row's _access so the sharing affordance renders, but __lattice_owners is
-- owner-only bookkeeping (members have no grant), so a member reading it directly
-- got "permission denied". This SECURITY DEFINER function returns visibility +
-- whether the CALLER owns the row, ONLY for the rows the caller can actually see
-- (lattice_row_visible, keyed on session_user) — so a member learns nothing about
-- rows hidden from it. Member-callable; the owner gets the same view of its rows.
CREATE OR REPLACE FUNCTION lattice_rows_access(p_table text, p_pks text[])
RETURNS TABLE(pk text, visibility text, owned boolean)
LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT o."pk", o."visibility", (o."owner_role" = session_user) AS owned
    FROM "__lattice_owners" o
   WHERE o."table_name" = p_table
     AND o."pk" = ANY(p_pks)
     AND lattice_row_visible(o."table_name", o."pk");
$fn$;

-- #2.1 — grantees of a CALLER-OWNED custom-shared row (who you shared YOUR row
-- with). Only the row owner sees this (the WHERE pins owner_role = session_user),
-- so a member can't enumerate another owner's grants. __lattice_row_grants is
-- member-ungranted, so this SECURITY DEFINER function is the member-safe path.
CREATE OR REPLACE FUNCTION lattice_row_grantees(p_table text, p_pks text[])
RETURNS TABLE(pk text, grantee_role text)
LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT g."pk", g."grantee_role"
    FROM "__lattice_row_grants" g
    JOIN "__lattice_owners" o ON o."table_name" = g."table_name" AND o."pk" = g."pk"
   WHERE g."table_name" = p_table
     AND g."pk" = ANY(p_pks)
     AND o."owner_role" = session_user;
$fn$;
`;

/**
 * Per-table RLS setup: a dedicated ownership trigger (pk baked in so it matches the
 * policy's pk exactly), `ENABLE` + `FORCE ROW LEVEL SECURITY`, and the SELECT /
 * UPDATE / DELETE / INSERT policies. Idempotent (`CREATE OR REPLACE`, `DROP … IF
 * EXISTS`). `pkCols` is the table's primary-key column list (`Lattice` resolves it
 * via its pk utilities); throws for an unkeyable table.
 */
export function tableRlsSql(table: string, pkCols: readonly string[]): string {
  const q = `"${table.replace(/"/g, '""')}"`;
  const lit = `'${table.replace(/'/g, "''")}'`;
  const pkNew = pkSqlExpr(pkCols, 'NEW.');
  const pkOld = pkSqlExpr(pkCols, 'OLD.');
  const pkRow = pkSqlExpr(pkCols, '');
  const trg = `lattice_track_${table.replace(/[^A-Za-z0-9_]/g, '_')}`;
  return `
CREATE OR REPLACE FUNCTION "${trg}"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "__lattice_owners" ("table_name","pk","owner_role","visibility")
      VALUES (${lit}, ${pkNew}, session_user,
        CASE
          -- never-share always wins: such a table's rows are private, full stop.
          WHEN COALESCE((SELECT "never_share" FROM "__lattice_table_policy" WHERE "table_name" = ${lit}), false)
            THEN 'private'
          -- per-INSERT override: a caller forcing visibility for THIS write (e.g.
          -- chat "private mode") sets the transaction-local lattice.force_row_visibility
          -- GUC, so the row is stamped atomically at insert — never momentarily at
          -- the table default, and the change-feed NOTIFY (deferred to COMMIT) only
          -- fires once the row already carries this visibility.
          WHEN NULLIF(current_setting('lattice.force_row_visibility', true), '') IN ('private','everyone')
            THEN current_setting('lattice.force_row_visibility', true)
          ELSE COALESCE((SELECT "default_row_visibility" FROM "__lattice_table_policy" WHERE "table_name" = ${lit}), 'private')
        END)
      ON CONFLICT ("table_name","pk") DO NOTHING;
    INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
      VALUES (${lit}, ${pkNew}, 'upsert', session_user);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
      VALUES (${lit}, ${pkNew}, 'upsert', session_user);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM "__lattice_owners"     WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    DELETE FROM "__lattice_row_grants" WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    INSERT INTO "__lattice_changes" ("table_name","pk","op","owner_role")
      VALUES (${lit}, ${pkOld}, 'delete', session_user);
    RETURN OLD;
  END IF;
  RETURN NEW;
END $fn$;

ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${q} FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO ${MEMBER_GROUP};

DROP POLICY IF EXISTS "lattice_sel" ON ${q};
CREATE POLICY "lattice_sel" ON ${q} FOR SELECT USING (lattice_row_visible(${lit}, ${pkRow}));
DROP POLICY IF EXISTS "lattice_upd" ON ${q};
CREATE POLICY "lattice_upd" ON ${q} FOR UPDATE USING (lattice_row_visible(${lit}, ${pkRow}))
                                              WITH CHECK (lattice_row_visible(${lit}, ${pkRow}));
DROP POLICY IF EXISTS "lattice_del" ON ${q};
CREATE POLICY "lattice_del" ON ${q} FOR DELETE USING (lattice_row_visible(${lit}, ${pkRow}));
DROP POLICY IF EXISTS "lattice_ins" ON ${q};
CREATE POLICY "lattice_ins" ON ${q} FOR INSERT WITH CHECK (true);

DROP TRIGGER IF EXISTS "${trg}" ON ${q};
CREATE TRIGGER "${trg}" AFTER INSERT OR UPDATE OR DELETE ON ${q}
  FOR EACH ROW EXECUTE FUNCTION "${trg}"();
`;
}

/**
 * Re-own the SQLite-compat polyfills (`json_extract` / `strftime`) to the members
 * GROUP role, so any member (a member of that group) can replace them on a future
 * upgrade. They must never stay owned by whichever single role created them first —
 * that is exactly what made every OTHER member's per-connect registration raise
 * "must be owner of function" and abort their render. Best-effort: reassigning
 * ownership needs the current owner or a superuser, so a non-owner connection
 * leaves it as-is — harmless, because the create-if-absent registration guard
 * already keeps members from tripping on the ownership. Idempotent. No-op off PG.
 */
export async function ownPolyfillsByGroup(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  for (const sig of ['json_extract(text, text)', 'strftime(text, text)']) {
    try {
      const reg = await getAsyncOrSync(db.adapter, `SELECT to_regprocedure($1) AS reg`, [sig]);
      if (reg?.reg == null) continue; // not created yet — nothing to reassign
      await runAsyncOrSync(db.adapter, `ALTER FUNCTION ${sig} OWNER TO "${MEMBER_GROUP}"`);
    } catch {
      // best-effort hygiene — the create-if-absent guard is the actual fix
    }
  }
}

/** Install the cloud RLS bootstrap (bookkeeping + helper functions). No-op on SQLite. */
export async function installCloudRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  const schema = await cloudSchema(db);
  // Run the bootstrap DIRECTLY — NOT via a version-gated migration. Every object
  // here is CREATE … IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS +
  // CREATE POLICY / REVOKE, so re-running is cheap and, crucially, CONVERGES.
  // A version gate (once a version is recorded it never re-runs) meant objects
  // ADDED to the bootstrap in a later release — e.g. __lattice_member_invites —
  // never reached clouds already stamped at that version, and `secure` no-op'd.
  // Running it directly on every owner open (see openConfig) closes that gap.
  const sql = pinDefinerSearchPath(CLOUD_RLS_BOOTSTRAP_SQL, schema) + revokeSchemaCreateSql(schema);
  await runCloudBootstrapSql(db, sql);
}

/**
 * Secure the observation substrate (`__lattice_changelog`) so a member reads
 * only what they're allowed to: a DERIVED observation only when it can reach
 * EVERY source it was derived from (so a hidden enrichment never reaches the
 * member — existence-hiding is structural), and a ground-truth / audit entry
 * only when the member OWNS the row it records. Both predicates route through the
 * `session_user`-keyed SECURITY DEFINER helpers, so they bind to the real member.
 * `FORCE ROW LEVEL SECURITY` applies the policy even to the table owner. No-op on
 * SQLite (single-user; no cross-viewer leak to guard). Run after the change-log
 * table exists (`Lattice.ensureObservationSubstrate`).
 *
 * Ground-truth entries are OWNER-ONLY (v2), not merely "row is visible". A
 * changelog row carries the full `changes`/`previous` JSON of the underlying row —
 * EVERY column in cleartext, including ones the `<table>_v` mask hides from a
 * non-owner (an `owner`-audience secret column, a role-gated column). If a member
 * who was merely granted the row could read its history, those masked columns
 * would leak in cleartext, bypassing column masking. The row's full mutation
 * history is an owner/audit artifact; a non-owner sees the row only through the
 * masked view, never its raw history. (The derived-observation branch is the
 * per-viewer enrichment path and is unaffected — it carries enrichment, not the
 * base row's masked columns.)
 */
export async function enableChangelogRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  // v3: a derived observation with an EMPTY source_ref array must FAIL CLOSED
  // (not visible). v2's `NOT EXISTS` over an empty array was vacuously true, so a
  // derived row with no sources leaked to every member — mirror fold.ts
  // observationVisible, which requires a non-empty source set. Run DIRECTLY
  // (idempotent DROP/CREATE POLICY) — not version-gated — so it CONVERGES on
  // every owner open, the same as the rest of the bootstrap.
  await runCloudBootstrapSql(
    db,
    `
ALTER TABLE "__lattice_changelog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__lattice_changelog" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON "__lattice_changelog" TO ${MEMBER_GROUP};

DROP POLICY IF EXISTS "lattice_changelog_sel" ON "__lattice_changelog";
CREATE POLICY "lattice_changelog_sel" ON "__lattice_changelog" FOR SELECT USING (
  CASE
    WHEN "change_kind" = 'derived' THEN
      "source_ref" IS NOT NULL
      AND jsonb_array_length("source_ref"::jsonb) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text("source_ref"::jsonb) AS src(sid)
         WHERE NOT lattice_source_visible(src.sid)
      )
    ELSE lattice_is_owner("table_name", "row_id")
  END
);
DROP POLICY IF EXISTS "lattice_changelog_ins" ON "__lattice_changelog";
CREATE POLICY "lattice_changelog_ins" ON "__lattice_changelog" FOR INSERT WITH CHECK (true);
`,
  );
}

/**
 * Lock the assistant's chat tables (`chat_threads` / `chat_messages`) to their
 * author with a RESTRICTIVE policy keyed on the `owner_user_id` column, fail-
 * CLOSED on NULL.
 *
 * RESTRICTIVE means this is AND-ed with the base `lattice_sel`
 * (`lattice_row_visible`) policy, so a chat row is visible / mutable to a member
 * ONLY when it is owned by THIS session AND `owner_user_id` is not null. Net
 * effect: an un-owned (NULL) chat row — the orphaned/legacy rows that leaked — is
 * visible to NO member, and one member can never reach another's chats even if a
 * stray `everyone` flag or an ownership-record mismatch would otherwise let the
 * base policy pass. This is defense-in-depth behind the app-layer owner filter in
 * chat-routes.ts, which additionally covers the BYPASSRLS owner connection that
 * Postgres RLS does not gate at all. `owner_user_id` is stamped by the app to the
 * same `session_user` the cloud RLS keys on. Idempotent → converges on every
 * owner open. No-op off Postgres.
 */
export async function enableChatPrivacyRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  for (const t of ['chat_threads', 'chat_messages']) {
    // The chat tables are created lazily (only once the assistant is used), so a
    // cloud may not have them yet — skip rather than error on a missing relation.
    const reg = await getAsyncOrSync(db.adapter, `SELECT to_regclass($1) AS reg`, [t]);
    if (reg?.reg == null) continue;
    const q = `"${t}"`;
    // RESTRICTIVE + FOR SELECT: AND-ed with the base lattice_sel, this is the
    // READ isolation — a member can SELECT a chat row ONLY if it is theirs, and a
    // NULL-owner row is readable by NO ONE (the orphaned/legacy leak). Scoped to
    // SELECT on purpose: INSERT/UPDATE/DELETE ownership is already gated by the
    // base owner-keyed policies + trigger, and a FOR ALL restrictive policy would
    // (per Postgres, USING doubles as WITH CHECK) reject the owner's own inserts.
    await runCloudBootstrapSql(
      db,
      `
ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${q} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lattice_chat_owner" ON ${q};
CREATE POLICY "lattice_chat_owner" ON ${q} AS RESTRICTIVE FOR SELECT
  USING ("owner_user_id" IS NOT NULL AND "owner_user_id" = session_user);
`,
    );
  }
}

/**
 * Enable RLS on one shared table. No-op on SQLite. Idempotent via a per-table
 * version key. v3 bumps the key so existing clouds re-install the policy-aware
 * insert trigger (which now stamps the per-table `default_row_visibility` / forces
 * private under `never_share`) and pick up the `search_path` pin on the trigger
 * function — neither of which a v2-stamped clone would otherwise get.
 */
export async function enableRlsForTable(
  db: Lattice,
  table: string,
  pkCols: readonly string[],
): Promise<void> {
  if (!isPg(db)) return;
  const schema = await cloudSchema(db);
  const migration: Migration = {
    version: `internal:cloud-rls:table:${table}:v3`,
    sql: pinDefinerSearchPath(tableRlsSql(table, pkCols), schema),
  };
  await db.migrate([migration]);
}

/**
 * Stamp the current role as owner of every row that already exists in a table —
 * for data migrated into a cloud BEFORE the ownership trigger existed (the
 * trigger only fires on new writes). Without this, migrated rows have no
 * ownership record and RLS would hide them from everyone. Idempotent; no-op on
 * SQLite or an unkeyable table.
 */
export async function backfillOwnership(
  db: Lattice,
  table: string,
  pkCols: readonly string[],
): Promise<void> {
  if (!isPg(db) || pkCols.length === 0) return;
  const q = `"${table.replace(/"/g, '""')}"`;
  const lit = `'${table.replace(/'/g, "''")}'`;
  const pkRow = pkSqlExpr(pkCols, '');
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "__lattice_owners" ("table_name","pk","owner_role","visibility")
       SELECT ${lit}, ${pkRow}, current_user, 'private' FROM ${q}
       ON CONFLICT ("table_name","pk") DO NOTHING`,
  );
}
