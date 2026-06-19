/**
 * Deterministic permission decision for the `set_visibility` tool: returns a
 * human-readable refusal reason, or `null` when the caller may proceed. Mirrors —
 * does not replace — the owner-only enforcement in the Postgres RLS functions
 * (`lattice_set_row_visibility` / `lattice_set_table_default_visibility`), so the
 * assistant gets an explicit error to relay instead of reporting a sharing change
 * it never had permission to make. Pure + exported so the decision is unit-tested
 * without a live cloud.
 *
 * - Row-level (`kind: 'row'`): pass the caller's RowAccess for that row. Absent ⇒
 *   not visible/found; not owned ⇒ refused (only a row's owner may re-share it).
 * - Table default (`kind: 'table'`): pass whether the caller can manage roles
 *   (owner / DBA).
 */
export function visibilityDenialReason(
  opts:
    | { kind: 'row'; rowAccess: { ownedByMe: boolean } | undefined }
    | { kind: 'table'; canManageTableDefault: boolean },
): string | null {
  if (opts.kind === 'table') {
    return opts.canManageTableDefault
      ? null
      : "Only the workspace owner can change a table's default sharing.";
  }
  if (!opts.rowAccess) return 'That record was not found, or is not visible to you.';
  if (!opts.rowAccess.ownedByMe) {
    return 'You do not own this record, so you cannot change its sharing — only its owner can.';
  }
  return null;
}
