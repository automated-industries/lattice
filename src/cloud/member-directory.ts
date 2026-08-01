import type { Lattice } from '../lattice.js';
import { runAsyncOrSync, allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import { memberGroupFor } from './rls.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { revokeMemberRole } from './members.js';
import { MAX_ROWS_PAGE } from '../ops/paging.js';

/**
 * Who is on this cloud, and the invite records behind them — a capability, not a
 * route.
 *
 * Two different questions live here and they share the same two tables, so they
 * belong together: "list the people on this cloud" (the owner enumerating the
 * member group, each row named from its invite) and "keep the invite ledger
 * honest" (record an invite, revoke one, reclaim the roles behind stale ones).
 *
 * None of it needs a server. An owner should be able to see the roster or clean
 * up orphaned roles from a script or a command line, so the reads and writes are
 * plain function calls over the database and the HTTP layer only shapes the
 * answer into JSON.
 *
 * The invite table is owner-only by design: it stores an email hash for
 * tamper-evident audit plus the plaintext email so the roster can show who each
 * member is. A member's password is never stored anywhere.
 */

/** The invite ledger. Owner-only; a scoped member has no grant on it. */
const INVITES_TABLE = '__lattice_member_invites';

/**
 * Largest roster page a single call will read.
 *
 * Both reads behind the roster are bounded rather than open-ended: the member
 * group has no natural ceiling, and the invite ledger grows with every invite
 * ever issued, so an unbounded scan of either is one very popular cloud away
 * from reading far more than anybody asked for. Callers that genuinely have more
 * members than this page past them with `offset`; nothing becomes unreachable.
 * The same number the row reads use, for the same reason.
 */
const MAX_MEMBER_PAGE = MAX_ROWS_PAGE;

/** One row of the member roster. */
export interface CloudMember {
  /** The database role this person connects as. */
  role: string;
  /** Display name — from the invite email's local part, else the role itself. */
  name: string;
  email: string;
  /** `owner` for the cloud owner; `invited` until they redeem; then `member`. */
  status: 'owner' | 'member' | 'invited';
  /** True for the row describing the caller. */
  isYou: boolean;
}

/**
 * The database role this connection is authenticated as. On a cloud this is the
 * owner's role for an owner connection and the scoped role for a member.
 */
export async function currentDatabaseRole(db: Lattice): Promise<string> {
  const me = (await getAsyncOrSync(db.adapter, `SELECT session_user AS u`)) as
    | { u?: string }
    | undefined;
  return me?.u ?? '';
}

/** The operator's own display name + email, mirrored into the identity table on open. */
async function ownerIdentity(db: Lattice): Promise<{ name: string; email: string }> {
  // Absent on a cloud that predates the identity mirror, and unreadable for a
  // member — in both cases the roster still renders, just with the bare role as
  // the name, so this degrades rather than failing the listing.
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT display_name, email FROM "__lattice_user_identity" WHERE id = 'singleton'`,
  ).catch(() => undefined)) as { display_name?: string; email?: string } | undefined;
  // An EMPTY trimmed name must fall back to the role, not just a null one.
  const trimmed = row?.display_name?.trim() ?? '';
  return { name: trimmed, email: row?.email ?? '' };
}

/**
 * One bounded page of roles in this cloud's member group, excluding
 * `exceptRole`, sorted by name. Ordered before it is limited, so paging with
 * `offset` walks a stable sequence.
 */
async function memberGroupRoles(
  db: Lattice,
  exceptRole: string,
  limit: number,
  offset: number,
): Promise<string[]> {
  const group = await memberGroupFor(db);
  const rows = (await allAsyncOrSync(
    db.adapter,
    `SELECT m.rolname AS role
       FROM pg_auth_members am
       JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = ?
       JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname <> ?
      ORDER BY m.rolname
      LIMIT ? OFFSET ?`,
    [group, exceptRole, limit, offset],
  )) as { role: string }[];
  return rows.map((r) => r.role);
}

/** A role's most recent non-revoked invite. */
export interface InviteRecord {
  role: string;
  email?: string;
  redeemed_at?: string | null;
}

/**
 * Latest non-revoked invite for each of `roles`. `redeemed_at` null means the
 * person was invited but has not joined yet.
 *
 * Scoped to the roles asked about rather than reading the whole ledger: the
 * caller already holds a bounded page of roles, and the ledger keeps a row for
 * every invite ever issued. Passing no roles reads nothing.
 */
export async function latestInvitesByRole(
  db: Lattice,
  roles: readonly string[],
): Promise<Map<string, InviteRecord>> {
  if (roles.length === 0) return new Map();
  // The ledger is absent on a cloud that never issued an invite; an empty
  // roster-decoration is the right answer there, not a failed listing.
  const invites = (await allAsyncOrSync(
    db.adapter,
    `SELECT DISTINCT ON ("role") "role", "email", "redeemed_at"
       FROM "${INVITES_TABLE}"
      WHERE "revoked_at" IS NULL AND "role" = ANY(?::text[])
      ORDER BY "role", "created_at" DESC`,
    [[...roles]],
  ).catch(() => [])) as InviteRecord[];
  return new Map(invites.map((r) => [r.role, r]));
}

/** Which slice of the roster to read. */
export interface ListCloudMembersOptions {
  /** Members per page, clamped to the roster page ceiling. */
  limit?: number;
  /** Members to skip, for reading past the first page. */
  offset?: number;
}

/**
 * The cloud's roster: the owner plus a bounded page of the roles in its member
 * group, each named from its latest invite.
 *
 * Returns `[]` off a secured cloud — a local single-user workspace has no
 * members to list. A scoped member sees only itself, because enumerating the
 * group is an owner privilege.
 *
 * The owner row is prepended to every page and does not count against `limit`:
 * it identifies the caller, and a roster whose second page did not say who was
 * asking would be harder to read, not more correct.
 */
export async function listCloudMembers(
  db: Lattice,
  opts: ListCloudMembersOptions = {},
): Promise<CloudMember[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? MAX_MEMBER_PAGE)), MAX_MEMBER_PAGE);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(db))) return [];

  const ownerRole = await currentDatabaseRole(db);
  const identity = await ownerIdentity(db);
  const ownerName = identity.name.length > 0 ? identity.name : ownerRole;
  const owner: CloudMember = {
    role: ownerRole,
    name: ownerName,
    email: identity.email,
    status: 'owner',
    isYou: true,
  };

  if (!(await canManageRoles(db))) {
    // A scoped member: it is the only row it is allowed to see, and it is not
    // the owner — label it plainly rather than claiming ownership.
    return ownerRole ? [{ ...owner, status: 'member' }] : [];
  }

  // The owner is prepended above, so exclude it from the group query — listing it
  // from both places double-counted it.
  const roles = await memberGroupRoles(db, ownerRole, limit, offset);
  const inviteByRole = await latestInvitesByRole(db, roles);
  return [
    owner,
    ...roles.map((role): CloudMember => {
      const inv = inviteByRole.get(role);
      const email = inv?.email ?? '';
      const name = email ? (email.split('@')[0] ?? role) : role;
      // A member-group role with no invite row (a hand-created role) counts as a
      // redeemed member — only a pending invite reads as "invited".
      const status = inv && inv.redeemed_at == null ? 'invited' : 'member';
      return { role, name, email, status, isYou: false };
    }),
  ];
}

/**
 * Record an issued invite in the owner-only ledger. The plaintext email is
 * stored so the roster can show who a member is; the hash stays for
 * tamper-evident audit. The password is not stored.
 */
export async function recordMemberInvite(
  db: Lattice,
  invite: { id: string; role: string; emailHash: string; email: string; expiresAt: Date },
): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "${INVITES_TABLE}" ("id","role","email_hash","email","expires_at")
       VALUES (?, ?, ?, ?, ?)`,
    [
      invite.id,
      invite.role,
      invite.emailHash,
      invite.email.trim().toLowerCase(),
      invite.expiresAt.toISOString(),
    ],
  );
}

/** Stamp every live invite for `role` revoked. Throws if the write fails. */
export async function markInvitesRevoked(db: Lattice, role: string): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `UPDATE "${INVITES_TABLE}" SET "revoked_at" = now() WHERE "role" = ? AND "revoked_at" IS NULL`,
    [role],
  );
}

/**
 * Orphan-role cleanup, run by the owner at invite time (the owner holds the
 * role-creation privilege). Two passes, both stamping the invite revoked and
 * dropping the scoped role so it can never be redeemed and never piles up:
 *
 *   1. RE-INVITE — any still-pending invite for THIS email. Re-inviting mints a
 *      fresh suffixed role, so without this the prior role is orphaned AND its
 *      old token stays live. Revoking it makes the newest invite the only valid
 *      one.
 *   2. SWEEP — any pending invite that has EXPIRED. Its role would otherwise
 *      linger forever: invites have a lifetime, but nothing dropped the role
 *      when that lifetime ran out.
 *
 * `revokeMemberRole` is idempotent on an already-gone role, so a stale invite
 * whose role was dropped elsewhere just gets its revocation stamped. Failures
 * propagate — a re-invite must never silently leave a live orphan behind.
 */
export async function reclaimStaleInviteRoles(db: Lattice, emailHash: string): Promise<void> {
  const stale = (await allAsyncOrSync(
    db.adapter,
    `SELECT DISTINCT "role" FROM "${INVITES_TABLE}"
       WHERE "redeemed_at" IS NULL AND "revoked_at" IS NULL
         AND ("email_hash" = ? OR "expires_at" <= now())`,
    [emailHash],
  )) as { role: string }[];
  for (const { role } of stale) {
    await revokeMemberRole(db, role);
    await markInvitesRevoked(db, role);
  }
}
