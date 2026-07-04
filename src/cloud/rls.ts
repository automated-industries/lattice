import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import { getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { LATTICE_MIGRATION_LOCK_ID } from '../db/lock-ids.js';
import { pkSqlExpr } from '../db/pk.js';
import { LINEAGE_TABLE, ensureLineageTable } from '../gui/lineage-store.js';
// Re-exported so existing consumers (cloud/audience.ts) keep importing it from
// here; the canonical definition now lives in the pure db/pk.ts leaf.
export { pkSqlExpr } from '../db/pk.js';

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
/**
 * The role name a PRE-per-cloud-group cloud used for its member group. Postgres
 * roles are cluster-global, so this single name was SHARED by every cloud on one
 * Postgres cluster. Retained only so a legacy cloud can be recognized + migrated
 * (see docs/MIGRATING-4.0.md) — never used to grant access on the live paths.
 */
export const LEGACY_MEMBER_GROUP = 'lattice_members';

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
 * The per-cloud member group role name.
 *
 * Postgres roles + role membership are CLUSTER-GLOBAL (shared by every database
 * and schema on one cluster). A single hard-coded group would therefore be shared
 * by every cloud co-located on one cluster — putting unrelated clouds' members in
 * ONE group, and making concurrent member provisioning across them contend on that
 * one shared role's catalog (pg_authid / pg_auth_members). Deriving the group from
 * the cloud's own (database, schema) namespace gives each cloud its OWN group:
 * genuine cross-cloud isolation, and no shared-catalog contention.
 *
 * Deterministic + stable: the same (database, schema) always yields the same name,
 * so install / provision / reconcile / audience all agree with no coordination.
 * `lattice_m_` + 20 hex of md5 = 30 chars — well under the 63-byte identifier limit,
 * always a legal role name, and md5() is core Postgres (no pgcrypto dependency).
 * Cached per Lattice (one connection = one (database, schema)).
 */
const _memberGroupCache = new WeakMap<object, string>();
const MEMBER_GROUP_RE = /^lattice_m_[0-9a-f]{20}$/;

export async function memberGroupFor(db: Lattice): Promise<string> {
  const cached = _memberGroupCache.get(db);
  if (cached) return cached;
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT 'lattice_m_' || substr(md5(current_database() || ':' || current_schema()), 1, 20) AS grp`,
  )) as { grp?: string | null } | undefined;
  const grp = row?.grp;
  if (typeof grp !== 'string' || !MEMBER_GROUP_RE.test(grp)) {
    throw new Error('cloud RLS: could not resolve a stable per-cloud member group name');
  }
  _memberGroupCache.set(db, grp);
  return grp;
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

export function cloudRlsBootstrapSql(group: string): string {
  return `
-- Member group (NOLOGIN). Members inherit schema/connect/table privileges from it;
-- RLS filters per the individual member's login role, so the group never widens
-- what a member can see. Idempotent.
DO $LATTICE$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${group}') THEN
    CREATE ROLE ${group} NOLOGIN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${group}', current_schema());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${group}', current_database());
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

-- Owner-published entity/render LAYOUT (the entities + entityContexts config
-- blocks), so a joined member — whose generated config has entities: {} — can
-- hydrate the full render layout and produce a complete context tree. This holds
-- schema CONFIG, not row data, so it is safe to share with members (granted
-- SELECT). A shared singleton, like __lattice_user_identity: no per-row RLS.
CREATE TABLE IF NOT EXISTS "__lattice_shared_schema" (
  "id" TEXT PRIMARY KEY DEFAULT 'singleton',
  "entities_json" TEXT,
  "contexts_json" TEXT,
  "updated_at" TEXT
);
-- Owner-published computed-table definitions (the config's computed: block), so
-- a joined member hydrates computed tables the same way it hydrates entities.
-- Added via ALTER so clouds created before this column converge to it on the
-- owner's next open (same pattern as __lattice_member_invites.email above).
ALTER TABLE "__lattice_shared_schema" ADD COLUMN IF NOT EXISTS "computed_json" TEXT;

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

-- Delete-event visibility, decided from the PRE-DELETE snapshot the delete trigger
-- captures (the live row + its ownership record are gone after a delete, so
-- lattice_row_visible can't be used). Keyed on session_user, SECURITY DEFINER —
-- the same per-recipient gate. MUST MIRROR lattice_row_visible's rule: the row is
-- visible iff this member owned it, OR it was 'everyone', OR it was 'custom' and
-- this member was a grantee. A NULL owner snapshot (a legacy delete emitted before
-- the snapshot columns, or a row with no ownership record) yields false — fail
-- closed, never forward. (tests/integration assert this agrees with
-- lattice_row_visible for all three visibility states — the no-drift guard.)
CREATE OR REPLACE FUNCTION lattice_delete_visible(
  p_owner_role text, p_visibility text, p_grantees text[]
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT p_owner_role IS NOT NULL AND (
       p_owner_role = session_user
    OR p_visibility = 'everyone'
    OR (p_visibility = 'custom' AND session_user = ANY(COALESCE(p_grantees, ARRAY[]::text[])))
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

-- Pre-delete visibility snapshot columns (added to existing clouds via ADD COLUMN
-- IF NOT EXISTS). A delete event carries the row's visibility AT DELETE TIME so the
-- live fan-out can gate it per recipient even though the ownership record is gone.
-- NULL on upserts.
ALTER TABLE "__lattice_changes" ADD COLUMN IF NOT EXISTS "del_owner_role" text;
ALTER TABLE "__lattice_changes" ADD COLUMN IF NOT EXISTS "del_visibility" text;
ALTER TABLE "__lattice_changes" ADD COLUMN IF NOT EXISTS "del_grantees"   text[];

CREATE OR REPLACE FUNCTION lattice_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('lattice_changes', json_build_object(
    'seq', NEW."seq",
    'table_name', NEW."table_name",
    'pk', NEW."pk",
    'op', NEW."op",
    'owner_role', NEW."owner_role",
    'created_at', NEW."created_at",
    'del_owner_role', NEW."del_owner_role",
    'del_visibility', NEW."del_visibility",
    'del_grantees', NEW."del_grantees"
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

-- Add a column to a user table AS THE OWNER, on behalf of a scoped member. A
-- member's role has no CREATE/ALTER on the schema (the bootstrap REVOKEs CREATE
-- from PUBLIC), so a member's GUI "add a field" write (createRow/updateRow with a
-- field the table lacks) cannot run ALTER TABLE itself. This SECURITY DEFINER
-- helper performs that ALTER — and the masking-view regen — with the owner's
-- rights, so member-added columns behave identically to owner-added ones.
--
-- Injection-safe + minimal: p_table must be an existing BASE table in the current
-- schema (rejected otherwise); p_type is whitelisted against the exact set the
-- library's addColumn emits for an auto-added column (TEXT / INTEGER / REAL, plus
-- BOOLEAN) — never interpolated raw; both identifiers go through %I (quote_ident).
-- Member-callable (granted EXECUTE to the member group), but it can only widen the
-- schema, never read or alter another member's data.
CREATE OR REPLACE FUNCTION lattice_member_add_column(p_table text, p_column text, p_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_type      text;
  v_view      text := p_table || '_v';
  v_has_view  boolean;
  v_pk_expr   text;
  v_select    text;
BEGIN
  -- Never alter internal bookkeeping tables (names start with "_"). The GUI only
  -- ever calls this for a user entity table; rejecting the rest is defense-in-depth
  -- against a member invoking the function directly against ownership/audit/policy
  -- tables.
  IF left(p_table, 1) = '_' THEN
    RAISE EXCEPTION 'lattice: cannot add a column to internal table "%"', p_table;
  END IF;

  -- p_table must be a real base table in THIS schema (search_path is pinned to the
  -- cloud schema by pinDefinerSearchPath, so to_regclass resolves there).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = p_table AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'lattice: no such table "%"', p_table;
  END IF;

  -- Whitelist the column type. These are exactly the specs addColumn's
  -- inferColumnType produces (TEXT / INTEGER / REAL); BOOLEAN is allowed too.
  -- Anything else is rejected — the type is spliced as %s (NOT %I), so it must be
  -- a known-safe literal and never caller-controlled SQL.
  v_type := upper(btrim(p_type));
  IF v_type NOT IN ('TEXT', 'INTEGER', 'REAL', 'BOOLEAN') THEN
    RAISE EXCEPTION 'lattice: unsupported column type "%"', p_type;
  END IF;

  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I %s', p_table, p_column, v_type);

  -- If the table is cell-masked (a "<table>_v" view exists, because some column has
  -- an audience), the view selects an explicit column list — so a new column is
  -- invisible to members until the view is regenerated. Rebuild it the same way the
  -- owner path (audienceViewSql / regenerateAudienceViewFromDb) does: pass every
  -- column through except those with an 'owner' audience in __lattice_column_policy
  -- (CASE WHEN lattice_is_owner(...) THEN col END), re-apply row visibility with
  -- WHERE lattice_row_visible(table, pk), and keep the member SELECT grant on the
  -- view. Unmasked tables need no regen — the member group's table-level base grant
  -- already covers the new column.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = v_view AND c.relkind = 'v'
  ) INTO v_has_view;

  IF v_has_view THEN
    -- Canonical pk expression: CAST("col" AS TEXT) joined by TAB (chr(9)) — the
    -- same serialization the RLS policies + audienceViewSql use.
    SELECT string_agg(format('CAST(%I AS TEXT)', a.attname), ' || chr(9) || '
                      ORDER BY array_position(i.indkey, a.attnum))
      INTO v_pk_expr
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = current_schema() AND c.relname = p_table AND i.indisprimary;
    IF v_pk_expr IS NULL THEN
      RAISE EXCEPTION 'lattice: cannot regenerate mask view for "%": no primary key', p_table;
    END IF;

    -- Build the masked SELECT list in column order, applying the per-column policy.
    SELECT string_agg(
             CASE
               WHEN cp."audience" = 'owner'
                 THEN format('CASE WHEN lattice_is_owner(%L, %s) THEN %I END AS %I',
                             p_table, v_pk_expr, cols.column_name, cols.column_name)
               ELSE format('%I', cols.column_name)
             END,
             ', ' ORDER BY cols.ordinal_position)
      INTO v_select
      FROM information_schema.columns cols
      LEFT JOIN "__lattice_column_policy" cp
        ON cp."table_name" = p_table AND cp."column_name" = cols.column_name
       AND cp."audience" NOT IN ('', 'everyone', 'row-audience')
     WHERE cols.table_schema = current_schema() AND cols.table_name = p_table;

    EXECUTE format(
      'CREATE OR REPLACE VIEW %I AS SELECT %s FROM %I WHERE lattice_row_visible(%L, %s)',
      v_view, v_select, p_table, p_table, v_pk_expr);
    EXECUTE format('GRANT SELECT ON %I TO ${group}', v_view);
  END IF;
END $fn$;
GRANT EXECUTE ON FUNCTION lattice_member_add_column(text, text, text) TO ${group};

-- Member-safe semantic-search source. A member has NO grant on the internal
-- embeddings store (\`_lattice_embeddings\`) or the per-table vector index, so it
-- reads ONLY the chunk vectors for rows it may see, through these SECURITY DEFINER
-- functions — filtered by lattice_row_visible (keyed on session_user, the member).
-- Scoring happens in the app; these gate row visibility only. \`p_table\` is matched
-- as a VALUE against the table_name column — no dynamic SQL / identifier
-- interpolation. plpgsql (not sql) so they install even before \`_lattice_embeddings\`
-- exists: the body binds the table at call time, by which point a searchable cloud
-- has it. lattice_row_visible runs as this definer (owner) but still keys on the
-- caller's session_user, so a member can never read another member's vectors.
CREATE OR REPLACE FUNCTION lattice_visible_embeddings(p_table text)
RETURNS TABLE(row_pk text, chunk_index int, content text, embedding text, vec_dim int)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $fn$
BEGIN
  RETURN QUERY
    SELECT e."row_pk", e."chunk_index", e."content", e."embedding", e."vec_dim"
      FROM "_lattice_embeddings" e
     WHERE e."table_name" = p_table
       AND lattice_row_visible(p_table, e."row_pk");
END $fn$;
GRANT EXECUTE ON FUNCTION lattice_visible_embeddings(text) TO ${group};

CREATE OR REPLACE FUNCTION lattice_visible_embedding_count(p_table text)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER AS $fn$
DECLARE v_n bigint;
BEGIN
  SELECT count(*)::bigint INTO v_n
    FROM "_lattice_embeddings" e
   WHERE e."table_name" = p_table
     AND lattice_row_visible(p_table, e."row_pk");
  RETURN v_n;
END $fn$;
GRANT EXECUTE ON FUNCTION lattice_visible_embedding_count(text) TO ${group};
`;
}

/**
 * Per-table RLS setup: a dedicated ownership trigger (pk baked in so it matches the
 * policy's pk exactly), `ENABLE` + `FORCE ROW LEVEL SECURITY`, and the SELECT /
 * UPDATE / DELETE / INSERT policies. Idempotent (`CREATE OR REPLACE`, `DROP … IF
 * EXISTS`). `pkCols` is the table's primary-key column list (`Lattice` resolves it
 * via its pk utilities); throws for an unkeyable table.
 */
export function tableRlsSql(table: string, pkCols: readonly string[], group: string): string {
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
    -- Snapshot the row's visibility BEFORE the cascade removes its ownership +
    -- grant records, so the realtime fan-out can gate the delete event per
    -- recipient (the live predicate can't — these records are gone post-delete).
    -- The grantee list is captured here because the grant rows are deleted in the
    -- same statement below; after that the 'custom' audience is unrecoverable.
    INSERT INTO "__lattice_changes"
      ("table_name","pk","op","owner_role","del_owner_role","del_visibility","del_grantees")
      VALUES (${lit}, ${pkOld}, 'delete', session_user,
        (SELECT o."owner_role" FROM "__lattice_owners" o
           WHERE o."table_name" = ${lit} AND o."pk" = ${pkOld}),
        (SELECT o."visibility" FROM "__lattice_owners" o
           WHERE o."table_name" = ${lit} AND o."pk" = ${pkOld}),
        COALESCE((SELECT array_agg(g."grantee_role") FROM "__lattice_row_grants" g
           WHERE g."table_name" = ${lit} AND g."pk" = ${pkOld}), ARRAY[]::text[]));
    DELETE FROM "__lattice_owners"     WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    DELETE FROM "__lattice_row_grants" WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    RETURN OLD;
  END IF;
  RETURN NEW;
END $fn$;

ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${q} FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO ${group};

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
  const group = await memberGroupFor(db);
  // Every polyfill function — including the 4.3.3 additions (the shared strftime
  // formatter + the 3-arg strftime overload) — must be group-owned, never owned by a
  // single role. If only the 2-arg strftime were group-owned, a member that replaced
  // it could end up referencing an owner-only helper it can't (re)create. Keeping the
  // whole set group-owned keeps replacement symmetric.
  for (const sig of [
    'json_extract(text, text)',
    'strftime(text, text)',
    'strftime(text, text, text)',
    '__lattice_strftime_fmt(timestamptz, text)',
  ]) {
    try {
      const reg = await getAsyncOrSync(db.adapter, `SELECT to_regprocedure($1) AS reg`, [sig]);
      if (reg?.reg == null) continue; // not created yet — nothing to reassign
      await runAsyncOrSync(db.adapter, `ALTER FUNCTION ${sig} OWNER TO "${group}"`);
    } catch {
      // best-effort hygiene — the create-if-absent guard is the actual fix
    }
  }
}

/**
 * Scope the GUI audit log (`_lattice_gui_audit`) by ROW VISIBILITY. The log powers
 * undo/redo + the version-history page and is granted to members, but its
 * `before_json` / `after_json` carry the RAW row data of every mutation — every
 * column in cleartext, including ones a member can't otherwise see. With only a
 * member GRANT and no RLS, a member's version-history read returned EVERY member's
 * edits, leaking that raw data (the same hazard the changelog policy guards).
 *
 * Visibility model (confirmed with the product owner): a member sees an audit entry
 * for a row IFF they can currently SEE that row — `lattice_row_visible(table_name,
 * row_id)` (shared/owned/everyone). This is NOT author-scoped (a member sees edits
 * to a row they can see, even ones another member made) and NOT all-rows. Schema-
 * level entries — `row_id IS NULL`, e.g. a table create/rename — carry no row data,
 * so they are visible to all members. The cloud owner (a BYPASSRLS role) still sees
 * the whole history. Idempotent → converges on every owner open. No-op off Postgres
 * or when the table doesn't exist yet.
 *
 * KNOWN LIMITATION: for a SHARED row that has owner-only / secret columns, the
 * before/after JSON is NOT column-masked, so a member the row is shared with could
 * read those columns' values out of the history. A follow-up (column-masking the
 * audit JSON to match the row's `<table>_v` mask view) is needed to close that gap.
 * This is still strictly more private than the previous no-RLS state, which exposed
 * every row's raw history to every member regardless of visibility.
 */
export async function enableGuiAuditRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  const reg = await getAsyncOrSync(db.adapter, `SELECT to_regclass($1) AS reg`, [
    '_lattice_gui_audit',
  ]);
  if (reg?.reg == null) return;
  await runCloudBootstrapSql(
    db,
    `
ALTER TABLE "_lattice_gui_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_lattice_gui_audit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lattice_gui_audit_owner" ON "_lattice_gui_audit";
DROP POLICY IF EXISTS "lattice_gui_audit_sel" ON "_lattice_gui_audit";
CREATE POLICY "lattice_gui_audit_sel" ON "_lattice_gui_audit" FOR SELECT
  USING ("row_id" IS NULL OR lattice_row_visible("table_name", "row_id"));
DROP POLICY IF EXISTS "lattice_gui_audit_ins" ON "_lattice_gui_audit";
CREATE POLICY "lattice_gui_audit_ins" ON "_lattice_gui_audit" FOR INSERT
  WITH CHECK ("row_id" IS NULL OR lattice_row_visible("table_name", "row_id"));
DROP POLICY IF EXISTS "lattice_gui_audit_upd" ON "_lattice_gui_audit";
CREATE POLICY "lattice_gui_audit_upd" ON "_lattice_gui_audit" FOR UPDATE
  USING ("row_id" IS NULL OR lattice_row_visible("table_name", "row_id"));
DROP POLICY IF EXISTS "lattice_gui_audit_del" ON "_lattice_gui_audit";
CREATE POLICY "lattice_gui_audit_del" ON "_lattice_gui_audit" FOR DELETE
  USING ("row_id" IS NULL OR lattice_row_visible("table_name", "row_id"));
`,
  );
}

/** Install the cloud RLS bootstrap (bookkeeping + helper functions). No-op on SQLite. */
export async function installCloudRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  const schema = await cloudSchema(db);
  const group = await memberGroupFor(db);
  // Run the bootstrap DIRECTLY — NOT via a version-gated migration. Every object
  // here is CREATE … IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS +
  // CREATE POLICY / REVOKE, so re-running is cheap and, crucially, CONVERGES.
  // A version gate (once a version is recorded it never re-runs) meant objects
  // ADDED to the bootstrap in a later release — e.g. __lattice_member_invites —
  // never reached clouds already stamped at that version, and `secure` no-op'd.
  // Running it directly on every owner open (see openConfig) closes that gap.
  const sql =
    pinDefinerSearchPath(cloudRlsBootstrapSql(group), schema) + revokeSchemaCreateSql(schema);
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
  const group = await memberGroupFor(db);
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
GRANT SELECT, INSERT ON "__lattice_changelog" TO ${group};

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
 * Defense-in-depth lock on the lineage substrate (`__lattice_lineage`). It records
 * source→object edges (source ids/detail a non-owner shouldn't be able to
 * enumerate). Today it is merely UNGRANTED to members; this ENABLEs + FORCEs RLS
 * with NO member policy/grant, so even a future accidental `GRANT` can't leak
 * cross-member lineage — RLS-with-no-policy denies every non-BYPASSRLS role while
 * the owner's BYPASSRLS connection (where the provenance builder runs) is
 * unaffected. Ensures the table exists first so the lock applies even before the
 * first import creates it. Idempotent; converges on every owner open. No-op off PG.
 */
export async function enableLineageRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  await ensureLineageTable(db.adapter);
  await runCloudBootstrapSql(
    db,
    `
ALTER TABLE "${LINEAGE_TABLE}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${LINEAGE_TABLE}" FORCE ROW LEVEL SECURITY;
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
  const group = await memberGroupFor(db);
  const migration: Migration = {
    version: `internal:cloud-rls:table:${table}:v3`,
    sql: pinDefinerSearchPath(tableRlsSql(table, pkCols, group), schema),
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
