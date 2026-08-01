import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from '../http.js';
import {
  completeAccountSignIn,
  createManagedWorkspace,
  inviteToManagedWorkspace,
  listManagedMembers,
  readAccountStatus,
  revokeManagedMembership,
  signOutAccount,
  startAccountSignIn,
  syncAccountMemberships,
} from '../../ops/account.js';
import { accountErrorCode, NO_WORKSPACE_MANAGER } from '../../ops/account-errors.js';
import { clearPendingSignIn, readPendingSignIn } from './store.js';
import { isManagedWorkspaces } from './managed.js';
import type { MembershipSyncDeps } from './sync.js';
import {
  humanizeIdentityError,
  humanizeIdentityUnavailable,
  identityStepOf,
  type IdentityStep,
} from '../ai/error-humanize.js';

/**
 * GUI-server routes for the account client (user-menu sign-in, both launchers)
 * and the hosted-workspace delegation.
 *
 * Every operation behind these routes is a call in `ops/account.ts`, reachable
 * from a command or a library with no server running. What stays here is what a
 * browser needs and a direct caller does not: reading the request, turning a
 * refusal into a status, and phrasing a failure for a person who is looking at a
 * screen rather than a stack trace.
 *
 * All state-changing routes are local-only by nature of the GUI server; the
 * loopback receiver additionally requires a pending request id that only this
 * machine holds.
 */

export interface IdentityRoutesDeps extends MembershipSyncDeps {
  pathname: string;
  method: string;
}

/**
 * Answer a failed sign-in leg with a sentence a person can act on, plus the machine
 * -readable step so the caller can react (the first-run wall offers the alternative
 * backends). The raw failure — endpoint, status, remote body — is logged by the
 * sign-in client where it is raised and never travels to the browser.
 *
 * `purpose: 'model'` marks the call as coming from the first-run wall, where a failed
 * sign-in is a DEAD END (no workspace exists yet, so the user cannot do anything at
 * all until a model is connected). That, and only that, gets the escape-hatch clause;
 * the header menu's sign-in is about workspaces and would only be muddied by it.
 */
function sendSignInFailure(
  res: ServerResponse,
  err: unknown,
  step: IdentityStep,
  purpose: unknown,
  status: number,
): void {
  const suggestAlternatives = purpose === 'model';
  sendJson(
    res,
    {
      error: humanizeIdentityError(err, { step, suggestAlternatives }),
      step: identityStepOf(err) ?? step,
      suggestAlternatives,
    },
    status,
  );
}

/**
 * The status a hosted-workspace refusal reads as on this transport.
 *
 * Nothing to delegate to is a 404 (the route does not exist for this session), a
 * request with nothing in it is a 400, and a manager that was reached and refused
 * is a 502 carrying the manager's own words — "Member limit reached." rather than
 * a sentence invented here. An untagged failure is a real fault and keeps the
 * same 502 it has always had.
 */
function sendManagedFailure(res: ServerResponse, err: unknown): void {
  const code = accountErrorCode(err);
  const status = code === 'not_managed' ? 404 : code === 'invalid_request' ? 400 : 502;
  sendJson(res, { error: (err as Error).message }, status);
}

export async function dispatchIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IdentityRoutesDeps,
): Promise<boolean> {
  const { pathname, method } = deps;

  // ── Loopback receiver: the browser hands the one-time code back here. ──
  // CORS-open on purpose: the approve page fetches this from the service's
  // origin. The code is single-use, bound to the pending request's secret held
  // only on this machine, and worthless without it.
  //
  // @gui-only interactive-consent: this is the redirect target the account service's
  // approval page calls from a browser once a person has approved the request, so
  // its only possible caller is that page. It is a convenience rather than a second
  // mechanism — the same operation without a browser is the paste-a-code path,
  // account.signin-complete, which is what this branch itself calls.
  if (pathname === '/lattice/device-code' && method === 'GET') {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    const rid = url.searchParams.get('rid') ?? '';
    const code = url.searchParams.get('code') ?? '';
    res.setHeader('access-control-allow-origin', '*');
    if (readPendingSignIn()?.requestId !== rid || !code) {
      sendJson(res, { ok: false, error: 'no matching sign-in in progress' }, 400);
      return true;
    }
    try {
      const who = await completeAccountSignIn(code);
      // Kick the first membership sync in the background — invited workspaces
      // appear without another click. Fire-and-forget; failures surface on the
      // next explicit sync/status call.
      void syncAccountMemberships(deps).catch(() => undefined);
      sendJson(res, { ok: true, email: who.email });
    } catch (e) {
      // The approve page in the browser renders this, so it gets the same treatment
      // as the in-app paths: humanized by cause, step named, no status code.
      sendJson(
        res,
        {
          ok: false,
          error: humanizeIdentityError(e, { step: 'exchange' }),
          step: identityStepOf(e) ?? 'exchange',
        },
        400,
      );
    }
    return true;
  }

  if (!pathname.startsWith('/api/identity/') && !pathname.startsWith('/api/cloud/managed/')) {
    return false;
  }

  // ── Status: linked identity + whether an account service is reachable. ──
  if (pathname === '/api/identity/status' && method === 'GET') {
    sendJson(res, await readAccountStatus());
    return true;
  }

  // Starting a sign-in returns a URL for a person to approve. The browser is one
  // way to reach that; a command is another, and both end at the same exchange.
  // @capability account.signin-start
  if (pathname === '/api/identity/signin/start' && method === 'POST') {
    const body = await readJson(req);
    // This server's own port is the loopback hand-back target, so the approval
    // page can return the code without anyone copying it. A caller with no server
    // passes no port, and the page shows the code to be pasted instead.
    const host = req.headers.host ?? '';
    const portMatch = /:(\d+)$/.exec(host);
    const redirectPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : null;
    try {
      const started = await startAccountSignIn({ redirectPort });
      sendJson(res, { ok: true, verifyUrl: started.verifyUrl });
    } catch (e) {
      // "No service at all" is its own answer: there is no failing leg to name and
      // no remote error to classify, so it gets the discovery wording.
      if (accountErrorCode(e) === 'service_unavailable') {
        const suggestAlternatives = body.purpose === 'model';
        sendJson(
          res,
          {
            error: humanizeIdentityUnavailable(suggestAlternatives),
            step: 'discovery',
            suggestAlternatives,
          },
          503,
        );
        return true;
      }
      sendSignInFailure(res, e, 'start', body.purpose, 502);
    }
    return true;
  }

  // @capability account.signin-complete
  if (pathname === '/api/identity/signin/complete' && method === 'POST') {
    const body = await readJson(req);
    try {
      const who = await completeAccountSignIn(typeof body.code === 'string' ? body.code : '');
      void syncAccountMemberships(deps).catch(() => undefined);
      sendJson(res, { ok: true, email: who.email, name: who.name });
    } catch (e) {
      sendSignInFailure(res, e, 'exchange', body.purpose, 400);
    }
    return true;
  }

  // ── Sign this device out. ──
  // Signing out is not just "forget the bearer": the account's model credential is
  // a spendable token minted from this session, so it has to stop working — here
  // AND at the service, for any copy that already left the machine. The response
  // says plainly whether the service confirmed the revoke: the device is signed
  // out either way, but an unconfirmed revocation must not be reported as a
  // completed one, because a live token would be left drawing on the balance.
  // @capability account.signout
  if (pathname === '/api/identity/signout' && method === 'POST') {
    const revocation = await signOutAccount();
    sendJson(res, {
      ok: true,
      modelAccess: revocation.revoked ? 'revoked' : 'not-confirmed',
      error: revocation.revoked ? null : revocation.error,
    });
    return true;
  }

  // Invited workspaces are materialized with the SESSION's workspace creator, so a
  // running app adopts the new workspace rather than merely registering it.
  // @capability account.sync-memberships
  if (pathname === '/api/identity/sync' && method === 'POST') {
    sendJson(res, await syncAccountMemberships(deps));
    return true;
  }

  // ── Hosted-workspace delegation (hosted sessions only). ──
  // The GUI never holds a manager credential: it calls its own per-session
  // manager endpoint, which enforces identity, ownership, and caps.
  if (pathname.startsWith('/api/cloud/managed/')) {
    if (!isManagedWorkspaces()) {
      sendJson(res, { error: NO_WORKSPACE_MANAGER }, 404);
      return true;
    }
    const op = pathname.slice('/api/cloud/managed/'.length);
    try {
      if (op === 'members' && method === 'GET') {
        sendJson(res, await listManagedMembers());
        return true;
      }
      // @capability account.invite-member
      if (op === 'invite' && method === 'POST') {
        const body = await readJson(req);
        sendJson(
          res,
          await inviteToManagedWorkspace(typeof body.email === 'string' ? body.email : ''),
        );
        return true;
      }
      // @capability account.remove-member
      if (op === 'revoke' && method === 'POST') {
        const body = await readJson(req);
        sendJson(
          res,
          await revokeManagedMembership(
            typeof body.membershipId === 'string' ? body.membershipId : '',
          ),
        );
        return true;
      }
      // @capability account.create-workspace
      if (op === 'create' && method === 'POST') {
        const body = await readJson(req);
        sendJson(res, await createManagedWorkspace(typeof body.name === 'string' ? body.name : ''));
        return true;
      }
    } catch (e) {
      sendManagedFailure(res, e);
      return true;
    }
    sendJson(res, { error: 'Unknown workspace-manager operation.' }, 404);
    return true;
  }

  return false;
}

/**
 * Test seam: forget any sign-in waiting for its code.
 *
 * Kept here under its original name so existing callers resolve, and delegating
 * to the store, which is where a pending sign-in lives now that one command can
 * start it and another can finish it.
 */
export function resetPendingSignIn(): void {
  clearPendingSignIn();
}
