import { discoverIdentityService, fetchModelCredential } from './service.js';
import { readIdentitySession } from './store.js';
import {
  setLatticeCloudConfig,
  readLatticeCloudConfig,
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
