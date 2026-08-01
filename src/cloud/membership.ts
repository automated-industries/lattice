import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { Lattice } from '../lattice.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { getDbCredential } from '../framework/user-config.js';
import { getActiveWorkspace } from '../framework/workspace.js';
import { assertNotManaged, MANAGED_REFUSAL } from './managed-guard.js';
import { parsePostgresUrl } from './url.js';
import { getOrCreateInviteSalt, hashInviteEmail } from './settings.js';
import {
  provisionMemberRole,
  generateMemberPassword,
  memberRoleName,
  assertScopedMemberRole,
  revokeMemberRole,
} from './members.js';
import { mintInviteToken, poolerAwareUser } from './invite.js';
import {
  currentDatabaseRole,
  markInvitesRevoked,
  recordMemberInvite,
  reclaimStaleInviteRoles,
} from './member-directory.js';
import { cloudError } from './errors.js';

/**
 * Adding and removing the people on a cloud, as capabilities.
 *
 * Inviting somebody is not one call — it is a dozen, in an order that matters:
 * refuse when a deployment's manager owns membership, confirm this really is a
 * cloud and the caller really owns it, validate the address, salt and hash it
 * for the audit ledger, reclaim the roles behind any stale invite for the same
 * person, provision a fresh scoped role and then PROVE it is unprivileged before
 * anything leaves the machine, work out the connection username the target's
 * pooler will actually accept, mint the token, and record the invite. Getting
 * that order wrong is how an orphaned live role or a privileged credential
 * escapes, so the sequence lives in one place and every caller gets all of it.
 *
 * It used to live inside a request handler, which meant an owner could only
 * invite somebody from a browser. On a machine with no display the workaround
 * was to bind the browser app to a network address — which its own help text
 * calls unauthenticated. That is the gap these functions close.
 *
 * Authority is NOT re-invented here. The owner check reads the connected
 * Postgres role's ability to create roles, and every mutating step behind it is
 * a database function that raises for a non-owner on its own. A command-line
 * caller therefore gets exactly the same authorization the browser app had, for
 * free, and nothing here weakens it.
 */

/** How long a freshly minted invite stays redeemable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A valid-looking email address. Deliberately loose — delivery is the real test. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Where a cloud lives, as an invite needs to describe it. */
export interface CloudCoords {
  host: string;
  port: number;
  dbname: string;
  /** The owner's own connection username, which may carry a tenant reference. */
  user: string;
}

/**
 * Host/port/database of the cloud a workspace config points at, read from the
 * saved credential (when the config names one) or from the raw connection line.
 * Returns null when the workspace is not on Postgres.
 *
 * The username is kept too: on a pooled host the tenant reference lives ONLY in
 * the connection-string username, never in the session role, and the invite has
 * to bake a username the member can actually connect with.
 */
export function cloudCoordsForConfig(configPath: string): CloudCoords | null {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);
  const url = labelMatch ? getDbCredential(labelMatch[1] ?? '') : dbLine;
  if (!url) return null;
  const parsed = parsePostgresUrl(url);
  return parsed
    ? { host: parsed.host, port: parsed.port, dbname: parsed.dbname, user: parsed.user }
    : null;
}

/** Confirm the database is a secured cloud and the caller owns it. */
async function assertCloudOwner(db: Lattice, ownerMessage: string): Promise<void> {
  if (db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(db))) {
    throw cloudError('cloud_required', 'The active database is not a Lattice cloud');
  }
  if (!(await canManageRoles(db))) throw cloudError('cloud_owner_only', ownerMessage);
}

export interface InviteMemberOptions {
  /** The person being invited. */
  email: string;
  /** Workspace config whose connection line names the cloud they are joining. */
  configPath: string;
  /** The `.lattice` root, so the invite can carry the cloud's display name. */
  latticeRoot?: string | null;
  /**
   * Override the managed-session refusal. Defaults to whether this process is
   * running as a managed session.
   */
  managed?: boolean;
}

export interface InviteMemberResult {
  /** The opaque, email-bound token the invitee redeems. */
  token: string;
  /** The scoped role that was provisioned for them. */
  role: string;
  email: string;
}

/**
 * Provision a scoped member role and mint the single email-bound token that
 * carries its credential. Owner-only. No plaintext credential is returned except
 * inside the opaque token, and the password is never stored anywhere.
 */
export async function inviteMember(
  db: Lattice,
  opts: InviteMemberOptions,
): Promise<InviteMemberResult> {
  assertNotManaged(opts.managed, MANAGED_REFUSAL.invite);
  await assertCloudOwner(db, 'Only a cloud owner can invite members');

  const email = opts.email.trim();
  if (!email || !EMAIL_RE.test(email)) {
    throw cloudError('invalid_request', 'A valid invitee email is required');
  }
  const coords = cloudCoordsForConfig(opts.configPath);
  if (!coords) {
    throw cloudError(
      'cloud_coords_unresolved',
      'Could not resolve the cloud connection coordinates',
    );
  }
  // Salt the audit email hash with a stable per-cloud salt (a bare digest is
  // rainbow-tableable). The salt is generated once and persisted, so the hash
  // stays a stable lookup key for re-invite and orphan cleanup.
  const emailHash = hashInviteEmail(await getOrCreateInviteSalt(db), email);
  // Before minting a fresh role, revoke any prior PENDING invite for this email
  // (a re-invite would otherwise orphan the previous role and leave its token
  // live) and sweep any expired-but-unredeemed orphans. Runs as the owner, who
  // holds the role-creation privilege, so the role drops actually take effect.
  await reclaimStaleInviteRoles(db, emailHash);
  // Provision a fresh scoped role, then HARD-ASSERT it is non-privileged before
  // embedding it in a token — never a superuser, never a role that can create
  // roles or bypass row-level security, never the owner itself.
  const role = memberRoleName(email);
  const password = generateMemberPassword();
  await provisionMemberRole(db, role, password);
  await assertScopedMemberRole(db, role);
  // Bake the pooler-correct username from the owner's CONNECTION-STRING
  // username, not the session role: on a pooled host the session role is the
  // bare name with no tenant reference, which yields a member username that
  // cannot connect at all.
  const user = poolerAwareUser(coords.host, role, coords.user);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // Stamp the owner's cloud name so the member's new workspace is named after
  // the cloud rather than a generic default.
  const ownerWs = opts.latticeRoot ? getActiveWorkspace(opts.latticeRoot) : null;
  const token = mintInviteToken({
    coords,
    user,
    password,
    role,
    email,
    expiresAt,
    ...(ownerWs?.displayName ? { workspaceName: ownerWs.displayName } : {}),
  });
  // Owner-only audit row. The password is NEVER stored; the email is kept only
  // in that owner-only ledger so the members list can show who each member is,
  // alongside the hash that keeps the record tamper-evident.
  await recordMemberInvite(db, { id: randomUUID(), role, emailHash, email, expiresAt });
  return { token, role, email };
}

export interface RemoveMemberOptions {
  /**
   * Override the managed-session refusal. Defaults to whether this process is
   * running as a managed session.
   */
  managed?: boolean;
}

export interface RemoveMemberResult {
  role: string;
}

/**
 * Remove a member: revoke their scoped role so their credential stops working,
 * then stamp their invites revoked. Owner-only, and it refuses to remove the
 * caller's own role — an owner cannot lock themselves out of their own cloud.
 *
 * The revoke itself surfaces its failures rather than swallowing them, so a
 * database that would not drop the role fails the whole removal loudly. The
 * audit stamp afterwards is best-effort and logged: the role is already gone by
 * then, and failing the removal over its bookkeeping would be a lie in the other
 * direction.
 */
export async function removeMember(
  db: Lattice,
  role: string,
  opts: RemoveMemberOptions = {},
): Promise<RemoveMemberResult> {
  assertNotManaged(opts.managed, MANAGED_REFUSAL.remove);
  await assertCloudOwner(db, 'Only a cloud owner can remove members');
  if (!role) throw cloudError('invalid_request', 'A member role is required');
  if (role === (await currentDatabaseRole(db))) {
    throw cloudError('invalid_request', 'You cannot remove yourself (the owner)');
  }
  await revokeMemberRole(db, role);
  await markInvitesRevoked(db, role).catch((e: unknown) => {
    console.error('[cloud] mark invite revoked failed:', (e as Error).message);
  });
  return { role };
}
