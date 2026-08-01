/**
 * The account, headless: signing this machine in, signing it out, keeping its
 * workspaces in step, and administering a hosted workspace — none of it needing
 * a browser to be running.
 *
 * Signing in is the step that looks like it could never leave the browser, and
 * that impression is what kept every one of these operations inside a request
 * handler. Only ONE leg of the handshake actually needs a person and a browser:
 * approving the request on the account service's own page. Everything on either
 * side of that leg is an ordinary call — ask the service to start a request, get
 * back a URL to approve; hand the resulting one-time code back and receive the
 * session. The browser-only middle is not ours at all; it happens on the
 * service's website, on whatever machine the person happens to be at.
 *
 * So the headless shape is the paste-a-code shape, and it is the same handshake
 * the app performs. Start it, approve the printed URL anywhere, hand the code
 * back:
 *
 *     lattice account signin          → prints the approval URL
 *     …approve it in any browser…     → the page shows a one-time code
 *     lattice account code <code>     → the machine is signed in
 *
 * The app skips the paste by having the approval page hand the code straight
 * back over the loopback, which is a convenience for a machine that has a
 * browser attached — not a different mechanism. Both paths end in the same
 * exchange call, write the same encrypted session, and are indistinguishable
 * afterwards.
 *
 * WHAT IS NOT HERE, on purpose: the approval page itself. There is nothing for a
 * command line to complete there, and pretending otherwise would mean either
 * driving somebody else's web page or asking for the account password — which is
 * the entire thing a device sign-in exists to avoid.
 *
 * Every value written here is machine-local and encrypted at rest, the same
 * store the app writes. A refusal arrives as an Error carrying a `code` (see
 * `accountErrorCode`) rather than a status, because the same call serves a
 * request, a command, and a library.
 */
import { hostname } from 'node:os';
import { readIdentity, writeIdentity } from '../framework/user-config.js';
import { probeCloud as probeCloudDefault } from '../framework/cloud-connect.js';
import { createCloudWorkspace } from '../framework/cloud-workspace.js';
import { discoverIdentityService, exchangeSignIn, startSignIn } from '../gui/identity/service.js';
import {
  clearPendingSignIn,
  readIdentitySession,
  readPendingSignIn,
  writeIdentitySession,
  writePendingSignIn,
} from '../gui/identity/store.js';
import { revokeDeviceAccess, type ModelAccessRevocation } from '../gui/identity/model.js';
import {
  syncMemberships,
  type MembershipSyncDeps,
  type MembershipSyncResult,
} from '../gui/identity/sync.js';
import { isManagedWorkspaces, managerCall } from '../gui/identity/managed.js';
import { accountError, NO_WORKSPACE_MANAGER } from './account-errors.js';

// What the two operations that already had a result type hand back. Re-exported
// so a caller can name the answer it gets, without importing a path under the
// browser client to describe the result of a headless call.
export type { ModelAccessRevocation } from '../gui/identity/model.js';
export type { MembershipSyncResult } from '../gui/identity/sync.js';

// ── Where this machine stands ──────────────────────────────────────────────

/** Whether this machine is signed in, and whether an account service exists at all. */
export interface AccountStatus {
  /** True when this machine holds a session. */
  linked: boolean;
  email: string | null;
  name: string | null;
  /** False when no account service could be discovered — the feature is simply absent. */
  serviceAvailable: boolean;
  /** Where a person manages the account, when the service says. */
  accountUrl: string | null;
  /** True in a hosted session that delegates workspace administration to a manager. */
  managedWorkspaces: boolean;
}

/** Report where this machine stands with the account service, changing nothing. */
export async function readAccountStatus(): Promise<AccountStatus> {
  const session = readIdentitySession();
  const endpoints = await discoverIdentityService();
  return {
    linked: !!session,
    email: session?.email ?? null,
    name: session?.name ?? null,
    serviceAvailable: endpoints !== null,
    accountUrl: endpoints?.account ?? null,
    managedWorkspaces: isManagedWorkspaces(),
  };
}

/**
 * The sign-in waiting for its code, without the secret that would let a caller
 * finish it somewhere else. Enough to tell a person "you started one, it has not
 * been finished", which is the difference between a stuck sign-in and no sign-in.
 */
export interface PendingAccountSignIn {
  requestId: string;
  /** When it was started, ISO-8601. */
  startedAt: string;
}

/** The unfinished sign-in on this machine, or null when there is none. */
export function pendingAccountSignIn(): PendingAccountSignIn | null {
  const pending = readPendingSignIn();
  if (!pending) return null;
  return { requestId: pending.requestId, startedAt: new Date(pending.startedAt).toISOString() };
}

// ── Signing in ─────────────────────────────────────────────────────────────

/** What a started sign-in gives the caller to act on. */
export interface StartedAccountSignIn {
  /** The URL a person opens and approves. Anywhere — it need not be this machine. */
  verifyUrl: string;
  /** The service's id for this attempt. */
  requestId: string;
  /** How long the service says the request stays approvable, when it says. */
  expiresInSeconds?: number;
}

export interface StartAccountSignInInput {
  /**
   * How this machine identifies itself on the approval page, so a person with
   * several signed-in machines can tell which one is asking.
   */
  label?: string;
  /**
   * A loopback port for the approval page to hand the code back to, when the
   * caller is running one. Omit it and the page shows the code to be pasted,
   * which is the headless path.
   */
  redirectPort?: number | null;
}

/**
 * Ask the account service to start a sign-in, and remember the half of the
 * handshake this machine has to keep.
 *
 * @throws with code `service_unavailable` when no account service can be found —
 * the honest answer for a machine that is offline or a deployment that has none.
 * Every other failure arrives from the sign-in client tagged with the leg it came
 * from, so a caller can say which part of the handshake broke.
 */
export async function startAccountSignIn(
  input: StartAccountSignInInput = {},
): Promise<StartedAccountSignIn> {
  const endpoints = await discoverIdentityService();
  if (!endpoints) {
    console.warn('[lattice] identity step "discovery" failed: no service manifest resolved');
    throw accountError(
      'service_unavailable',
      'No account service could be reached from this machine.',
    );
  }
  const started = await startSignIn(
    endpoints,
    input.label ?? `Lattice on ${hostname()}`,
    input.redirectPort ?? null,
  );
  writePendingSignIn({
    requestId: started.requestId,
    requestSecret: started.requestSecret,
    endpoints,
    startedAt: Date.now(),
  });
  return {
    verifyUrl: started.verifyUrl,
    requestId: started.requestId,
    ...(started.expiresInSeconds !== undefined
      ? { expiresInSeconds: started.expiresInSeconds }
      : {}),
  };
}

/** Who this machine is now signed in as. */
export interface CompletedAccountSignIn {
  email: string;
  name: string | null;
}

/**
 * Finish the sign-in: exchange the approved code for a session, store it, and
 * adopt the account's email as this machine's identity where none was set — so
 * chat attribution, member identity, and the invite flows all see one email.
 *
 * @throws with code `no_signin_in_progress` when nothing is waiting for a code
 * (never started, already finished, or expired). A rejected code arrives from the
 * sign-in client tagged with the exchange leg.
 */
export async function completeAccountSignIn(code: string): Promise<CompletedAccountSignIn> {
  const pending = readPendingSignIn();
  if (!pending) {
    throw accountError(
      'no_signin_in_progress',
      'No sign-in is in progress — start a new one and approve it again.',
    );
  }
  const session = await exchangeSignIn(
    pending.endpoints,
    pending.requestId,
    pending.requestSecret,
    code.trim(),
  );
  clearPendingSignIn();
  writeIdentitySession({
    token: session.token,
    email: session.email,
    name: session.name,
    serviceBase: pending.endpoints.base,
    linkedAt: new Date().toISOString(),
    materialized: {},
    revoked: [],
  });
  const local = readIdentity();
  if (!local.email || !local.display_name) {
    writeIdentity({
      display_name: local.display_name || (session.name ?? ''),
      email: local.email || session.email,
    });
  }
  return { email: session.email, name: session.name };
}

/**
 * Sign this machine out and cut its account-side access.
 *
 * Not just "forget the bearer": the account's model credential is spendable and
 * was minted from this session, so it has to stop working at the service too —
 * for any copy that already left the machine. The result says plainly whether the
 * service confirmed that. The device is signed out either way, but an
 * unconfirmed revocation must never be reported as a completed one, because a
 * live token would be left drawing on the balance.
 */
export async function signOutAccount(): Promise<ModelAccessRevocation> {
  clearPendingSignIn();
  return await revokeDeviceAccess();
}

// ── Keeping workspaces in step ─────────────────────────────────────────────

export interface SyncAccountMembershipsInput {
  /** The `.lattice` root a newly-materialized workspace is registered in. */
  latticeRoot?: string | null;
  /**
   * How a membership becomes a workspace. A live session passes its own so the
   * open database can swap over too; leave it out and the workspace is registered
   * without opening anything, which is the whole job when nothing is live.
   */
  createCloudWorkspace?: MembershipSyncDeps['createCloudWorkspace'];
  /** How a cloud is checked for reachability. Injected by tests; defaults to the real probe. */
  probeCloud?: MembershipSyncDeps['probeCloud'];
}

/**
 * Materialize every active membership the account has that this machine does not
 * hold yet, and report the ones the service says were revoked.
 *
 * Idempotent: the session store records membership → local workspace, so running
 * it again skips what already exists. Per-membership failures are collected and
 * reported rather than aborting the pass — one unreachable database must not stop
 * the other three from arriving.
 */
export async function syncAccountMemberships(
  input: SyncAccountMembershipsInput = {},
): Promise<MembershipSyncResult> {
  const root = input.latticeRoot ?? null;
  return await syncMemberships({
    createCloudWorkspace:
      input.createCloudWorkspace ??
      ((displayName, key, url) => createCloudWorkspace(root, displayName, key, url)),
    probeCloud: input.probeCloud ?? probeCloudDefault,
  });
}

// ── Administering a hosted workspace ───────────────────────────────────────
//
// A hosted session delegates membership to the deployment's workspace manager
// instead of running the token machinery itself: this process never holds a
// manager credential, it calls its own per-session endpoint, and the manager
// enforces identity, ownership, and caps. The manager's own message comes back
// untouched, so a caller sees "Member limit reached." rather than a generic
// failure invented here.

/** One person on a hosted workspace, as the manager describes them. */
export interface ManagedMember {
  id: string;
  email: string;
  role: string;
  /** `active`, `invited`, or whatever else the manager distinguishes. */
  status: string;
}

/** The manager's answer to "who is on this workspace". */
export interface ManagedMembers {
  members: ManagedMember[];
}

/**
 * The manager's answer to an operation, passed through as it arrived.
 *
 * Deliberately not narrowed: the manager is a deployment's own service and may
 * say more than `{ ok: true }` — an invite id, a workspace id, a quota. Narrowing
 * it here would silently drop whatever it added.
 */
export type ManagedResult = Record<string, unknown>;

/** Refuse before calling out when this session has no manager to call. */
function requireManager(): void {
  if (!isManagedWorkspaces()) throw accountError('not_managed', NO_WORKSPACE_MANAGER);
}

/** Call the manager, tagging any refusal or transport failure as one. */
async function callManager<T>(
  path: 'invite' | 'members' | 'revoke' | 'create',
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  try {
    return await managerCall<T>(path, method, body);
  } catch (e) {
    throw accountError('manager_failed', (e as Error).message);
  }
}

/** List who is on this hosted workspace, including invites nobody has accepted yet. */
export async function listManagedMembers(): Promise<ManagedMembers> {
  requireManager();
  return await callManager<ManagedMembers>('members', 'GET');
}

/** Invite somebody to this hosted workspace by email. */
export async function inviteToManagedWorkspace(email: string): Promise<ManagedResult> {
  requireManager();
  const address = email.trim();
  if (!address) throw accountError('invalid_request', 'An email address is required to invite.');
  return await callManager<ManagedResult>('invite', 'POST', { email: address });
}

/** Remove somebody from this hosted workspace, by the membership the manager named. */
export async function revokeManagedMembership(membershipId: string): Promise<ManagedResult> {
  requireManager();
  const id = membershipId.trim();
  if (!id) throw accountError('invalid_request', 'A membership id is required to revoke.');
  return await callManager<ManagedResult>('revoke', 'POST', { membershipId: id });
}

/** Create another hosted workspace on this account. */
export async function createManagedWorkspace(name: string): Promise<ManagedResult> {
  requireManager();
  const label = name.trim();
  if (!label) throw accountError('invalid_request', 'A name is required to create a workspace.');
  return await callManager<ManagedResult>('create', 'POST', { name: label });
}
