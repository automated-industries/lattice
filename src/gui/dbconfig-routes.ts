import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbConfigContext } from './dbconfig/shared.js';
import { dispatchConnection } from './dbconfig/connection-routes.js';
import { dispatchCloudState, redeemInvite } from './dbconfig/cloud-state-routes.js';
import { dispatchCloudSettings } from './dbconfig/cloud-settings-routes.js';

/**
 * Endpoints for the Project Config "Database" panel. They wrap three
 * operations:
 *
 *   - reading the currently-active DB shape (sqlite vs postgres + which
 *     label, with password redacted),
 *   - saving a new DB configuration (writes the encrypted credential to
 *     ~/.lattice/db-credentials.enc + updates the active YAML's `db:`
 *     line to `${LATTICE_DB:<label>}`),
 *   - testing a candidate connection without swapping the active DB,
 *   - swapping the active Lattice to the saved config (delegates to the
 *     caller-supplied `swap()` callback so the parent server's
 *     `active` reference stays the single source of truth).
 *
 * Auth model: localhost trust, identical to teams-routes / userconfig-routes.
 * team-cloud mode does not mount this dispatcher.
 *
 * The route handlers themselves live in the three sub-dispatchers under
 * `./dbconfig/`. This barrel composes them in order — first-true-wins, every
 * guard exact (pathname,method) equality, so no route can shadow another —
 * and re-exports the public surface (this module's path + exports are unchanged
 * for consumers like `server.ts` and the unit tests).
 */
export async function dispatchDbConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DbConfigContext,
): Promise<boolean> {
  return (
    (await dispatchConnection(req, res, ctx)) ||
    (await dispatchCloudState(req, res, ctx)) ||
    (await dispatchCloudSettings(req, res, ctx))
  );
}

export { redeemInvite };
export { buildPostgresUrl, parsePostgresUrl } from './dbconfig/shared.js';
export type { DbConfigState } from './dbconfig/connection-routes.js';
export { parseAndValidateLogo } from './dbconfig/cloud-settings-routes.js';
export type { LogoParse } from './dbconfig/cloud-settings-routes.js';
