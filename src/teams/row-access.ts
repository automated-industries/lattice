import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';

/**
 * Row-level permission helpers for Lattice Teams (2.2).
 *
 * Binary access model: a member either can access a shared row (read +
 * write + delete) or the row does not exist for them — there is no
 * reader/editor gradation. Enforcement lives at the application layer
 * because every team member connects to the SAME physical cloud DB, so a
 * row a user cannot see must be filtered out before its bytes reach them.
 *
 * The ACL is kept out-of-band in `__lattice_row_acl` / `__lattice_row_grants`
 * (never injected into user tables). These are pure functions over a
 * `Lattice` handle, mirroring `direct-ops.ts`. Denials throw typed errors
 * (`RowAccessError` / `RowOwnerOnlyError`) that the API layer maps to
 * 404 / 403 — never swallowed, never a fallback-to-success.
 */

export type RowVisibility = 'private' | 'everyone' | 'custom';
export type TableDefaultVisibility = 'private' | 'everyone';

export interface RowAcl {
  ownerUserId: string;
  visibility: RowVisibility;
}

export interface ListVisibleOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  /** Soft-delete handling: 'exclude' (default), 'only' (trash view), 'any'. */
  deleted?: 'exclude' | 'only' | 'any';
}

/**
 * Thrown when a user tries to read or write a row they cannot access.
 * The API layer maps this to HTTP 404 so a denied read is indistinguishable
 * from a missing row (hide existence).
 */
export class RowAccessError extends Error {
  readonly code = 'row_access_denied';
  constructor(message = 'Row not accessible') {
    super(message);
    this.name = 'RowAccessError';
  }
}

/**
 * Thrown when a non-owner attempts an owner-only action (change a row's
 * visibility, manage its grant list). The API layer maps this to HTTP 403.
 */
export class RowOwnerOnlyError extends Error {
  readonly code = 'row_owner_only';
  constructor(message = 'Only the row owner may change its sharing') {
    super(message);
    this.name = 'RowOwnerOnlyError';
  }
}

function isRowVisibility(v: unknown): v is RowVisibility {
  return v === 'private' || v === 'everyone' || v === 'custom';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The table-owner-set default visibility for newly-created rows in a shared
 * table. Falls back to 'private' for tables that are not shared or have no
 * default recorded — the conservative choice.
 */
export async function tableDefaultVisibility(
  db: Lattice,
  teamId: string,
  table: string,
): Promise<TableDefaultVisibility> {
  const rows = await db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'deleted_at', op: 'isNull' },
    ],
    limit: 1,
  });
  return rows[0]?.default_row_visibility === 'everyone' ? 'everyone' : 'private';
}

/**
 * The owner of a shared TABLE: `__lattice_object_owners` first, falling back
 * to `__lattice_shared_objects.created_by_user_id`, then '' when neither is
 * recorded. Used as the owner of rows that have no explicit
 * `__lattice_row_acl` entry (pre-2.2 rows and never-narrowed rows), which
 * mirrors the upgrade backfill's attribution.
 */
export async function tableOwner(db: Lattice, teamId: string, table: string): Promise<string> {
  const owners = await db.query('__lattice_object_owners', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
    ],
    limit: 1,
  });
  const ownerId = owners[0]?.owner_user_id;
  if (typeof ownerId === 'string' && ownerId) return ownerId;
  const shared = await db.query('__lattice_shared_objects', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'deleted_at', op: 'isNull' },
    ],
    limit: 1,
  });
  const createdBy = shared[0]?.created_by_user_id;
  return typeof createdBy === 'string' ? createdBy : '';
}

async function rawAclRow(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
): Promise<Row | undefined> {
  const rows = await db.query('__lattice_row_acl', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'pk', op: 'eq', val: pk },
    ],
    limit: 1,
  });
  return rows[0];
}

/**
 * Resolve a row's effective owner + visibility. An explicit
 * `__lattice_row_acl` entry wins. Otherwise the row inherits the table's
 * default visibility and the table owner — so pre-2.2 rows in an
 * 'everyone'-default table read as everyone-visible, owned by the table
 * owner (who can then narrow them).
 */
export async function resolveRowAcl(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
): Promise<RowAcl> {
  const acl = await rawAclRow(db, teamId, table, pk);
  if (acl && isRowVisibility(acl.visibility)) {
    return { ownerUserId: String(acl.owner_user_id), visibility: acl.visibility };
  }
  const [visibility, owner] = await Promise.all([
    tableDefaultVisibility(db, teamId, table),
    tableOwner(db, teamId, table),
  ]);
  return { ownerUserId: owner, visibility };
}

/** True when `userId` owns the row (explicit ACL owner, or table owner for an unscoped row). */
export async function isRowOwner(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  const acl = await resolveRowAcl(db, teamId, table, pk);
  return acl.ownerUserId === userId;
}

async function hasRowGrant(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  const grants = await db.query('__lattice_row_grants', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'pk', op: 'eq', val: pk },
      { col: 'grantee_user_id', op: 'eq', val: userId },
    ],
    limit: 1,
  });
  return grants.length > 0;
}

/**
 * Binary access check: may `userId` see/edit this row? True iff they own it,
 * the row is 'everyone'-visible, or it's 'custom' and they hold a grant.
 */
export async function canAccessRow(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  userId: string,
): Promise<boolean> {
  const acl = await resolveRowAcl(db, teamId, table, pk);
  if (userId && acl.ownerUserId === userId) return true;
  if (acl.visibility === 'everyone') return true;
  if (acl.visibility === 'custom') return hasRowGrant(db, teamId, table, pk, userId);
  return false; // 'private' — owner-only, already handled above
}

/**
 * The rows of `table` that `userId` may see in team `teamId`, filtered
 * entirely in SQL (indexed, bounded — never "load all then filter in JS").
 * Delegates to {@link Lattice.queryVisible}, which reuses the same decrypt +
 * soft-delete path as `query()`.
 */
export async function listVisibleRows(
  db: Lattice,
  teamId: string,
  table: string,
  userId: string,
  opts: ListVisibleOptions = {},
): Promise<Row[]> {
  // A no-ACL row is visible iff the table defaults to 'everyone' or the
  // caller owns the table (legacy / never-narrowed rows). Both are
  // per-table constants, resolved once here and pushed into the SQL predicate.
  const [owner, def] = await Promise.all([
    tableOwner(db, teamId, table),
    tableDefaultVisibility(db, teamId, table),
  ]);
  const noAclVisible = def === 'everyone' || (userId !== '' && owner === userId);
  return db.queryVisible(table, { teamId, userId, noAclVisible, ...opts });
}

// ---------------------------------------------------------------------------
// Writes (owner-gated)
// ---------------------------------------------------------------------------

/**
 * Record a row's ACL at creation time: owner = creator, visibility = the
 * passed value (typically the table default). Idempotent on the row's PK.
 * Not owner-gated — the creator is the owner.
 */
export async function recordRowAcl(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  ownerUserId: string,
  visibility: RowVisibility,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await rawAclRow(db, teamId, table, pk);
  await db.upsert('__lattice_row_acl', {
    team_id: teamId,
    table_name: table,
    pk,
    owner_user_id: ownerUserId,
    visibility,
    created_at: (existing?.created_at as string | undefined) ?? now,
    updated_at: now,
  });
}

async function requireOwner(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  actorUserId: string,
): Promise<{ existing: Row | undefined; owner: string }> {
  const existing = await rawAclRow(db, teamId, table, pk);
  const owner = existing ? String(existing.owner_user_id) : await tableOwner(db, teamId, table);
  if (!actorUserId || owner !== actorUserId) throw new RowOwnerOnlyError();
  return { existing, owner };
}

/** Owner-gated change of a row's visibility. Materialises an ACL row if none existed yet. */
export async function setRowVisibility(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  actorUserId: string,
  visibility: RowVisibility,
): Promise<void> {
  const { existing, owner } = await requireOwner(db, teamId, table, pk, actorUserId);
  const now = new Date().toISOString();
  await db.upsert('__lattice_row_acl', {
    team_id: teamId,
    table_name: table,
    pk,
    owner_user_id: owner,
    visibility,
    created_at: (existing?.created_at as string | undefined) ?? now,
    updated_at: now,
  });
}

/**
 * Owner-gated grant of an existing row to another member. Writes the grant
 * row and flips a 'private' row to 'custom' so the grant is consulted; a
 * row already shared with 'everyone' is left as-is (the grantee can already
 * see it). Idempotent on (row, grantee).
 */
export async function addRowGrant(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  granteeUserId: string,
  grantedByUserId: string,
): Promise<void> {
  const { existing, owner } = await requireOwner(db, teamId, table, pk, grantedByUserId);
  const now = new Date().toISOString();
  const currentVis: RowVisibility =
    existing && isRowVisibility(existing.visibility)
      ? existing.visibility
      : await tableDefaultVisibility(db, teamId, table);
  const nextVis: RowVisibility = currentVis === 'everyone' ? 'everyone' : 'custom';
  await db.upsert('__lattice_row_acl', {
    team_id: teamId,
    table_name: table,
    pk,
    owner_user_id: owner,
    visibility: nextVis,
    created_at: (existing?.created_at as string | undefined) ?? now,
    updated_at: now,
  });
  await db.upsert('__lattice_row_grants', {
    team_id: teamId,
    table_name: table,
    pk,
    grantee_user_id: granteeUserId,
    granted_by_user_id: grantedByUserId,
    granted_at: now,
  });
}

/** Owner-gated removal of a single grantee from a row's grant list (hard delete). */
export async function removeRowGrant(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  granteeUserId: string,
  actorUserId: string,
): Promise<void> {
  await requireOwner(db, teamId, table, pk, actorUserId);
  await db.delete('__lattice_row_grants', {
    team_id: teamId,
    table_name: table,
    pk,
    grantee_user_id: granteeUserId,
  });
}

// ---------------------------------------------------------------------------
// GUI payload helpers
// ---------------------------------------------------------------------------

/** Minimal per-row access summary surfaced to the GUI (drives the eye icon). */
export interface RowAccessSummary {
  owner_user_id: string;
  visibility: RowVisibility;
  ownedByMe: boolean;
}

/**
 * Resolve access summaries for many rows of one table in a BATCHED way (one
 * ACL query + the table owner/default, no N+1). Rows without an explicit ACL
 * entry inherit the table default + table owner — matching {@link resolveRowAcl}.
 * Intended for the GET-list payload, so the GUI can render each row's eye icon
 * without a per-row round-trip. Never includes the grantee list.
 */
export async function rowAccessSummaries(
  db: Lattice,
  teamId: string,
  table: string,
  userId: string,
  pks: string[],
): Promise<Map<string, RowAccessSummary>> {
  const out = new Map<string, RowAccessSummary>();
  if (pks.length === 0) return out;
  const acls = await db.query('__lattice_row_acl', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
    ],
  });
  const aclByPk = new Map(acls.map((a) => [String(a.pk), a]));
  const [owner, def] = await Promise.all([
    tableOwner(db, teamId, table),
    tableDefaultVisibility(db, teamId, table),
  ]);
  for (const pk of pks) {
    const a = aclByPk.get(pk);
    const ownerUserId = a ? String(a.owner_user_id) : owner;
    const visibility: RowVisibility = a && isRowVisibility(a.visibility) ? a.visibility : def;
    out.set(pk, { owner_user_id: ownerUserId, visibility, ownedByMe: ownerUserId === userId });
  }
  return out;
}

/**
 * Of `candidateUserIds`, those who can currently access the row. Used by the
 * hosted delete/kick fan-out to target an `unlink` at exactly the members who
 * hold a local copy, before the ACL is torn down.
 */
export async function usersWithRowAccess(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
  candidateUserIds: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const uid of candidateUserIds) {
    if (await canAccessRow(db, teamId, table, pk, uid)) out.push(uid);
  }
  return out;
}

/** Hard-delete a row's ACL entry and all of its grants (cleanup on row delete/unlink). */
export async function deleteRowAcl(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
): Promise<void> {
  await db.delete('__lattice_row_acl', { team_id: teamId, table_name: table, pk });
  const grants = await db.query('__lattice_row_grants', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'pk', op: 'eq', val: pk },
    ],
  });
  for (const g of grants) {
    await db.delete('__lattice_row_grants', {
      team_id: teamId,
      table_name: table,
      pk,
      grantee_user_id: g.grantee_user_id,
    });
  }
}

/** The grantee user-ids of a row's custom grant list (owner-facing detail only). */
export async function rowGrantees(
  db: Lattice,
  teamId: string,
  table: string,
  pk: string,
): Promise<string[]> {
  const grants = await db.query('__lattice_row_grants', {
    filters: [
      { col: 'team_id', op: 'eq', val: teamId },
      { col: 'table_name', op: 'eq', val: table },
      { col: 'pk', op: 'eq', val: pk },
    ],
  });
  return grants.map((g) => String(g.grantee_user_id));
}

/**
 * Owner-gated change of a shared table's default row visibility (the
 * visibility newly-created rows in that table are born with). Gated to the
 * table owner (see {@link tableOwner}) — only they may flip whether new
 * rows default to private or everyone.
 */
export async function setTableDefaultVisibility(
  db: Lattice,
  teamId: string,
  table: string,
  actorUserId: string,
  visibility: TableDefaultVisibility,
): Promise<void> {
  const owner = await tableOwner(db, teamId, table);
  if (!actorUserId || owner !== actorUserId) {
    throw new RowOwnerOnlyError('Only the table owner may change the default row visibility');
  }
  await db.update(
    '__lattice_shared_objects',
    { team_id: teamId, table_name: table },
    { default_row_visibility: visibility, updated_at: new Date().toISOString() },
  );
}
