import type { Lattice } from '../lattice.js';
import type { Migration } from '../types.js';

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
function pkSqlExpr(pkCols: readonly string[], prefix: string): string {
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
export const CLOUD_RLS_BOOTSTRAP_SQL = `
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
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM "__lattice_owners"     WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    DELETE FROM "__lattice_row_grants" WHERE "table_name" = ${lit} AND "pk" = ${pkOld};
    RETURN OLD;
  END IF;
  RETURN NEW;
END $fn$;

ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${q} FORCE ROW LEVEL SECURITY;

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
CREATE TRIGGER "${trg}" AFTER INSERT OR DELETE ON ${q}
  FOR EACH ROW EXECUTE FUNCTION "${trg}"();
`;
}

/** Install the cloud RLS bootstrap (bookkeeping + helper functions). No-op on SQLite. */
export async function installCloudRls(db: Lattice): Promise<void> {
  if (!isPg(db)) return;
  const migration: Migration = {
    version: 'internal:cloud-rls:bootstrap:v1',
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
    version: `internal:cloud-rls:table:${table}:v1`,
    sql: tableRlsSql(table, pkCols),
  };
  await db.migrate([migration]);
}
