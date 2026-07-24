import {
  IdentityAuthError,
  discoverIdentityService,
  fetchRemoteWorkspaces,
  fetchWorkspaceCredential,
} from './service.js';
import { clearIdentitySession, readIdentitySession, writeIdentitySession } from './store.js';

/**
 * Membership sync — invited (and owned) hosted workspaces appear on their own.
 *
 * On sign-in and periodically after, fetch the identity account's workspace
 * list; for each ACTIVE membership not yet materialized locally, obtain the
 * scoped credential over the authenticated channel and materialize a workspace
 * through the same join path token redemption uses (probe → createCloudWorkspace
 * with its sanitized-key + encrypted-credential semantics intact). One
 * membership = one workspace, preserving the per-viewer isolation invariant.
 *
 * Idempotent by bookkeeping: the session store records membershipId → local
 * workspace id, so repeated syncs skip what exists. A REVOKED membership is
 * surfaced (recorded + reported), never silently hidden — its workspace entry
 * simply stops connecting, which the open path reports on its own.
 */

export interface MembershipSyncDeps {
  /** The same primitive the dbconfig join path uses (server.ts threads it). */
  createCloudWorkspace: (displayName: string, key: string, url: string) => Promise<string>;
  /** Probe a cloud URL (reachability + is-a-lattice-cloud). */
  probeCloud: (url: string) => Promise<{ reachable: boolean; isCloud: boolean; error?: string }>;
}

export interface MembershipSyncResult {
  linked: boolean;
  added: { workspaceId: string; name: string }[];
  revoked: string[];
  skipped: number;
  errors: string[];
  /** True when the stored session was rejected (401) and has been cleared. */
  sessionExpired?: boolean;
}

/** Sanitize a display name into a credential-key slug (mirrors the join path). */
function slugifyKey(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'cloud';
}

export async function syncMemberships(deps: MembershipSyncDeps): Promise<MembershipSyncResult> {
  const none: MembershipSyncResult = {
    linked: false,
    added: [],
    revoked: [],
    skipped: 0,
    errors: [],
  };
  const session = readIdentitySession();
  if (!session) return none;
  const endpoints = await discoverIdentityService();
  if (!endpoints) return { ...none, linked: true, errors: ['identity service unreachable'] };

  let remote;
  try {
    remote = await fetchRemoteWorkspaces(endpoints, session.token);
  } catch (e) {
    if (e instanceof IdentityAuthError) {
      // The bearer was revoked or expired remotely — sign out locally and say so.
      clearIdentitySession();
      return { ...none, linked: false, sessionExpired: true, errors: [e.message] };
    }
    return { ...none, linked: true, errors: [(e as Error).message] };
  }

  const result: MembershipSyncResult = {
    linked: true,
    added: [],
    revoked: [],
    skipped: 0,
    errors: [],
  };
  const next = {
    ...session,
    materialized: { ...session.materialized },
    revoked: [...session.revoked],
  };

  for (const w of remote) {
    if (w.membershipStatus === 'revoked') {
      if (!next.revoked.includes(w.membershipId)) next.revoked.push(w.membershipId);
      result.revoked.push(w.name);
      continue;
    }
    if (w.membershipStatus !== 'active' || w.status !== 'active') continue;
    if (next.materialized[w.membershipId] !== undefined) {
      result.skipped++;
      continue;
    }
    try {
      const cred = await fetchWorkspaceCredential(endpoints, session.token, w.id);
      const probe = await deps.probeCloud(cred.connUrl);
      if (!probe.reachable || !probe.isCloud) {
        result.errors.push(`${w.name}: ${probe.error ?? 'cloud not reachable yet'}`);
        continue;
      }
      const label = w.name || cred.workspaceName;
      const workspaceId = await deps.createCloudWorkspace(label, slugifyKey(label), cred.connUrl);
      next.materialized[w.membershipId] = workspaceId;
      result.added.push({ workspaceId, name: label });
    } catch (e) {
      // Per-membership failures never abort the sync — the rest still lands.
      result.errors.push(`${w.name}: ${(e as Error).message}`);
    }
  }
  // A sign-out (or re-link) can land while this sync is in flight. Writing the
  // bookkeeping back unconditionally would RESURRECT the cleared session — so
  // re-check and only persist when the same session is still linked.
  const still = readIdentitySession();
  if (still?.token === session.token) writeIdentitySession(next);
  return result;
}
