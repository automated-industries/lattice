import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';
import { runAsyncOrSync } from '../db/adapter.js';

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
 * NOTE (follow-up): the `SECURITY DEFINER` helpers below should pin `search_path`
 * to the cloud schema to fully close the definer-search_path class of issue. Today
 * members are `NOSUPERUSER` without CREATE on the schema, so they cannot plant a
 * shadowing object; the pin is hardening, tracked for the schema-awareness pass.
 */
/**
 * Group role every cloud member inherits. Table privileges are granted to the
 * group, so adding a shared table or a member is a single GRANT — while RLS still
 * filters rows per individual login role (`session_user`). The group grants
 * *access*, never *visibility*.
 */
export const MEMBER_GROUP = 'lattice_members';

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

-- App-role assignments for the audience layer: maps a member's login role to the
-- named app roles (e.g. 'hr') a fixed-policy column may require. Owner-managed;
-- members cannot read or write it (no grant), so a member can't self-promote.
CREATE TABLE IF NOT EXISTS "__lattice_member_roles" (
  "member_role" text NOT NULL,
  "app_role"    text NOT NULL,
  "granted_by"  text NOT NULL DEFAULT session_user,
  "granted_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("member_role", "app_role")
);

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

-- Owner-only: change a row's visibility. Raises if the caller is not the owner.
CREATE OR REPLACE FUNCTION lattice_set_row_visibility(p_table text, p_pk text, p_visibility text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_owner text;
BEGIN
  IF p_visibility NOT IN ('private','everyone','custom') THEN
    RAISE EXCEPTION 'lattice: invalid visibility %', p_visibility;
  END IF;
  SELECT o."owner_role" INTO v_owner FROM "__lattice_owners" o
    WHERE o."table_name" = p_table AND o."pk" = p_pk;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'lattice: no ownership record for %/%', p_table, p_pk; END IF;
  IF v_owner <> session_user THEN RAISE EXCEPTION 'lattice: only the row owner may change its sharing'; END IF;
  UPDATE "__lattice_owners" SET "visibility" = p_visibility, "updated_at" = now()
    WHERE "table_name" = p_table AND "pk" = p_pk;
END $fn$;

-- Owner-only: grant a specific member access to a row (sets visibility = 'custom').
CREATE OR REPLACE FUNCTION lattice_grant_row(p_table text, p_pk text, p_grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_owner text;
BEGIN
  SELECT o."owner_role" INTO v_owner FROM "__lattice_owners" o
    WHERE o."table_name" = p_table AND o."pk" = p_pk;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'lattice: no ownership record for %/%', p_table, p_pk; END IF;
  IF v_owner <> session_user THEN RAISE EXCEPTION 'lattice: only the row owner may grant access'; END IF;
  UPDATE "__lattice_owners" SET "visibility" = 'custom', "updated_at" = now()
    WHERE "table_name" = p_table AND "pk" = p_pk;
  INSERT INTO "__lattice_row_grants" ("table_name","pk","grantee_role","granted_by")
    VALUES (p_table, p_pk, p_grantee, session_user)
    ON CONFLICT ("table_name","pk","grantee_role") DO NOTHING;
END $fn$;

-- Owner-only: revoke a member's access to a row.
CREATE OR REPLACE FUNCTION lattice_revoke_row(p_table text, p_pk text, p_grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_owner text;
BEGIN
  SELECT o."owner_role" INTO v_owner FROM "__lattice_owners" o
    WHERE o."table_name" = p_table AND o."pk" = p_pk;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'lattice: no ownership record for %/%', p_table, p_pk; END IF;
  IF v_owner <> session_user THEN RAISE EXCEPTION 'lattice: only the row owner may revoke access'; END IF;
  DELETE FROM "__lattice_row_grants"
    WHERE "table_name" = p_table AND "pk" = p_pk AND "grantee_role" = p_grantee;
END $fn$;

-- ── Per-viewer audience helpers (Stage-0 scaffolding) ────────────────────────
-- The predicates a generated per-column cell-masking view will call. ALL are
-- SECURITY DEFINER and keyed on session_user (NEVER current_user / SECURITY
-- INVOKER) so they bind to the real member even when an owner-rights view
-- executes them — the identity invariant the whole cloud model depends on. They
-- are not referenced by any policy or view yet, so they change NO behavior in
-- Stage-0; a later stage wires them into generated views.

-- Is the connected member the subject of this row (e.g. their own person row)?
CREATE OR REPLACE FUNCTION lattice_is_subject(p_subject text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT p_subject = session_user
$fn$;

-- Does the connected member hold a named app role? Reads the owner-managed
-- member-roles table (which members can't see) keyed on session_user, so a
-- member cannot grant themselves a role to unmask a column.
CREATE OR REPLACE FUNCTION lattice_has_role(p_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "__lattice_member_roles"
     WHERE "member_role" = session_user AND "app_role" = p_role
  )
$fn$;

-- Owner-only: assign an app role to a member (so a fixed-policy masked column
-- becomes visible to them). Raises unless the caller can create roles (a cloud
-- owner / DBA).
CREATE OR REPLACE FUNCTION lattice_assign_role(p_member text, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may assign app roles';
  END IF;
  INSERT INTO "__lattice_member_roles" ("member_role", "app_role")
    VALUES (p_member, p_role) ON CONFLICT DO NOTHING;
END $fn$;

-- Owner-only: revoke an app role from a member.
CREATE OR REPLACE FUNCTION lattice_revoke_role(p_member text, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may revoke app roles';
  END IF;
  DELETE FROM "__lattice_member_roles"
    WHERE "member_role" = p_member AND "app_role" = p_role;
END $fn$;

-- Can the connected member see a source? Reduces to the source row's own RLS, so
-- file-sharing drives enrichment visibility for free. p_source_ref is the
-- source's primary key in the files table.
CREATE OR REPLACE FUNCTION lattice_source_visible(p_source_ref text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT lattice_row_visible('files', p_source_ref)
$fn$;

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
      VALUES (${lit}, ${pkNew}, session_user, 'private')
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

/** Install the cloud RLS bootstrap (bookkeeping + helper functions). No-op on SQLite. */
export async function installCloudRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  const migration: Migration = {
    // v3 added the audience helpers; v4 adds the role model (__lattice_member_roles
    // + real lattice_has_role / lattice_assign_role). The bootstrap is fully
    // idempotent (CREATE OR REPLACE / IF NOT EXISTS), so re-running is safe.
    version: 'internal:cloud-rls:bootstrap:v4',
    sql: CLOUD_RLS_BOOTSTRAP_SQL,
  };
  await db.migrate([migration]);
}

/** Enable RLS on one shared table. No-op on SQLite. Idempotent via a per-table version key. */
export async function enableRlsForTable(
  db: Lattice,
  table: string,
  pkCols: readonly string[],
): Promise<void> {
  if (!isPg(db)) return;
  const migration: Migration = {
    version: `internal:cloud-rls:table:${table}:v2`,
    sql: tableRlsSql(table, pkCols),
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
