import type { Lattice } from '../lattice.js';
import { setRowVisibility, grantRow, revokeRow, batchRowGrants } from './members.js';
import { cascadeDashboardDataShare } from '../gui/dashboard-share-cascade.js';
import { cloudError } from './errors.js';

/**
 * Sharing one row, as a capability.
 *
 * The three sharing operations — change who a row is visible to, give one person
 * access to it, give several people access at once — are each a database call
 * plus one thing the database call does not know about: a shared dashboard has
 * to drag the data it reads along with it, or the recipient opens it to an empty
 * page. That pairing is the whole reason these are functions rather than the raw
 * primitives. Calling `setRowVisibility` alone is the bug, not the feature.
 *
 * The cascade is one-way by construction: it runs only when a dashboard becomes
 * MORE shared, never on unsharing, because narrowing a dashboard's audience must
 * not silently strip the underlying tables from people who still need them.
 *
 * Authorization is the database's. Each primitive goes through a definer
 * function that raises unless the caller owns the row, so a member calling these
 * directly is refused by Postgres exactly as they were through a request.
 */

/** The table whose shares cascade to the data behind them. */
const DASHBOARDS = 'dashboards';

/** Refuse anything but a cloud, with the wording the operation deserves. */
function assertCloud(db: Lattice, message: string): void {
  if (db.getDialect() !== 'postgres') throw cloudError('cloud_required', message);
}

export interface ShareRowInput {
  table: string;
  /** The row's canonical primary-key string. */
  pk: string;
  /** `private`, `everyone`, or `custom`. */
  visibility: string;
}

export interface ShareRowResult {
  table: string;
  pk: string;
  visibility: string;
}

/**
 * Set who can see one row, and carry a newly-public dashboard's data with it.
 *
 * Only the row's owner may change its sharing; the database raises for anyone
 * else. The cascade fires only when a dashboard becomes visible to everyone —
 * never on `private`, so unsharing a dashboard leaves its data shared.
 */
export async function shareRow(db: Lattice, input: ShareRowInput): Promise<ShareRowResult> {
  const { table, pk, visibility } = input;
  if (!table || !pk || !visibility) {
    throw cloudError('invalid_request', 'table, pk and visibility are required');
  }
  assertCloud(db, 'Sharing requires a cloud (Postgres) database');
  await setRowVisibility(db, table, pk, visibility);
  if (table === DASHBOARDS && visibility === 'everyone') {
    await cascadeDashboardDataShare(db, pk, 'everyone');
  }
  return { table, pk, visibility };
}

export interface GrantRowInput {
  table: string;
  pk: string;
  /** The member role being granted or revoked. */
  grantee: string;
  /** Revoke instead of grant. */
  revoke?: boolean;
}

export interface GrantRowResult {
  table: string;
  pk: string;
  grantee: string;
  revoked: boolean;
}

/**
 * Give one person access to one row, or take it away — "share with specific
 * people" for a single member. The first grant flips the row to `custom`
 * visibility inside the database.
 *
 * Owner-only, and refused outright for a table marked never-shareable. A grant
 * on a dashboard cascades to its data for the SAME person; a revoke never
 * cascades.
 */
export async function grantRowAccess(db: Lattice, input: GrantRowInput): Promise<GrantRowResult> {
  const { table, pk, grantee } = input;
  const revoke = input.revoke === true;
  if (!table || !pk || !grantee) {
    throw cloudError('invalid_request', 'table, pk and grantee are required');
  }
  assertCloud(db, 'Per-row sharing requires a cloud (Postgres) database');
  if (revoke) await revokeRow(db, table, pk, grantee);
  else await grantRow(db, table, pk, grantee);
  if (table === DASHBOARDS && !revoke) {
    await cascadeDashboardDataShare(db, pk, 'custom', [grantee]);
  }
  return { table, pk, grantee, revoked: revoke };
}

export interface BatchRowAccessInput {
  table: string;
  pk: string;
  /** Member roles to grant access to. */
  grant?: readonly string[];
  /** Member roles to take access away from. */
  revoke?: readonly string[];
}

export interface BatchRowAccessResult {
  table: string;
  pk: string;
  granted: readonly string[];
  revoked: readonly string[];
}

/**
 * Settle a whole audience for one row in a single call: grant access to every
 * role in `grant`, revoke it from every role in `revoke`.
 *
 * This is what a staged multi-select commits — one call instead of one write per
 * checkbox. Each subject still goes through the same owner-gated, idempotent
 * path as {@link grantRowAccess}, so the batch is owner-only by construction
 * rather than by a duplicated check. Only the granted roles cascade to a
 * dashboard's data; the revoked ones never un-share it.
 */
export async function batchRowAccess(
  db: Lattice,
  input: BatchRowAccessInput,
): Promise<BatchRowAccessResult> {
  const { table, pk } = input;
  const grant = input.grant ?? [];
  const revoke = input.revoke ?? [];
  if (!table || !pk) throw cloudError('invalid_request', 'table and pk are required');
  assertCloud(db, 'Per-row sharing requires a cloud (Postgres) database');
  await batchRowGrants(db, table, pk, grant, revoke);
  if (table === DASHBOARDS && grant.length > 0) {
    await cascadeDashboardDataShare(db, pk, 'custom', grant);
  }
  return { table, pk, granted: grant, revoked: revoke };
}
