import { isManagedWorkspaces } from '../gui/identity/managed.js';
import { cloudError } from './errors.js';

/**
 * The managed-session refusal, in one place.
 *
 * Some deployments hand workspace management to a manager: it provisions the
 * database, secures it, and owns who is on it. An operation run locally in that
 * situation is not merely redundant — it produces state the manager's records
 * never saw. A role minted here is a member invisible to the manager's own list,
 * its revoke flow and its teardown; a re-secure re-runs the security bootstrap,
 * re-stamps row ownership and re-privatizes shared rows on a database that was
 * already provisioned and secured for the account.
 *
 * So it is refused, hard, everywhere it can be reached from.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT A CHECK PER CALLER. It was a check per
 * caller, written inline in the request handlers, and the moment the operations
 * behind those handlers became callable without one, the copy went with two of
 * them and not the third. That is the failure this file exists to make
 * impossible: one definition, one message per operation, and every surface —
 * a request, a command, a library call — reaching the same refusal.
 *
 * Overridable per call for exactly one reason: a caller that already knows which
 * kind of session it is (a test, or a manager driving this itself) should not
 * have to reach through a process-wide environment variable to say so.
 */
export function assertNotManaged(managed: boolean | undefined, message: string): void {
  if (managed ?? isManagedWorkspaces()) throw cloudError('cloud_managed', message);
}

/**
 * The wording each managed refusal uses, so the command line and the browser app
 * say the same thing about the same situation.
 */
export const MANAGED_REFUSAL = {
  invite: 'This workspace is managed — invite members by email from Workspace settings.',
  remove: 'This workspace is managed — remove members from the members list.',
  secure:
    'This workspace is managed by your team — its database is already provisioned and ' +
    'secured for you, so securing it again is never the right move here.',
} as const;
