/**
 * The account / identity service's public home — the marketing + sign-in site
 * for the hosted product, and the ONE origin the open-source client defaults to
 * for discovering an identity service (via its `.well-known` manifest). Any
 * other hosted specifics are DISCOVERED from that manifest or set via env
 * (`LATTICE_IDENTITY_URL` / `LATTICE_IDENTITY_MANIFEST`), so no internal
 * infrastructure is named here — only the public front door.
 */
export const ACCOUNT_HOME_ORIGIN = 'https://latticedesktop.com';
