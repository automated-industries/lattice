/**
 * The single declarative source of truth for what a cloud MEMBER may access.
 *
 * Every "the member's GUI degraded because we forgot to grant table/function X"
 * regression (3.3.2 → 3.3.4) came from member access being hand-enumerated across
 * ~12 GRANT sites with no registry and no test. This module centralizes it: the
 * bootstrap/reconcile derive their grants from these lists, and a registry-driven
 * test asserts every readable object IS granted and every owner-only object is
 * NOT — so the omission class becomes structurally impossible.
 */

export interface MemberReadableEntry {
  /** Bookkeeping table name. */
  name: string;
  /** Privileges granted to the member group, e.g. 'SELECT, INSERT, UPDATE'. */
  privs: string;
  /** Why a member needs it (documentation; surfaced in review). */
  why: string;
}

/**
 * Bookkeeping tables a member reads/writes DIRECTLY (granted to the member group),
 * because they aren't reached through an RLS-secured user table. Without these the
 * member's GUI silently degrades to read-only / "save as document".
 */
export const MEMBER_READABLE_BOOKKEEPING: readonly MemberReadableEntry[] = [
  {
    name: '_lattice_gui_meta',
    privs: 'SELECT, INSERT, UPDATE',
    why: 'entity-icon + table/column descriptions (workspace metadata the member reads + may author)',
  },
  {
    name: '_lattice_gui_column_meta',
    privs: 'SELECT, INSERT, UPDATE',
    why: 'per-column descriptions',
  },
  {
    name: '_lattice_gui_audit',
    // UPDATE + DELETE are needed by undo/redo/revert (flips an entry's `undone`)
    // and the redo-stack purge on a new mutation (deletes the session's undone
    // entries). Safe because enableGuiAuditRls installs per-op UPDATE and DELETE
    // policies whose USING is `row_id IS NULL OR lattice_row_visible(table_name,
    // row_id)` — so a member can only update/delete audit rows for entities it can
    // already see (or schema-level entries that carry no row data).
    privs: 'SELECT, INSERT, UPDATE, DELETE',
    why: 'GUI undo/redo/revert + redo-stack purge + version history; RLS (enableGuiAuditRls) scopes every op to entries whose underlying row the member can see',
  },
  {
    name: '__lattice_user_identity',
    privs: 'SELECT, INSERT, UPDATE',
    why: 'the "who is here" identity row mirrored on connect',
  },
  {
    name: '__lattice_changelog',
    privs: 'SELECT, INSERT',
    why: 'per-viewer-RLS-filtered change history for observe()/history (the policy filters reads, so the base grant is safe)',
  },
  {
    name: '__lattice_shared_schema',
    privs: 'SELECT',
    why: 'owner-published entity/render layout (entities + entityContexts) a joined member hydrates its config from so render produces the full context tree',
  },
];

/**
 * Owner-only bookkeeping — the assert-NOT-granted list the security guard reads. A
 * direct member grant on any of these would leak another member's row existence /
 * ownership / sharing graph / identity; members reach them ONLY through
 * `SECURITY DEFINER` functions keyed on `session_user`.
 *
 * `__lattice_member_roles` / `__lattice_cell_grants` are no longer created on new
 * clouds (the per-cell/role machinery was removed) but stay listed so the guard
 * still covers legacy clouds that still have them.
 */
export const OWNER_ONLY_BOOKKEEPING: readonly string[] = [
  '__lattice_owners',
  '__lattice_row_grants',
  '__lattice_table_policy',
  '__lattice_column_policy',
  '__lattice_member_invites',
  '__lattice_cloud_settings',
  '__lattice_changes',
  '__lattice_member_roles',
  '__lattice_cell_grants',
];

/**
 * SQLite-compat polyfills a member's queries depend on (the audit-table
 * `strftime()` default, audience `json_extract()`). NOT the `SECURITY DEFINER`
 * RLS helpers — those rely on the default PUBLIC EXECUTE and must not be touched.
 */
export const MEMBER_EXECUTE_FUNCTIONS: readonly string[] = [
  'json_extract(text, text)',
  'strftime(text, text)',
];

function quoteIdent(table: string): string {
  return `"${table.replace(/"/g, '""')}"`;
}

/**
 * The ONE place that emits a user-table member grant — and, as of 5.5, it has ONE
 * branch.
 *
 * A member reads through `<t>_v` and writes to the base. Table-level SELECT on the
 * base is never granted to a member, for any table, under any condition.
 *
 * There used to be a second branch: "this table isn't masked, so grant members
 * SELECT on the base." It decided masked-ness by looking the column policy up BY
 * NAME, and a policy stranded by a rename reads back empty — indistinguishable
 * from "nothing is masked here". So the branch handed members raw SELECT on a
 * table whose columns the owner had marked secret. Every masking leak we have had
 * came out of that one statement, and it was patched three times, path by path,
 * while the branch itself stayed. Removing the branch is what makes the class of
 * bug unreachable rather than fixed-again: with no unmasked path, a wrong or
 * stranded policy can at worst leave a STALE VIEW — visibly wrong, never cleartext.
 *
 * The `masked` flag is accepted and ignored, so existing callers keep compiling;
 * it no longer selects anything.
 */
export function grantMemberTableAccessSql(
  table: string,
  _opts: { masked?: boolean } | undefined,
  group: string,
): string[] {
  const q = quoteIdent(table);
  const v = `${table}_v`.replace(/'/g, "''");
  return [
    `GRANT INSERT, UPDATE, DELETE ON ${q} TO ${group}`,
    // Unconditional, and the whole point of the change.
    `REVOKE SELECT ON ${q} FROM ${group}`,
    // ...which would make the table read-only for members without this (Postgres
    // needs SELECT on the columns an UPDATE/DELETE names in its WHERE clause).
    dmlKeyGrantSql(table, group),
    // Guarded: reconcile runs against clouds whose views don't exist yet (every
    // pre-5.5 workspace), and it is the same pass that builds them. A missing view
    // must not abort the table's grants — the read simply arrives once the view does.
    `DO $LATTICE_VGRANT$ BEGIN
       IF to_regclass('${v}') IS NOT NULL THEN
         EXECUTE 'GRANT SELECT ON ${quoteIdent(`${table}_v`)} TO ${group}';
       END IF;
     END $LATTICE_VGRANT$`,
  ];
}

/**
 * Column-level `SELECT` on the few columns a member's own WRITES have to name.
 *
 * Revoking base `SELECT` is what keeps a masked column unreadable — but Postgres
 * also requires `SELECT` on every column an `UPDATE`/`DELETE` mentions in its
 * `WHERE` clause. So `UPDATE "notes" SET "body" = ? WHERE "id" = ?` was
 * `permission denied for table notes` for a member: it never reached the UPDATE,
 * it failed on reading its own key. A member could read a masked table and not
 * edit it, and no test caught that because the masked-table tests asserted
 * privilege BITS and never performed a real member write.
 *
 * The allowlist is derived from `pg_index` plus one fixed literal — deliberately
 * NEVER from `__lattice_column_policy`. That is the whole point: a policy that is
 * missing, stale, or stranded under an old name cannot widen this set, so the one
 * failure mode that produced every masking leak has no path in here. Row filtering
 * is untouched — the base table still has FORCE ROW LEVEL SECURITY, so even these
 * columns are row-scoped.
 *
 * Table-level `has_table_privilege(..., 'SELECT')` stays FALSE under column-only
 * grants, so the "a member holds SELECT on zero base tables" invariant is exactly
 * as strong as it reads.
 *
 * Emitted as an anonymous `DO` block so it stays parameterless and can ride the
 * same batched round-trip as the other grants (see {@link grantMemberTableAccessBatchSql}).
 */
export function dmlKeyGrantSql(table: string, group: string): string {
  const lit = `'${table.replace(/'/g, "''")}'`;
  return `DO $LATTICE_DMLKEY$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT a.attname FROM pg_index i
      JOIN pg_class t     ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = current_schema() AND t.relname = ${lit} AND i.indisprimary
    UNION
    SELECT 'deleted_at' WHERE EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ${lit} AND column_name = 'deleted_at')
  LOOP
    EXECUTE format('GRANT SELECT (%I) ON %I TO ${group}', c, ${lit});
  END LOOP;
END $LATTICE_DMLKEY$`;
}

/**
 * The {@link grantMemberTableAccessSql} statements for a table joined into a single
 * multi-statement string, so the reconcile loop can grant a table in ONE round-trip
 * instead of one per statement (a masked table needs 2). Safe because these GRANTs
 * bind no parameters: the Postgres adapter's param walker leaves them verbatim, and
 * pg's simple-query protocol (selected when no values are bound) executes
 * semicolon-separated statements in a single query.
 *
 * LOAD-BEARING: this relies on the GRANT SQL containing NO `?` placeholder. If a
 * placeholder is ever introduced into {@link grantMemberTableAccessSql}, pg would
 * switch to the extended protocol, which REJECTS multiple statements per query and
 * would silently break every masked table's batch — keep the GRANT SQL parameterless.
 */
export function grantMemberTableAccessBatchSql(
  table: string,
  opts: { masked?: boolean } | undefined,
  group: string,
): string {
  return grantMemberTableAccessSql(table, opts, group).join('; ');
}

/**
 * `to_regclass`-guarded GRANT for each member-readable bookkeeping table, so a
 * library-only cloud (no GUI tables) is a no-op and an already-migrated cloud
 * self-heals on the owner's next open. Idempotent.
 */
export function grantMemberBookkeepingSql(group: string): string[] {
  return MEMBER_READABLE_BOOKKEEPING.map(
    (e) =>
      `DO $LATTICE$ BEGIN
         IF to_regclass('${e.name}') IS NOT NULL THEN
           EXECUTE 'GRANT ${e.privs} ON "${e.name}" TO ${group}';
         END IF;
       END $LATTICE$`,
  );
}

/** GRANT EXECUTE on the member-needed SQLite-compat polyfills. */
export function grantMemberExecuteSql(group: string): string {
  return `GRANT EXECUTE ON FUNCTION ${MEMBER_EXECUTE_FUNCTIONS.join(', ')} TO ${group}`;
}
