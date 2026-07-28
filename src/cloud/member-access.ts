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
  /** Table-level privileges granted to the member group, e.g. 'SELECT, INSERT, UPDATE'. */
  privs: string;
  /**
   * Columns of this relation a member must NEVER hold `SELECT` on. When present,
   * table-level `SELECT` is REVOKED and re-granted column by column over every OTHER
   * column the table PHYSICALLY has.
   *
   * Stated as what is WITHHELD, and resolved against the catalog rather than against
   * a declared allowlist, because the column set of these relations genuinely varies:
   * `_lattice_gui_audit` gained `ts`, `session_id` and `source` across releases and
   * they are added idempotently by the schema reconcile, so a workspace can be
   * carrying any subset of them. An allowlist naming a column the table does not have
   * makes the whole GRANT raise (and with it the owner open), while an allowlist
   * missing one the table DOES have silently blinds members to it. The withheld set
   * is the part that is a security decision; the rest is whatever is there.
   *
   * A relation with this set MUST also declare {@link MemberReadableEntry.readView}:
   * the query layer emits `SELECT *`, so a member with column-only grants can no
   * longer read the relation at all without the view to read it through. The two are
   * one decision and are written as one entry for that reason.
   */
  withholdColumns?: readonly string[];
  /**
   * The relation a member READS this table through — a mask view over it. Granted
   * SELECT alongside, and picked up automatically as this connection's read relation
   * (the `<t>_v` naming is what `Lattice` routes member reads on).
   */
  readView?: string;
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
    //
    // TABLE-LEVEL SELECT IS DELIBERATELY ABSENT.
    //
    // `before_json` / `after_json` are whole row IMAGES — every column of the
    // recorded row in cleartext, owner-masked ones included, written by whichever
    // connection made the change (the owner's writes carry the unmasked values).
    // Row visibility is the wrong gate for that: an audit entry for a row a member
    // may legitimately see still carries the columns the mask exists to hide. A
    // member ran a plain `SELECT before_json FROM _lattice_gui_audit` and read them.
    //
    // Serve-time masking (maskAuditImagesForViewer) covers the GUI's own history
    // responses, but a member holds a direct Postgres session — a serve-time mask
    // cannot reach a query the member issues itself. So the GRANT is narrowed to the
    // metadata columns and the images move behind `_lattice_gui_audit_v`, which
    // applies the SAME session_user-keyed predicate the `<t>_v` masks compile to.
    privs: 'INSERT, UPDATE, DELETE',
    withholdColumns: ['before_json', 'after_json'],
    readView: '_lattice_gui_audit_v',
    why: 'GUI undo/redo/revert + redo-stack purge + version history; RLS (enableGuiAuditRls) scopes every op to entries whose underlying row the member can see, and the row images are read through the mask view rather than off the base',
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
 *
 * This list is EXHAUSTIVE over internal bookkeeping, not a list of the ones someone
 * happened to worry about — see {@link classifyCloudRelation}. Every entry below was
 * measured to hold no member privilege on a real secured cloud, so declaring it here
 * pins the status quo rather than describing an intention.
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
  // The sharing graph. Its own source comment already claimed "members have no
  // direct grant on these bookkeeping tables (the SECURITY DEFINER functions are
  // the path)" — an invariant asserted in a comment with nothing enforcing it.
  '__lattice_table_shares',
  '__lattice_table_share_grants',
  // The embeddings store. `content` is a VERBATIM copy of the base row's text for
  // every embedded field, masked columns included — the same cleartext the FTS
  // index holds, in a table whose name does not carry the `__lattice_fts_` prefix.
  // A grant here is a complete read-around of every column mask on every table.
  '_lattice_embeddings',
  // Derived-accelerator registry for the per-table vector index (`_lattice_vec_*`).
  // Its own source comment claims it is "never granted to cloud members"; this is
  // the line that makes that true rather than aspirational.
  '__lattice_vector_index',
  // Schema/lineage/migration ledgers: they enumerate table + column names (and, for
  // lineage, where a value came from) across the whole workspace, including tables a
  // member cannot see a single row of.
  '__lattice_lineage',
  '__lattice_migrations',
  '__lattice_migrations_v1',
  '__lattice_migration_checkpoints',
  '__lattice_native_entities',
  '__lattice_edges',
  // Connector registry: which external accounts are wired up, and by whom.
  // `lattice_member_claim_ownerless` reads it through a SECURITY DEFINER function
  // precisely because a member holds nothing on it.
  '__lattice_connectors',
  // AI/computed bookkeeping. `__lattice_ai_cell` caches per-cell model output —
  // i.e. values DERIVED from base-table cleartext, which is exactly the shape of
  // leak the embeddings store turned out to be.
  '__lattice_ai_map',
  '__lattice_ai_cell',
  // No longer created (the assistant-side destructive-consent store was removed), but
  // still listed: a workspace that ran a build which DID create it must not have the
  // table quietly become member-readable because nothing writes to it any more.
  '__lattice_ai_consent',
  '__lattice_computed_state',
  '__lattice_plan_state',
  '__lattice_questions',
  // Presigning secret for cloud file storage.
  '__lattice_cloud_s3_secret',
  // Benchmark scratch + the SQLite writeback state store. Neither is created on a
  // Postgres cloud today; listed so that changing that does not silently produce an
  // unclassified relation.
  '_lattice_bench',
  '_lattice_writeback_offset',
  '_lattice_writeback_seen',
];

/**
 * Owner-only bookkeeping whose names are PER-TABLE, so they cannot be listed
 * literally. Same rule as {@link OWNER_ONLY_BOOKKEEPING}, matched by prefix.
 *
 * `__lattice_fts_<table>` is the full-text index, and it is the reason this concept
 * exists. It was in NEITHER list — not declared readable, not declared owner-only —
 * so it sat outside the guard entirely, holding only because no code happens to grant
 * it. That is a property of today's call sites, not a rule, and the thing it guards is
 * not small: the index stores base-table CLEARTEXT (its trigger builds `body` by
 * concatenating the row's own columns, masked ones included), and the indexed search
 * branch matches on `f.tsv` and returns `ts_headline` snippets over `f.body`. One
 * careless GRANT and a member reads, in snippet form, every column the mask exists to
 * hide — through a path the `<t>_v` view is not even in.
 *
 * Declaring it here is what turns "nothing grants it" into "granting it fails a test".
 *
 * `_lattice_vec_<table>` is the SECOND per-table family, and it was missing from
 * this list while the concept it needs already existed. It is the native vector
 * index, and its `content` column is a verbatim copy of the same unmasked
 * embeddings text — so a table-name-shaped hole in the rule covers exactly the same
 * cleartext the FTS prefix was added to protect.
 */
export const OWNER_ONLY_BOOKKEEPING_PREFIXES: readonly string[] = [
  '__lattice_fts_',
  '_lattice_vec_',
];

/**
 * True when `name` is bookkeeping a member must never hold a direct grant on —
 * by exact name or by prefix. The one predicate every owner-only check should use,
 * so a per-table family cannot fall out of the rule the way the FTS index did.
 */
export function isOwnerOnlyBookkeeping(name: string): boolean {
  return (
    OWNER_ONLY_BOOKKEEPING.includes(name) ||
    OWNER_ONLY_BOOKKEEPING_PREFIXES.some((p) => name.startsWith(p))
  );
}

/** True when `name` is a member-readable bookkeeping table (exact name). */
export function isMemberReadableBookkeeping(name: string): boolean {
  return MEMBER_READABLE_BOOKKEEPING.some((e) => e.name === name);
}

/**
 * The prefixes that make a relation name INTERNAL to the cloud machinery — i.e. the
 * namespace the classifier is required to have an answer for.
 *
 * This is the rule the cloud layer actually applies, not an approximation of it:
 * `reconcileCloudMemberAccess` and `secureNewCloudTable` both skip exactly
 * `__lattice_` / `_lattice_`, and every relation they skip is bookkeeping. The
 * classifier used to test a bare leading underscore instead, which is a DIFFERENT
 * rule and a strictly wider one — so a user table named `_foo` came back
 * `unclassified` and failed the guard, even though the cloud layer had secured it,
 * masked it and granted it exactly like any other user entity. A guard that reports a
 * correctly-secured table as a registry hole is a guard someone eventually weakens.
 *
 * The plpgsql member helpers (`lattice_member_add_column`,
 * `lattice_member_claim_ownerless`) refuse any name with a leading underscore. That
 * is a STRICTER rule and it is left alone deliberately — widening it to match this
 * one would hand members a path into `_foo`-shaped tables they do not have today,
 * which is a permission change, not a classification fix.
 */
export const CLOUD_INTERNAL_PREFIXES: readonly string[] = ['__lattice_', '_lattice_'];

/** True when `name` is in the cloud's internal bookkeeping namespace. */
export function isCloudInternalRelation(name: string): boolean {
  return CLOUD_INTERNAL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * What a relation in a secured cloud schema IS, as far as member access is
 * concerned.
 *
 * `unclassified` and `contradictory` are the two answers that mean the registry has
 * a hole, and they exist because the previous guard could not produce either: it
 * walked every relation and then FILTERED through the owner-only list before
 * asserting, so a relation in NEITHER list was not "asserted safe" — it was simply
 * skipped. Five relations were in that state on a real secured cloud
 * (`_lattice_embeddings`, the two sharing-graph tables, `__lattice_lineage`,
 * `__lattice_migrations`), and granting the embeddings store to members would have
 * left that guard GREEN while a member read every masked column in clear.
 */
export type CloudRelationClass =
  | 'user'
  | 'member-readable'
  | 'owner-only'
  | 'unclassified'
  | 'contradictory';

/**
 * Classify a relation by name. Total by construction: internal bookkeeping that is
 * in neither registry comes back `unclassified` (and in both, `contradictory`), so
 * adding a bookkeeping table forces a deliberate classification instead of quietly
 * landing outside the rule.
 *
 * Internal-ness is decided by {@link isCloudInternalRelation} — the SAME
 * `__lattice_` / `_lattice_` prefix rule the cloud layer itself applies when it
 * decides which relations to secure, mask and grant. So a user table named `_foo`
 * classifies as `user`, which is what the cloud layer treats it as.
 */
export function classifyCloudRelation(name: string): CloudRelationClass {
  const readable = isMemberReadableBookkeeping(name);
  const owner = isOwnerOnlyBookkeeping(name);
  if (readable && owner) return 'contradictory';
  if (readable) return 'member-readable';
  if (owner) return 'owner-only';
  // A mask view holds no data of its own — it is a projection of the relation it is
  // named for, so it classifies WITH that relation. For a user entity that lands on
  // `user` via the prefix rule below anyway; for BOOKKEEPING it does not, and
  // `_lattice_gui_audit_v` (the member's read path onto the audit log) would
  // otherwise read as an unclassified internal relation.
  if (name.endsWith('_v')) {
    const base = name.slice(0, -2);
    if (isMemberReadableBookkeeping(base)) return 'member-readable';
    if (isOwnerOnlyBookkeeping(base)) return 'owner-only';
  }
  if (!isCloudInternalRelation(name)) return 'user';
  return 'unclassified';
}

/**
 * SQLite-compat polyfills a member's queries depend on (the audit-table
 * `strftime()` default, audience `json_extract()`). NOT the `SECURITY DEFINER`
 * RLS helpers — those rely on the default PUBLIC EXECUTE and must not be touched.
 */
export const MEMBER_EXECUTE_FUNCTIONS: readonly string[] = [
  'json_extract(text, text)',
  'strftime(text, text)',
];

// ── The FUNCTION surface ──────────────────────────────────────────────────────
//
// A `SECURITY DEFINER` function is exactly as powerful as a GRANT: it runs with the
// OWNER's rights over owner-only bookkeeping, and Postgres grants EXECUTE to PUBLIC
// by default — which this codebase relies on deliberately (see
// MEMBER_EXECUTE_FUNCTIONS above: "those rely on the default PUBLIC EXECUTE and must
// not be touched"). So EVERY definer function in a cloud schema is member-callable,
// and "which functions is the member group granted" is not a discriminator at all.
//
// That is why a privilege guard over RELATIONS cannot see this surface. It is how
// `lattice_visible_embeddings` returned owner-masked CLEARTEXT to a member while the
// base table was denied, the FTS index was denied, and the mask view returned NULL —
// every relation-level check green, the value in clear through a function.

/** A `SECURITY DEFINER` function in a secured cloud schema, and what it may return. */
export interface DefinerFunctionEntry {
  /** `pg_proc.proname`. */
  name: string;
  /** `pg_get_function_identity_arguments`, so an overload is classified separately. */
  args: string;
  /**
   * TRUE when the result can contain user-table COLUMN VALUES (not just table names,
   * pks, roles or flags), INCLUDING a value DERIVED from one. Every such function is
   * a potential read-around of the column masks, and the integration guard proves,
   * per entry, that a member calling it cannot recover a masked column's cleartext.
   *
   * "Derived" is load-bearing and was learned the expensive way twice.
   * `lattice_visible_embeddings` returns a chunk of concatenated row text;
   * `lattice_presign_file` returns a URL with the `files.ref_uri` object key spliced
   * into it. Neither reads as "returns a column" at a glance, and both handed a
   * member the exact cleartext the mask denies.
   */
  returnsRowData: boolean;
  /**
   * How this function treats the COLUMN mask — the second question the audit of this
   * surface has to answer for every entry, recorded here rather than in a review
   * comment nobody can grep.
   *
   *  - `no-row-data` — it returns no user-column value at all (a boolean, a count,
   *    a role name, a table name, a pk the caller supplied). Nothing to mask.
   *  - `applies` — it returns row-derived data AND gates that data on the same
   *    `session_user`-keyed predicate the generated `<t>_v` views compile to, so it
   *    agrees with the mask by construction rather than by consulting the policy.
   *
   * There is deliberately no third value. A function that returns row-derived data
   * under ROW visibility alone is the bug this field exists to make unsayable —
   * `returnsRowData` implies `applies`, asserted by the registry unit test.
   */
  columnMask: 'no-row-data' | 'applies';
  /** Why it exists / what it is for (documentation; surfaced in review). */
  why: string;
}

/**
 * Every `SECURITY DEFINER` function a secured cloud installs. Exhaustive: the guard
 * fails on one that is not listed here, so adding a definer function forces the
 * author to state whether it can hand back row data.
 */
export const CLOUD_DEFINER_FUNCTIONS: readonly DefinerFunctionEntry[] = [
  {
    name: 'lattice_visible_embeddings',
    args: 'p_table text',
    returnsRowData: true,
    columnMask: 'applies',
    why: 'member-safe semantic-search source: chunk vectors for rows the caller may see. Its `content` column is base-table cleartext, so it is withheld from anyone who is not the row owner',
  },
  {
    name: 'lattice_visible_embedding_count',
    args: 'p_table text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'count companion of the above, for the scan bound',
  },
  {
    name: 'lattice_changes_since',
    args: 'p_seq bigint, p_limit integer',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'change feed replay: table name / pk / op / owner role only, visibility-filtered',
  },
  {
    name: 'lattice_rows_access',
    args: 'p_table text, p_pks text[]',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'per-row visibility + owned flag for the sharing affordance',
  },
  {
    name: 'lattice_row_grantees',
    args: 'p_table text, p_pks text[]',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'grantee roles of a CALLER-OWNED custom-shared row',
  },
  {
    name: 'lattice_row_visible',
    args: 'p_table text, p_pk text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'the row-visibility predicate every policy and definer function is keyed on',
  },
  {
    name: 'lattice_delete_visible',
    args: 'p_table text, p_owner_role text, p_visibility text, p_grantees text[]',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'delete-event visibility from the pre-delete snapshot',
  },
  {
    name: 'lattice_table_has_masked_column',
    args: 'p_table text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'does this table carry a column mask right now, read out of the standing <t>_v definition (fail-closed: no view => true). Returns a boolean about the SCHEMA, never a cell; it is what lets the audit mask view withhold images only where a mask actually exists',
  },
  {
    name: 'lattice_is_owner',
    args: 'p_table text, p_pk text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'the column-mask predicate the generated <t>_v views compile to',
  },
  {
    name: 'lattice_require_owner',
    args: 'p_table text, p_pk text, p_action text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'shared owner gate; raises for a non-owner',
  },
  {
    name: 'lattice_source_visible',
    args: 'p_source_ref text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'source-ref visibility for change-log attribution',
  },
  {
    name: 'lattice_table_is_never_share',
    args: 'p_table text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'is this table flagged private-only',
  },
  {
    name: 'lattice_never_share_tables',
    args: 'p_tables text[]',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'batch never-share check for the dashboard-share cascade',
  },
  {
    name: 'lattice_get_cloud_setting',
    args: 'p_key text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'read a cloud-level setting (owner-only bookkeeping table, member-safe accessor)',
  },
  {
    name: 'lattice_set_cloud_setting',
    args: 'p_key text, p_value text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'write a cloud-level setting',
  },
  {
    name: 'lattice_claim_invite',
    args: '',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'one-time-use invite redemption, keyed on session_user',
  },
  {
    name: 'lattice_grant_row',
    args: 'p_table text, p_pk text, p_grantee text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'owner-gated per-row grant',
  },
  {
    name: 'lattice_revoke_row',
    args: 'p_table text, p_pk text, p_grantee text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'owner-gated per-row revoke',
  },
  {
    name: 'lattice_set_row_visibility',
    args: 'p_table text, p_pk text, p_visibility text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'owner-gated row visibility change',
  },
  {
    name: 'lattice_share_table',
    args: 'p_table text, p_audience text, p_grantees text[]',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'standing table-level share of the CALLER-owned rows',
  },
  {
    name: 'lattice_set_table_default_visibility',
    args: 'p_table text, p_visibility text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'cloud-owner-gated table default visibility',
  },
  {
    name: 'lattice_set_table_never_share',
    args: 'p_table text, p_on boolean',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'cloud-owner-gated never-share flag',
  },
  {
    name: 'lattice_set_column_audience',
    args: 'p_table text, p_column text, p_audience text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'cloud-owner-gated column audience change (raises for a non-owner)',
  },
  {
    name: 'lattice_member_add_column',
    args: 'p_table text, p_column text, p_type text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'member "add a field": widens the schema as the owner, rebuilds the mask view preserving its existing guards',
  },
  {
    name: 'lattice_member_claim_ownerless',
    args: 'p_table text, p_connector_id text',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: "claim the caller's own connector's not-yet-owned rows; returns a count",
  },
  // ── Installed by a SECOND owner action (enabling cloud S3), not by secureCloud ──
  //
  // These were outside this registry entirely, and outside the guard with it: the
  // guard enumerates from a fixture cloud built by `secureCloud` alone, so an object
  // installed by any other owner action was invisible to it. `lattice_presign_file`
  // is exactly that object, and it was leaking (below) the whole time the guard was
  // green. A registry that only lists what one fixture happens to materialize is a
  // list of what someone remembered, which is the thing this file exists to replace.
  {
    name: 'lattice_presign_file',
    args: 'p_file_id text, p_method text, p_ttl integer',
    returnsRowData: true,
    columnMask: 'applies',
    why: 'in-database SigV4 broker: presigns GET/PUT for a files row the caller may see. The returned URL SPLICES IN the object key taken from `files.ref_uri`, so the URL IS that column — it resolves the key as the caller may read it (base column privilege, else the `files_v` mask) rather than off the base table',
  },
];

/**
 * Definer functions whose names are PER-TABLE. Same rule as
 * {@link CLOUD_DEFINER_FUNCTIONS}, matched by prefix.
 *
 * `lattice_track_<table>()` is the ownership/change trigger function. It is a
 * trigger function, so it cannot be invoked as an ordinary call at all, and it
 * returns a trigger row rather than a result set.
 */
export const CLOUD_DEFINER_FUNCTION_PREFIXES: readonly DefinerFunctionEntry[] = [
  {
    name: 'lattice_track_',
    args: '',
    returnsRowData: false,
    columnMask: 'no-row-data',
    why: 'per-table ownership + change-feed trigger function (trigger-only; not directly callable)',
  },
];

/**
 * Classify a `SECURITY DEFINER` function by name + identity arguments, or `null`
 * when it is in NEITHER registry — which the guard treats as a failure, exactly as
 * it does for an unclassified relation.
 */
export function classifyDefinerFunction(name: string, args: string): DefinerFunctionEntry | null {
  const exact = CLOUD_DEFINER_FUNCTIONS.find((f) => f.name === name && f.args === args);
  if (exact) return exact;
  return CLOUD_DEFINER_FUNCTION_PREFIXES.find((f) => name.startsWith(f.name)) ?? null;
}

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
    //
    // It also clears every COLUMN-level SELECT, not just the table-level one, and that
    // is deliberate: the converged state a member ends every owner open in is "base
    // closed except the write keys". The mask-view generator transiently grants the
    // unmasked columns alongside its own revoke; this pass runs after it and takes
    // them back. See the note on dmlKeyGrantSql for what that costs and why the cost
    // is accepted rather than paid off by widening.
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
 * KNOWN COST, recorded here rather than quietly fixed. This set is the WRITE KEYS
 * only, so `INSERT ... ON CONFLICT DO UPDATE` — what `Lattice.upsert` and every
 * connector sync emit — stays `permission denied` for a member on every table, because
 * Postgres requires `SELECT` on each column read in the DO UPDATE expressions. The
 * mask-view generator grants those columns beside its own revoke, and this pass takes
 * them back on the next owner open, so the converged state is keys-only. Widening this
 * to "every column the view does not mask" makes upsert work and simultaneously
 * re-opens a base READ path the release deliberately closed — a member could then read
 * unmasked columns straight off the base, which the per-author chat isolation asserts
 * must be impossible (see cloud-migration-chat-owner-postgres). Which of those two
 * wins is a product decision about members and connector sync, not a bug fix, so it is
 * left alone and stated instead of being resolved silently in either direction.
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
  return MEMBER_READABLE_BOOKKEEPING.map((e) => {
    const lit = `'${e.name.replace(/'/g, "''")}'`;
    const stmts: string[] = [];
    if (e.withholdColumns) {
      // Order matters and is the security property. A column-less REVOKE clears the
      // table-level SELECT *and* every column-level one, so it must come first and the
      // narrow re-grant must follow it in the same block — otherwise a cloud that
      // already holds the old table-level grant keeps it. Converges on every owner open.
      stmts.push(`EXECUTE 'REVOKE SELECT ON "${e.name}" FROM ${group}'`);
    }
    stmts.push(`EXECUTE 'GRANT ${e.privs} ON "${e.name}" TO ${group}'`);
    if (e.withholdColumns) {
      // Column by column, over whatever the table ACTUALLY has minus the withheld set
      // — see the doc on `withholdColumns` for why a declared allowlist is wrong here.
      const withheld = e.withholdColumns.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');
      stmts.push(`FOR c IN
             SELECT "column_name" FROM "information_schema"."columns"
              WHERE "table_schema" = current_schema() AND "table_name" = ${lit}
                AND "column_name" NOT IN (${withheld})
           LOOP
             EXECUTE format('GRANT SELECT (%I) ON %I TO ${group}', c, ${lit});
           END LOOP`);
    }
    const view = e.readView
      ? `
         IF to_regclass('${e.readView}') IS NOT NULL THEN
           EXECUTE 'GRANT SELECT ON "${e.readView}" TO ${group}';
         END IF;`
      : '';
    return `DO $LATTICE$
       DECLARE c text;
       BEGIN
         IF to_regclass('${e.name}') IS NOT NULL THEN
           ${stmts.join(';\n           ')};
         END IF;${view}
       END $LATTICE$`;
  });
}

/** GRANT EXECUTE on the member-needed SQLite-compat polyfills. */
export function grantMemberExecuteSql(group: string): string {
  return `GRANT EXECUTE ON FUNCTION ${MEMBER_EXECUTE_FUNCTIONS.join(', ')} TO ${group}`;
}
