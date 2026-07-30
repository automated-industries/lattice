import {
  type DbConfigContext,
  buildPostgresUrl,
  parseSaveBodyResult,
  rootForDbConfig,
} from './shared.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson, tryHandler } from '../http.js';
import { probeCloud, cloudRlsInstalled, canManageRoles } from '../../framework/cloud-connect.js';
import { secureCloud } from '../../cloud/setup.js';
import { assertNotManaged, MANAGED_REFUSAL } from '../../cloud/managed-guard.js';
import { inviteMember, removeMember } from '../../cloud/membership.js';
import { joinCloud, redeemCloudInvite, type CloudWorkspaceCreator } from '../../cloud/join.js';
import { migrateWorkspaceToCloud } from '../../cloud/migrate.js';
import { cloudCall, cloudStatusFor } from './cloud-status.js';
import { cloudErrorCode } from '../../cloud/errors.js';

/**
 * Report a failed join.
 *
 * The join answers carry an explicit `ok` flag — the client branches on it
 * rather than on the status — so a refusal has to be `{ ok: false, error }` and
 * not the bare `{ error }` the shared handler would write. The status still
 * comes from the one code-to-status map.
 *
 * A recognised refusal is logged as one line: we know exactly what happened
 * (the target was unreachable, the invite was spent) and a stack would only
 * bury it. An UNRECOGNISED failure is a real fault, and gets the full stack —
 * nothing is swallowed either way.
 */
function sendJoinFailure(res: ServerResponse, e: unknown): void {
  const err = e as Error;
  const code = cloudErrorCode(e);
  if (code === undefined) {
    console.error(`[gui] cloud join failed: ${err.message}\n${err.stack ?? ''}`);
  } else {
    console.warn(`[gui] cloud join refused (${code}): ${err.message}`);
  }
  sendJson(res, { ok: false, error: err.message }, cloudStatusFor(e));
}

/**
 * Serve `POST /api/cloud/redeem-invite`: read the email + token off the request
 * and hand them to the join capability.
 *
 * Exported so the GUI server can serve the same route from the zero-workspace
 * state too, where there is no active database to build a full context from — it
 * depends only on the workspace creator, which is database-independent (it opens
 * a NEW workspace for the cloud).
 */
export async function redeemInvite(
  createCloudWorkspace: CloudWorkspaceCreator,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await tryHandler(res, async () => {
    const body = await readJson(req);
    try {
      const result = await redeemCloudInvite({
        email: typeof body.email === 'string' ? body.email : '',
        token: typeof body.token === 'string' ? body.token : '',
        createCloudWorkspace,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
      });
      sendJson(res, { ok: true, ...result });
    } catch (e) {
      sendJoinFailure(res, e);
    }
  });
}

export async function dispatchCloudState(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DbConfigContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  // @capability cloud.probe
  if (pathname === '/api/dbconfig/probe' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsedResult = parseSaveBodyResult(body);
      if (!parsedResult.ok || parsedResult.value.type !== 'postgres') {
        // A validation failure is NOT a credentials failure — surface the specific
        // field so the user isn't sent to double-check correct host/port/user/password.
        // "Invalid Postgres credentials" is reserved for a real auth error from the server.
        const msg = !parsedResult.ok ? parsedResult.error : 'Expected Postgres connection details.';
        const field = !parsedResult.ok ? parsedResult.field : undefined;
        sendJson(res, { error: msg, field }, 400);
        return;
      }
      const parsed = parsedResult.value;
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      const result = await probeCloud(url);
      sendJson(res, result);
    });
    return true;
  }

  // @capability cloud.migrate
  if (pathname === '/api/dbconfig/migrate-to-cloud' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsedResult = parseSaveBodyResult(body);
      if (!parsedResult.ok || parsedResult.value.type !== 'postgres') {
        // A validation failure is NOT a credentials failure — surface the specific
        // field so the user isn't sent to double-check correct host/port/user/password.
        // "Invalid Postgres credentials" is reserved for a real auth error from the server.
        const msg = !parsedResult.ok ? parsedResult.error : 'Expected Postgres connection details.';
        const field = !parsedResult.ok ? parsedResult.field : undefined;
        sendJson(res, { error: msg, field }, 400);
        return;
      }
      const parsed = parsedResult.value;
      // parsed.label already satisfies the ${LATTICE_DB:…} charset (it was
      // normalized on the way in), so it is a valid credential key AND a
      // reasonable display name for the workspace it becomes.
      let result;
      try {
        result = await migrateWorkspaceToCloud({
          db: ctx.db,
          configPath: ctx.configPath,
          label: parsed.label,
          url: buildPostgresUrl({
            host: parsed.host,
            port: Number(parsed.port),
            dbname: parsed.dbname,
            user: parsed.user,
            password: parsed.password,
          }),
          latticeRoot: rootForDbConfig(ctx),
        });
      } catch (e) {
        // The refusals carry a code; a copy or cutover failure does not and stays
        // a 500. Either way the workspace is still on its old store — the
        // capability either refused before touching it or unwound what it did.
        sendJson(res, { ok: false, error: (e as Error).message }, cloudStatusFor(e));
        return;
      }

      // PAST THE POINT OF NO RETURN. The move has landed: the credential is
      // stored, the config names the shared database, the registry agrees, and
      // the local file has been renamed to `<db>.local-bak`. Only this session's
      // own connection is still on the old store, and reconnecting it is the last
      // thing left.
      //
      // A failure HERE is not a failed migration, and reporting it as one was a
      // silent data loss: the user was told to carry on, the session went on
      // writing into a renamed file nothing will ever open again, and the work
      // vanished at the next start. So the migration is reported as the success it
      // is, and the session that can no longer be trusted is closed — the welcome
      // screen and a reload are a visible, recoverable state; a live session
      // writing to a backup file is not.
      let sessionRestartRequired = false;
      let sessionError: string | undefined;
      try {
        await ctx.swap();
      } catch (e) {
        sessionRestartRequired = true;
        sessionError = (e as Error).message;
        console.error(
          `[gui] the migration completed but this session could not reconnect: ${sessionError}`,
        );
        await ctx.retire();
      }
      sendJson(res, {
        ok: true,
        label: result.label,
        credentialKey: result.credentialKey,
        tablesCopied: result.tablesCopied,
        rowsCopied: result.rowsCopied,
        sourceBackupPath: result.sourceBackupPath,
        blobsNotMigrated: result.blobsNotMigrated,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(sessionRestartRequired
          ? {
              sessionRestartRequired: true,
              sessionError,
              warning:
                `The workspace moved successfully, but this session could not reconnect to the ` +
                `shared database (${sessionError ?? 'unknown'}). It has been closed so nothing ` +
                `writes to the old file — reload to open the moved workspace.`,
            }
          : {}),
      });
    });
    return true;
  }

  // @capability cloud.join
  if (pathname === '/api/dbconfig/connect-existing' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsedResult = parseSaveBodyResult(body);
      if (!parsedResult.ok || parsedResult.value.type !== 'postgres') {
        // A validation failure is NOT a credentials failure — surface the specific
        // field so the user isn't sent to double-check correct host/port/user/password.
        // "Invalid Postgres credentials" is reserved for a real auth error from the server.
        const msg = !parsedResult.ok ? parsedResult.error : 'Expected Postgres connection details.';
        const field = !parsedResult.ok ? parsedResult.field : undefined;
        sendJson(res, { error: msg, field }, 400);
        return;
      }
      const parsed = parsedResult.value;
      // Join = connect DIRECTLY with the scoped credentials the owner issued
      // (the "invite" is those credentials). The capability probes, saves, and
      // swaps; the member role can't (and needn't) run DDL.
      try {
        const result = await joinCloud(
          {
            host: parsed.host,
            port: Number(parsed.port),
            dbname: parsed.dbname,
            user: parsed.user,
            password: parsed.password,
          },
          { label: parsed.label, createCloudWorkspace: ctx.createCloudWorkspace },
        );
        sendJson(res, { ok: true, ...result });
      } catch (e) {
        sendJoinFailure(res, e);
      }
    });
    return true;
  }

  // POST /api/cloud/invite — owner provisions a scoped member role and returns a
  // single email-bound, encrypted token carrying that scoped credential (the
  // member redeems it with their email in "Join a cloud"). Requires the connected
  // role to hold CREATEROLE (a cloud owner); members get a 403. No plaintext
  // credential leaves in the response except inside the opaque token.
  // @capability cloud.invite-member
  if (pathname === '/api/cloud/invite' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const result = await cloudCall(() =>
        inviteMember(ctx.db, {
          email: typeof body.email === 'string' ? body.email : '',
          configPath: ctx.configPath,
          latticeRoot: rootForDbConfig(ctx),
        }),
      );
      sendJson(res, { ok: true, ...result });
    });
    return true;
  }

  // POST /api/cloud/remove-member — owner-only: revoke a member's scoped role
  // (the GUI "Kick" control). Wires the previously-unreachable revokeMemberRole.
  // @capability cloud.remove-member
  if (pathname === '/api/cloud/remove-member' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const result = await cloudCall(() =>
        removeMember(ctx.db, typeof body.role === 'string' ? body.role : ''),
      );
      sendJson(res, { ok: true, ...result });
    });
    return true;
  }

  // POST /api/cloud/redeem-invite — the MEMBER side. Decrypt the email-bound
  // token locally with the invitee's email, reconstruct the SAME scoped
  // credential the owner minted, and join via the shared connect path. The UI
  // only ever handles email + token — never a postgres:// string. Delegated to
  // the exported `redeemInvite` so the GUI server can serve it from the virgin
  // state too (it depends only on createCloudWorkspace, not the active DB).
  // @capability cloud.redeem-invite
  if (pathname === '/api/cloud/redeem-invite' && method === 'POST') {
    await redeemInvite(ctx.createCloudWorkspace, req, res);
    return true;
  }

  // POST /api/cloud/secure — the existing-cloud cutover. Secure an
  // already-populated Postgres in place: install RLS + the observation substrate
  // and make the connecting role the owner of every existing row. Idempotent.
  // Owner-only (needs CREATEROLE + table ownership). Use this when you already
  // have data in a Postgres database and want to turn it INTO a Lattice cloud
  // without migrating from a local SQLite store first.
  // @capability cloud.secure
  if (pathname === '/api/cloud/secure' && method === 'POST') {
    await tryHandler(res, async () => {
      // A managed session's tenant is already provisioned + secured by the
      // manager; re-running secureCloud here is never the managed path. The
      // refusal is the SHARED one, so the command line cannot drift from it —
      // which is exactly what happened while this check lived here as a literal.
      try {
        assertNotManaged(undefined, MANAGED_REFUSAL.secure);
      } catch (e) {
        sendJson(res, { error: (e as Error).message }, cloudStatusFor(e));
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Only a Postgres database can be secured as a cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(
          res,
          { error: 'Securing a cloud requires a connection that can create roles' },
          403,
        );
        return;
      }
      const alreadyCloud = await cloudRlsInstalled(ctx.db);
      await secureCloud(ctx.db);
      await ctx.swap();
      sendJson(res, { ok: true, alreadyCloud, secured: true });
    });
    return true;
  }

  return false;
}
