import { discoverIdentityService, fetchModelCredential, revokeDeviceSession } from './service.js';
import { clearIdentitySession, readIdentitySession } from './store.js';
import { deleteAssistantCredential } from '../../framework/user-config.js';
import {
  setLatticeCloudConfig,
  readLatticeCloudConfig,
  clearLatticeCloudConfig,
  activeProviderKind,
  LATTICE_CLOUD_KIND,
  type StoredLatticeCloud,
} from '../ai/provider-config.js';

/**
 * Lattice Cloud account model credential — the bridge between the signed-in
 * identity session and the hosted metered proxy. Minting from the session (not a
 * raw account credential) keeps the proxy token scoped + short-lived, billed to
 * the account's Lattice Cloud balance, and revocable by signing the device out.
 */

/** Re-mint a Lattice Cloud model credential from the signed-in session and store
 *  it as the active provider. Null when there is no signed-in session, no
 *  reachable identity service, or the mint fails (the caller then falls back). */
export async function refreshLatticeCloudCredential(): Promise<StoredLatticeCloud | null> {
  const session = readIdentitySession();
  if (!session?.token) return null;
  const endpoints = await discoverIdentityService();
  if (!endpoints) return null;
  try {
    const issued = await fetchModelCredential(endpoints, session.token);
    const cfg: StoredLatticeCloud = {
      proxyBaseUrl: issued.proxyBaseUrl,
      token: issued.token,
      expiresAt: issued.expiresAt,
    };
    setLatticeCloudConfig(cfg); // also flips the active provider to lattice_cloud
    return cfg;
  } catch {
    // A transient service/mint failure just means "no cloud credential right
    // now" — the provider resolver falls back rather than bricking the assistant.
    return null;
  }
}

/** The stored cloud credential if still valid (with a small skew buffer); else
 *  re-mint from the session; else null. Used by the provider resolver. */
export async function currentLatticeCloudCredential(): Promise<StoredLatticeCloud | null> {
  const cfg = readLatticeCloudConfig();
  if (cfg && new Date(cfg.expiresAt).getTime() > Date.now() + 60_000) return cfg;
  return await refreshLatticeCloudCredential();
}

/**
 * The outcome of cutting a device's cloud model access. `revoked: false` carries
 * the reason: the local credential is always destroyed, but the account-side token
 * is only dead once the service says so, and a caller must not present an
 * unconfirmed revocation as a completed one.
 */
export type ModelAccessRevocation = { revoked: true } | { revoked: false; error: string };

/**
 * Sign this device out of the account and cut its model access — in this order,
 * which is the point of the function:
 *
 *  1. Capture the session bearer (the only thing that can authorize step 3).
 *  2. Destroy EVERY local credential — the stored proxy token and the session
 *     itself — before any network call. After this line the device can neither
 *     spend nor mint again, even if step 3 hangs or the process is killed.
 *  3. Ask the service to revoke the session, which invalidates every credential
 *     minted from it. Without this, a token that already left the machine keeps
 *     drawing on the account's balance until it happens to expire.
 *
 * The active-provider selection is only reset when the cloud account was the
 * backend in use: signing out of the account service must not silently move a
 * user off their own endpoint.
 */
export async function revokeDeviceAccess(): Promise<ModelAccessRevocation> {
  const bearer = readIdentitySession()?.token ?? null;
  if (activeProviderKind() === 'lattice_cloud') clearLatticeCloudConfig();
  else deleteAssistantCredential(LATTICE_CLOUD_KIND);
  clearIdentitySession();
  // No session means nothing was ever minted against one — there is no
  // account-side credential to revoke, and the local store is already clear.
  if (!bearer) return { revoked: true };
  const endpoints = await discoverIdentityService();
  if (!endpoints) {
    return {
      revoked: false,
      error:
        'Signed out on this device, but the account service could not be reached to revoke ' +
        "this device's access. Sign this device out from your account page as well.",
    };
  }
  try {
    await revokeDeviceSession(endpoints, bearer);
    return { revoked: true };
  } catch {
    // The failure detail (endpoint + status + remote body) is logged where it is
    // raised. What the caller needs is the fact that a spendable token may still
    // be live, and what to do about it.
    return {
      revoked: false,
      error:
        'Signed out on this device, but the account service did not confirm that this ' +
        "device's access was revoked. Sign this device out from your account page as well.",
    };
  }
}
