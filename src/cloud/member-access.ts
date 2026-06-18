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
import { MEMBER_GROUP } from './rls.js';

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
    privs: 'SELECT, INSERT',
    why: 'GUI undo/redo + version history; RLS (enableGuiAuditRls) scopes reads to entries whose underlying row the member can see',
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
 * The ONE place that emits a user-table member grant. `masked` ⇒ the member reads
 * the cell-masking view and keeps DML on the base (base SELECT stays revoked by
 * the audience-view SQL); otherwise full DML + SELECT on the base.
 */
export function grantMemberTableAccessSql(table: string, opts: { masked: boolean }): string[] {
  const q = quoteIdent(table);
  if (opts.masked) {
    const v = quoteIdent(`${table}_v`);
    return [
      `GRANT SELECT ON ${v} TO ${MEMBER_GROUP}`,
      `GRANT INSERT, UPDATE, DELETE ON ${q} TO ${MEMBER_GROUP}`,
    ];
  }
  return [`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO ${MEMBER_GROUP}`];
}

/**
 * `to_regclass`-guarded GRANT for each member-readable bookkeeping table, so a
 * library-only cloud (no GUI tables) is a no-op and an already-migrated cloud
 * self-heals on the owner's next open. Idempotent.
 */
export function grantMemberBookkeepingSql(): string[] {
  return MEMBER_READABLE_BOOKKEEPING.map(
    (e) =>
      `DO $LATTICE$ BEGIN
         IF to_regclass('${e.name}') IS NOT NULL THEN
           EXECUTE 'GRANT ${e.privs} ON "${e.name}" TO ${MEMBER_GROUP}';
         END IF;
       END $LATTICE$`,
  );
}

/** GRANT EXECUTE on the member-needed SQLite-compat polyfills. */
export function grantMemberExecuteSql(): string {
  return `GRANT EXECUTE ON FUNCTION ${MEMBER_EXECUTE_FUNCTIONS.join(', ')} TO ${MEMBER_GROUP}`;
}
