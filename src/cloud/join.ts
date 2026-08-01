import { probeCloud, claimMemberInvite } from '../framework/cloud-connect.js';
import {
  createCloudWorkspace,
  type CloudWorkspaceAuthorization,
} from '../framework/cloud-workspace.js';
import { buildPostgresUrl } from './url.js';
import { redeemInviteToken } from './invite.js';
import { slugify } from '../render/markdown.js';
import { cloudError } from './errors.js';

/**
 * Joining someone else's cloud, as a capability.
 *
 * A member joins by connecting DIRECTLY to the shared database as the scoped
 * role the owner provisioned — there is no server in between, and the invite is
 * nothing more than those credentials in an email-bound envelope. So the whole
 * of "join" is: check the target is reachable and really is a Lattice cloud,
 * claim the invite if there is one, and register the connection as a new local
 * workspace.
 *
 * None of that needs a browser, but until now the sequence only existed inside
 * two request handlers, so the only way to join a cloud from a headless machine
 * was to start a server and send it a request. Both handlers now call the two
 * functions here.
 *
 * The workspace step is injectable for exactly one reason: a running session has
 * a database open and has to swap to the new one, and a script does not. The
 * default creates the workspace and points the registry at it, which is the
 * whole job when nothing is live.
 */

/**
 * Registers a joined cloud as a workspace and returns its id.
 *
 * The fourth argument carries the single-use invite claim, when there is one. It
 * is handed to the creator rather than performed before calling it so the claim
 * lands INSIDE the creator's own ordering — after the workspace exists and before
 * it is opened — which is what keeps a spent invite from being thrown away by a
 * later failure. A creator written before this existed simply ignores it.
 */
export type CloudWorkspaceCreator = (
  displayName: string,
  key: string,
  url: string,
  auth?: CloudWorkspaceAuthorization,
) => Promise<string>;

/** The scoped credential a member connects with. */
export interface CloudJoinFields {
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
}

export interface CloudJoinOptions {
  /** Human name for the workspace the join creates. */
  label: string;
  /**
   * The `.lattice` root the new workspace is registered in. Used by the default
   * workspace creator; ignored when `createCloudWorkspace` is supplied.
   */
  latticeRoot?: string | null;
  /**
   * How the joined cloud becomes a workspace. A live session passes its own so
   * the open database swaps over too; leave it out to register and activate the
   * workspace without opening anything.
   */
  createCloudWorkspace?: CloudWorkspaceCreator;
  /**
   * Claim a pending invite as this member before anything is created. Set on the
   * email-bound redeem path; the manual credential path has no invite row.
   */
  claimInvite?: boolean;
}

export interface CloudJoinResult {
  label: string;
  isCloud: true;
  workspaceId: string;
}

/** The workspace creator to use: the caller's, else the plain registry one. */
function creatorFor(opts: {
  latticeRoot?: string | null;
  createCloudWorkspace?: CloudWorkspaceCreator;
}): CloudWorkspaceCreator {
  if (opts.createCloudWorkspace) return opts.createCloudWorkspace;
  const root = opts.latticeRoot ?? null;
  return (displayName, key, url, auth) =>
    createCloudWorkspace(root, displayName, key, url, { ...auth });
}

/**
 * Spend the invite, or refuse the join.
 *
 * One-time use plus revocation: `lattice_claim_invite()` stamps the redemption
 * server-side and answers false for a replayed or leaked token, a revoked invite,
 * or an expired one. Any connection or SQL failure also answers false — the join
 * fails CLOSED and says so rather than proceeding on an unproven claim.
 */
async function claimOrRefuse(url: string): Promise<void> {
  const claim = await claimMemberInvite(url);
  if (claim.claimed) return;
  throw cloudError(
    'cloud_invite_rejected',
    claim.error ??
      'This invite has already been used, was revoked, or has expired. Ask the owner for a new one.',
  );
}

/**
 * Join an existing Lattice cloud as a scoped member: probe the connection, then
 * persist the encrypted credential, point a new workspace at it, and activate
 * it. Shared by the manual credential flow and the email-bound invite flow so
 * both take the IDENTICAL path (probe → save → swap) — the member connects
 * directly as their scoped role under row-level security.
 *
 * The email-bound flow adds one step, and where it sits is the whole point. The
 * claim is irreversible and cannot be compensated: once an invite is spent it
 * cannot be spent again, and the password it carried is not written down
 * anywhere else. So it is spent at the single moment when everything before it
 * can still be undone and nothing after it can waste it — see the authorize hook
 * on the workspace creator.
 */
export async function joinCloud(
  fields: CloudJoinFields,
  opts: CloudJoinOptions,
): Promise<CloudJoinResult> {
  const url = buildPostgresUrl(fields);
  const probe = await probeCloud(url);
  if (!probe.reachable) {
    throw cloudError('cloud_unreachable', probe.error ?? 'Cloud DB unreachable');
  }
  if (!probe.isCloud) {
    throw cloudError(
      'cloud_not_lattice',
      'That Postgres database is not a Lattice cloud yet. The owner must migrate a local Lattice into it first.',
    );
  }
  // Create a NEW workspace for the cloud and switch to it — never repoint
  // (hijack) the currently-open workspace, which previously overwrote the user's
  // existing local workspace (wrong name, orphaned data, no switcher entry).
  // The credential key and the reference that names it MUST be a sanitized,
  // space-free label or the path resolver rejects it (the default "Cloud
  // workspace" — with a space — never resolved, silently dropping the member on
  // an empty local database). Sanitize the key; keep the human label as the
  // display name.
  //
  // On the email-bound redeem path the single-use claim rides ALONG with the
  // creation rather than happening before it, so it is spent at the one moment
  // when a refusal can still undo everything and a later failure can no longer
  // waste it. The manual flow has no invite row and passes nothing.
  const key = slugify(opts.label) || 'cloud';
  const workspaceId = await creatorFor(opts)(
    opts.label,
    key,
    url,
    opts.claimInvite ? { authorize: () => claimOrRefuse(url) } : {},
  );
  return { label: opts.label, isCloud: true, workspaceId };
}

export interface RedeemInviteInput {
  /** The email the invite was addressed to — half of the decryption key. */
  email: string;
  /** The opaque invite token. */
  token: string;
  /** Fallback workspace name, used only when the token carries none. */
  label?: string;
  /** The `.lattice` root the new workspace is registered in. */
  latticeRoot?: string | null;
  /** A live session's workspace creator; omit outside one. */
  createCloudWorkspace?: CloudWorkspaceCreator;
}

/**
 * Redeem an email-bound invite: decrypt the token locally with the invitee's
 * email, reconstruct the SAME scoped credential the owner minted, and join
 * through {@link joinCloud}. The caller only ever handles an email and a token —
 * never a connection string.
 *
 * The workspace is named after the owner's cloud when the token carries that
 * name, so a member's new workspace reads as the cloud they joined rather than a
 * generic default.
 */
export async function redeemCloudInvite(input: RedeemInviteInput): Promise<CloudJoinResult> {
  const email = input.email.trim();
  const token = input.token.trim();
  if (!email || !token) {
    throw cloudError(
      'invalid_request',
      'Enter the email this invite was sent to and the invite token.',
    );
  }
  let payload;
  try {
    payload = redeemInviteToken(email, token);
  } catch (e) {
    throw cloudError('cloud_invite_token', (e as Error).message);
  }
  const fromCloud = payload.workspace_name?.trim() ?? '';
  const fromCaller = input.label?.trim() ?? '';
  const label =
    fromCloud.length > 0 ? fromCloud : fromCaller.length > 0 ? fromCaller : 'Cloud workspace';
  return joinCloud(
    {
      host: payload.host,
      port: payload.port,
      dbname: payload.dbname,
      user: payload.user,
      password: payload.password,
    },
    {
      label,
      claimInvite: true,
      ...(input.latticeRoot === undefined ? {} : { latticeRoot: input.latticeRoot }),
      ...(input.createCloudWorkspace ? { createCloudWorkspace: input.createCloudWorkspace } : {}),
    },
  );
}
