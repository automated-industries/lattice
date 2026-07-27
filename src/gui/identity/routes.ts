import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { readJson, sendJson } from '../http.js';
import { readIdentity, writeIdentity } from '../../framework/user-config.js';
import {
  discoverIdentityService,
  exchangeSignIn,
  startSignIn,
  type IdentityEndpoints,
} from './service.js';
import { readIdentitySession, writeIdentitySession } from './store.js';
import { revokeDeviceAccess } from './model.js';
import { syncMemberships, type MembershipSyncDeps } from './sync.js';
import { isManagedWorkspaces, managerCall } from './managed.js';
import {
  humanizeIdentityError,
  humanizeIdentityUnavailable,
  identityStepOf,
  type IdentityStep,
} from '../ai/error-humanize.js';

/**
 * GUI-server routes for the identity client (user-menu sign-in, both launchers)
 * and the managed-workspace delegation. All state-changing routes are local-only
 * by nature of the GUI server; the loopback receiver additionally requires a
 * pending request id that only this process knows.
 */

export interface IdentityRoutesDeps extends MembershipSyncDeps {
  pathname: string;
  method: string;
}

interface PendingSignIn {
  requestId: string;
  requestSecret: string;
  endpoints: IdentityEndpoints;
  startedAt: number;
}
let pending: PendingSignIn | null = null;
const PENDING_TTL_MS = 20 * 60 * 1000;

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

/** Complete a sign-in: exchange the code, persist the session, link identity. */
async function completeSignIn(code: string): Promise<{ email: string; name: string | null }> {
  if (!pending || Date.now() - pending.startedAt > PENDING_TTL_MS) {
    throw new Error('No sign-in in progress — start again from the user menu.');
  }
  const p = pending;
  const session = await exchangeSignIn(p.endpoints, p.requestId, p.requestSecret, code.trim());
  pending = null;
  writeIdentitySession({
    token: session.token,
    email: session.email,
    name: session.name,
    serviceBase: p.endpoints.base,
    linkedAt: new Date().toISOString(),
    materialized: {},
    revoked: [],
  });
  // The linked identity becomes the local identity where none was set — chat
  // attribution, member identity, and the invite flows all see one email.
  const local = readIdentity();
  if (!local.email || !local.display_name) {
    writeIdentity({
      display_name: local.display_name || (session.name ?? ''),
      email: local.email || session.email,
    });
  }
  return { email: session.email, name: session.name };
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
  // only in this process, and worthless without it.
  if (pathname === '/lattice/device-code' && method === 'GET') {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    const rid = url.searchParams.get('rid') ?? '';
    const code = url.searchParams.get('code') ?? '';
    res.setHeader('access-control-allow-origin', '*');
    if (pending?.requestId !== rid || !code) {
      sendJson(res, { ok: false, error: 'no matching sign-in in progress' }, 400);
      return true;
    }
    try {
      const who = await completeSignIn(code);
      // Kick the first membership sync in the background — invited workspaces
      // appear without another click. Fire-and-forget; failures surface on the
      // next explicit sync/status call.
      void syncMemberships(deps).catch(() => undefined);
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

  // ── Status: linked identity + whether an identity service is reachable. ──
  if (pathname === '/api/identity/status' && method === 'GET') {
    const session = readIdentitySession();
    const endpoints = await discoverIdentityService();
    sendJson(res, {
      linked: !!session,
      email: session?.email ?? null,
      name: session?.name ?? null,
      serviceAvailable: endpoints !== null,
      accountUrl: endpoints?.account ?? null,
      managedWorkspaces: isManagedWorkspaces(),
    });
    return true;
  }

  if (pathname === '/api/identity/signin/start' && method === 'POST') {
    const body = await readJson(req);
    const endpoints = await discoverIdentityService();
    if (!endpoints) {
      const suggestAlternatives = body.purpose === 'model';
      console.warn('[lattice] identity step "discovery" failed: no service manifest resolved');
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
    // The GUI server's own port is the loopback hand-back target.
    const host = req.headers.host ?? '';
    const portMatch = /:(\d+)$/.exec(host);
    const redirectPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : null;
    try {
      const started = await startSignIn(endpoints, `Lattice on ${hostname()}`, redirectPort);
      pending = {
        requestId: started.requestId,
        requestSecret: started.requestSecret,
        endpoints,
        startedAt: Date.now(),
      };
      sendJson(res, { ok: true, verifyUrl: started.verifyUrl });
    } catch (e) {
      sendSignInFailure(res, e, 'start', body.purpose, 502);
    }
    return true;
  }

  if (pathname === '/api/identity/signin/complete' && method === 'POST') {
    const body = await readJson(req);
    try {
      const who = await completeSignIn(typeof body.code === 'string' ? body.code : '');
      void syncMemberships(deps).catch(() => undefined);
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
  if (pathname === '/api/identity/signout' && method === 'POST') {
    pending = null;
    const revocation = await revokeDeviceAccess();
    sendJson(res, {
      ok: true,
      modelAccess: revocation.revoked ? 'revoked' : 'not-confirmed',
      error: revocation.revoked ? null : revocation.error,
    });
    return true;
  }

  if (pathname === '/api/identity/sync' && method === 'POST') {
    const result = await syncMemberships(deps);
    sendJson(res, result);
    return true;
  }

  // ── Managed-workspace delegation (hosted sessions only). ──
  // The GUI never holds a manager credential: it calls its own per-session
  // manager endpoint, which enforces identity, ownership, and caps.
  if (pathname.startsWith('/api/cloud/managed/')) {
    if (!isManagedWorkspaces()) {
      sendJson(res, { error: 'No workspace manager is configured for this session.' }, 404);
      return true;
    }
    const op = pathname.slice('/api/cloud/managed/'.length);
    try {
      if (op === 'members' && method === 'GET') {
        sendJson(res, await managerCall('members', 'GET'));
        return true;
      }
      if (op === 'invite' && method === 'POST') {
        const body = await readJson(req);
        sendJson(
          res,
          await managerCall('invite', 'POST', {
            email: typeof body.email === 'string' ? body.email : '',
          }),
        );
        return true;
      }
      if (op === 'revoke' && method === 'POST') {
        const body = await readJson(req);
        sendJson(
          res,
          await managerCall('revoke', 'POST', {
            membershipId: typeof body.membershipId === 'string' ? body.membershipId : '',
          }),
        );
        return true;
      }
      if (op === 'create' && method === 'POST') {
        const body = await readJson(req);
        sendJson(
          res,
          await managerCall('create', 'POST', {
            name: typeof body.name === 'string' ? body.name : '',
          }),
        );
        return true;
      }
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 502);
      return true;
    }
    sendJson(res, { error: 'Unknown workspace-manager operation.' }, 404);
    return true;
  }

  return false;
}

/** Test seam: reset the module's pending sign-in state. */
export function resetPendingSignIn(): void {
  pending = null;
}
