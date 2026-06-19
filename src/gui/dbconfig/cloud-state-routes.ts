import {
  type DbConfigContext,
  buildPostgresUrl,
  parsePostgresUrl,
  parseSaveBody,
  rewriteDbLine,
} from './shared.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { randomUUID } from 'node:crypto';
import { sendJson, readJson, tryHandler } from '../http.js';
import {
  getDbCredential,
  saveDbCredential,
  getOrCreateMasterKey,
} from '../../framework/user-config.js';
import {
  probeCloud,
  cloudRlsInstalled,
  canManageRoles,
  claimMemberInvite,
} from '../../framework/cloud-connect.js';
import { secureCloud } from '../../cloud/setup.js';
import { publishSharedSchema } from '../../cloud/shared-schema.js';
import { getOrCreateInviteSalt, hashInviteEmail } from '../../cloud/settings.js';
import {
  provisionMemberRole,
  generateMemberPassword,
  memberRoleName,
  assertScopedMemberRole,
  revokeMemberRole,
} from '../../cloud/members.js';
import { mintInviteToken, redeemInviteToken, poolerAwareUser } from '../../cloud/invite.js';
import { slugify } from '../../render/markdown.js';
import { getAsyncOrSync, runAsyncOrSync, allAsyncOrSync } from '../../db/adapter.js';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
} from '../../framework/cloud-migration.js';
import { parseConfigFile } from '../../config/parser.js';
import { findLatticeRoot } from '../../framework/lattice-root.js';
import { getActiveWorkspace, registerOrUpdateCloudWorkspace } from '../../framework/workspace.js';
import { resolveContextDirForConfig } from '../../framework/gui-bootstrap.js';

/**
 * After the active config's `db:` line is rewritten to point at a cloud
 * credential, flip its workspace registry record to cloud in place (same id) so
 * the header switcher + Settings reflect that this workspace is now cloud. No-op
 * when not running inside a `.lattice` root.
 */
function updateActiveWorkspaceToCloud(configPath: string, displayName: string, key: string): void {
  const root = findLatticeRoot(dirname(configPath));
  if (!root) return;
  registerOrUpdateCloudWorkspace(root, {
    configPath,
    contextDir: resolveContextDirForConfig(configPath),
    displayName,
    // The credential key + ${LATTICE_DB:…} reference must be a SANITIZED,
    // space-free label (resolveDbPath rejects anything else); the human
    // displayName is separate.
    db: '${LATTICE_DB:' + key + '}',
    makeActive: true,
  });
}

/**
 * #3.4 — orphan-role cleanup, run by the owner at invite time (the owner holds
 * CREATEROLE here). Two passes, both stamping `revoked_at` and dropping the scoped
 * role so it can never be redeemed and never piles up:
 *   1. RE-INVITE: any still-PENDING invite for THIS email (un-redeemed,
 *      un-revoked) — re-inviting mints a fresh suffixed role, so without this the
 *      prior role is orphaned AND its old token stays live. Revoking it makes the
 *      newest invite the only valid one.
 *   2. SWEEP: any pending invite that has EXPIRED — its role would otherwise
 *      linger forever (invites have a TTL but nothing dropped the role on expiry).
 * `revokeMemberRole` is idempotent on an already-gone role, so a stale invite
 * whose role was dropped elsewhere just gets its `revoked_at` stamped. Failures
 * surface (internal guideline) — a re-invite must not silently leave a live orphan behind.
 */
async function reclaimStaleInviteRoles(
  db: DbConfigContext['db'],
  emailHash: string,
): Promise<void> {
  const stale = (await allAsyncOrSync(
    db.adapter,
    `SELECT DISTINCT "role" FROM "__lattice_member_invites"
       WHERE "redeemed_at" IS NULL AND "revoked_at" IS NULL
         AND ("email_hash" = ? OR "expires_at" <= now())`,
    [emailHash],
  )) as { role: string }[];
  for (const { role } of stale) {
    await revokeMemberRole(db, role);
    await runAsyncOrSync(
      db.adapter,
      `UPDATE "__lattice_member_invites" SET "revoked_at" = now()
         WHERE "role" = ? AND "revoked_at" IS NULL`,
      [role],
    );
  }
}

/**
 * Join an existing Lattice cloud as a scoped member: probe the connection, then
 * persist the encrypted credential, point the workspace at it, and swap the
 * active DB. Shared by the manual `connect-existing` flow and the email-bound
 * `redeem-invite` flow so both take the IDENTICAL path (probe → save → swap) —
 * the member connects directly as their scoped role under RLS, exactly as today.
 */
async function joinCloudAsMember(
  createCloudWorkspace: DbConfigContext['createCloudWorkspace'],
  res: ServerResponse,
  fields: { host: string; port: number; dbname: string; user: string; password: string },
  label: string,
  opts: { claimInvite?: boolean } = {},
): Promise<void> {
  const url = buildPostgresUrl(fields);
  const probe = await probeCloud(url);
  if (!probe.reachable) {
    sendJson(res, { ok: false, error: probe.error ?? 'Cloud DB unreachable' }, 502);
    return;
  }
  if (!probe.isCloud) {
    sendJson(
      res,
      {
        ok: false,
        error:
          'That Postgres database is not a Lattice cloud yet. The owner must migrate a local Lattice into it first.',
      },
      409,
    );
    return;
  }
  // #3.1 — one-time-use + revocation. On the email-bound redeem path, atomically
  // CLAIM the invite as the member (stamp redeemed_at) BEFORE creating the
  // workspace. A replayed/leaked token, a revoked invite, or an expired one is
  // rejected here — and because the workspace hasn't been created yet, there is
  // nothing to roll back (atomic by construction). The manual connect-existing
  // flow has no invite row and skips this.
  if (opts.claimInvite) {
    const claim = await claimMemberInvite(url);
    if (!claim.claimed) {
      sendJson(
        res,
        {
          ok: false,
          error:
            claim.error ??
            'This invite has already been used, was revoked, or has expired. Ask the owner for a new one.',
        },
        403,
      );
      return;
    }
  }
  // Create a NEW workspace for the cloud and switch to it — never repoint
  // (hijack) the currently-open workspace, which previously overwrote the user's
  // existing local workspace (wrong name, orphaned data, no switcher entry).
  // The credential key + ${LATTICE_DB:…} reference MUST be a sanitized,
  // space-free label or resolveDbPath rejects it (the default "Cloud workspace"
  // — with a space — never resolved, silently dropping the member on an empty
  // local DB). Sanitize the key; keep the human label as the display name.
  const key = slugify(label) || 'cloud';
  try {
    const workspaceId = await createCloudWorkspace(label, key, url);
    sendJson(res, { ok: true, label, isCloud: true, workspaceId });
  } catch (e) {
    sendJson(res, { ok: false, error: (e as Error).message }, 500);
  }
}

/**
 * The full `POST /api/cloud/redeem-invite` body: decrypt the email-bound token,
 * then join via {@link joinCloudAsMember}. Exported so the GUI server can serve it
 * from the zero-workspace "virgin" state too (where there is no active DB to build
 * a full DbConfigContext) — it depends only on `createCloudWorkspace`, which is
 * DB-independent (it opens a NEW workspace for the cloud).
 */
export async function redeemInvite(
  createCloudWorkspace: DbConfigContext['createCloudWorkspace'],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await tryHandler(res, async () => {
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!email || !token) {
      sendJson(
        res,
        { ok: false, error: 'Enter the email this invite was sent to and the invite token.' },
        400,
      );
      return;
    }
    let payload;
    try {
      payload = redeemInviteToken(email, token);
    } catch (e) {
      sendJson(res, { ok: false, error: (e as Error).message }, 400);
      return;
    }
    const fromCloud = payload.workspace_name?.trim() ?? '';
    const fromBody = typeof body.label === 'string' ? body.label.trim() : '';
    const label =
      fromCloud.length > 0 ? fromCloud : fromBody.length > 0 ? fromBody : 'Cloud workspace';
    await joinCloudAsMember(
      createCloudWorkspace,
      res,
      {
        host: payload.host,
        port: payload.port,
        dbname: payload.dbname,
        user: payload.user,
        password: payload.password,
      },
      label,
      { claimInvite: true },
    );
  });
}

/** Host/port/dbname of the active cloud connection, read from the saved
 *  credential (label form) or the raw `db:` URL. null when the active DB isn't a
 *  Postgres URL. */
function activeCloudCoords(
  configPath: string,
): { host: string; port: number; dbname: string; user: string } | null {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const rawDb = doc.get('db');
  const dbLine = typeof rawDb === 'string' ? rawDb.trim() : '';
  const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(dbLine);
  const url = labelMatch ? getDbCredential(labelMatch[1] ?? '') : dbLine;
  if (!url) return null;
  const parsed = parsePostgresUrl(url);
  // Keep `user` too: on the Supabase pooler the tenant ref lives ONLY in the
  // connection-string username (`postgres.<ref>`), never in session_user (which
  // returns the bare role). poolerAwareUser needs it to mint a connectable
  // member username.
  return parsed
    ? { host: parsed.host, port: parsed.port, dbname: parsed.dbname, user: parsed.user }
    : null;
}

export async function dispatchCloudState(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DbConfigContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  if (pathname === '/api/dbconfig/probe' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
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

  if (pathname === '/api/dbconfig/migrate-to-cloud' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
      const url = buildPostgresUrl({
        host: parsed.host,
        port: Number(parsed.port),
        dbname: parsed.dbname,
        user: parsed.user,
        password: parsed.password,
      });
      // Probe first — refuse if unreachable or the target is already a
      // secured cloud (migrating into it would mix two owners' data).
      const probe = await probeCloud(url);
      if (!probe.reachable) {
        sendJson(res, { ok: false, error: probe.error ?? 'Cloud DB unreachable' }, 502);
        return;
      }
      if (probe.isCloud) {
        sendJson(
          res,
          {
            ok: false,
            error:
              'Target is already a Lattice cloud — migration aborts to avoid mixing data. Join it instead.',
          },
          409,
        );
        return;
      }
      // Open a target Lattice matching the source's schema, run the
      // copy, close, archive, rewrite YAML, swap.
      const encryptionKey = getOrCreateMasterKey();
      const target = await openTargetLatticeForMigration(ctx.configPath, url, encryptionKey);
      try {
        const result = await migrateLatticeData(ctx.db, target);
        // Build the full-text indexes on the cloud AFTER the rows are copied — the
        // migrate copy doesn't run init's FTS step, which otherwise leaves the
        // cloud with all the data but no `__lattice_fts_*` index, so search and the
        // assistant find nothing. Idempotent + backfills the just-copied rows.
        await target.rebuildFtsIndexes();
        // Owner-side cloud setup: the migrator's connection owns the cloud, so it
        // installs RLS + the observation substrate and stamps itself as owner of
        // every just-migrated row. Each member later sees only its own rows
        // (private by default) until the owner shares them; chat / secrets /
        // history are isolated the same way; per-viewer enrichment observations
        // are gated by source visibility.
        await secureCloud(target);
        // Publish the migrated config's entity/render layout so a joined member can
        // hydrate the full context tree from it. ctx.configPath is the source config
        // being migrated (target was opened against this same config's schema).
        await publishSharedSchema(target, ctx.configPath);
        target.close();
        const sourceDbPath = parseConfigFile(ctx.configPath).dbPath;
        const backupPath = archiveLocalSqlite(sourceDbPath);
        saveDbCredential(parsed.label, url);
        rewriteDbLine(ctx.configPath, '${LATTICE_DB:' + parsed.label + '}');
        // parsed.label already satisfies the ${LATTICE_DB:…} charset (it was
        // parsed from one), so it's a valid key + a fine display name.
        updateActiveWorkspaceToCloud(ctx.configPath, parsed.label, parsed.label);
        await ctx.swap();
        sendJson(res, {
          ok: true,
          label: parsed.label,
          tablesCopied: result.tablesCopied,
          rowsCopied: result.rowsCopied,
          sourceBackupPath: backupPath,
          blobsNotMigrated: result.blobsNotMigrated,
          ...(result.blobsNotMigrated
            ? {
                warning: `${result.blobsNotMigrated.toString()} file(s) point at local bytes left behind on this machine and will not be reachable for cloud members.`,
              }
            : {}),
        });
      } catch (e) {
        try {
          target.close();
        } catch {
          // best-effort
        }
        // Migration failed: do NOT touch YAML or rename the source.
        sendJson(res, { ok: false, error: (e as Error).message }, 500);
      }
    });
    return true;
  }

  if (pathname === '/api/dbconfig/connect-existing' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const parsed = parseSaveBody(body);
      if (parsed?.type !== 'postgres') {
        sendJson(res, { error: 'Invalid Postgres credentials' }, 400);
        return;
      }
      try {
        // Join = connect DIRECTLY with the scoped credentials the owner issued
        // (the "invite" is those credentials). joinCloudAsMember probes, saves,
        // and swaps; the member role can't (and needn't) run DDL.
        await joinCloudAsMember(
          ctx.createCloudWorkspace,
          res,
          {
            host: parsed.host,
            port: Number(parsed.port),
            dbname: parsed.dbname,
            user: parsed.user,
            password: parsed.password,
          },
          parsed.label,
        );
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        sendJson(res, { ok: false, error: (e as Error).message }, status);
      }
    });
    return true;
  }

  // POST /api/cloud/invite — owner provisions a scoped member role and returns a
  // single email-bound, encrypted token carrying that scoped credential (the
  // member redeems it with their email in "Join a cloud"). Requires the connected
  // role to hold CREATEROLE (a cloud owner); members get a 403. No plaintext
  // credential leaves in the response except inside the opaque token.
  if (pathname === '/api/cloud/invite' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can invite members' }, 403);
        return;
      }
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        sendJson(res, { error: 'A valid invitee email is required' }, 400);
        return;
      }
      const coords = activeCloudCoords(ctx.configPath);
      if (!coords) {
        sendJson(res, { error: 'Could not resolve the cloud connection coordinates' }, 500);
        return;
      }
      // #4.10 — salt the audit email hash with a stable per-cloud salt (a bare
      // SHA-256 is rainbow-tableable). The salt is generated once + persisted, so
      // the hash stays a stable lookup key for re-invite / orphan cleanup.
      const emailHash = hashInviteEmail(await getOrCreateInviteSalt(ctx.db), email);
      // #3.4 — before minting a fresh role, revoke any prior PENDING invite for
      // this email (a re-invite would otherwise orphan the previous role + leave
      // its token live) and sweep any expired-but-unredeemed orphans. Runs as the
      // owner (who holds CREATEROLE) so the role drops actually take effect.
      await reclaimStaleInviteRoles(ctx.db, emailHash);
      // Provision a fresh scoped role, then HARD-ASSERT it is non-privileged
      // before embedding it in a token (security non-regression — never a
      // superuser / CREATEROLE / BYPASSRLS / owner role).
      const role = memberRoleName(email);
      const password = generateMemberPassword();
      await provisionMemberRole(ctx.db, role, password);
      await assertScopedMemberRole(ctx.db, role);
      // Bake the pooler-correct user from the owner's CONNECTION-STRING username
      // (postgres.<ref>), NOT session_user — on the Supabase pooler session_user
      // is the bare role with no tenant ref, which yields an unconnectable member
      // username (ENOIDENTIFIER). coords.user carries the ref.
      const user = poolerAwareUser(coords.host, role, coords.user);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      // Stamp the owner's cloud (workspace) name so the member's new workspace is
      // named after the cloud, not a generic default (1.3a).
      const inviteRoot = findLatticeRoot(dirname(ctx.configPath));
      const ownerWs = inviteRoot ? getActiveWorkspace(inviteRoot) : null;
      const token = mintInviteToken({
        coords,
        user,
        password,
        role,
        email,
        expiresAt,
        ...(ownerWs?.displayName ? { workspaceName: ownerWs.displayName } : {}),
      });
      // Owner-only audit row. Plaintext email + password are NEVER stored — only a
      // hash of the email and the role name (for later revocation).
      await runAsyncOrSync(
        ctx.db.adapter,
        `INSERT INTO "__lattice_member_invites" ("id","role","email_hash","email","expires_at")
           VALUES (?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          role,
          emailHash,
          // Plaintext email stored ONLY in this owner-only table so the owner's
          // Members list can show who each member is (the hash above stays for
          // tamper-evident audit; the password is still never stored anywhere).
          email.trim().toLowerCase(),
          expiresAt.toISOString(),
        ],
      );
      sendJson(res, { ok: true, token, role, email });
    });
    return true;
  }

  // POST /api/cloud/remove-member — owner-only: revoke a member's scoped role
  // (the GUI "Kick" control). Wires the previously-unreachable revokeMemberRole.
  if (pathname === '/api/cloud/remove-member' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can remove members' }, 403);
        return;
      }
      const body = await readJson(req);
      const role = typeof body.role === 'string' ? body.role : '';
      if (!role) {
        sendJson(res, { error: 'A member role is required' }, 400);
        return;
      }
      const me = (await getAsyncOrSync(ctx.db.adapter, `SELECT session_user AS u`)) as
        | { u?: string }
        | undefined;
      if (role === (me?.u ?? '')) {
        sendJson(res, { error: 'You cannot remove yourself (the owner)' }, 400);
        return;
      }
      // revokeMemberRole reassigns/drops the member's objects then the role and
      // SURFACES failures (internal guideline) — e.g. Supabase "permission denied to drop
      // objects" — instead of swallowing them; tryHandler turns a throw into a
      // 500 the GUI shows. If it succeeds, mark the audit invites revoked.
      await revokeMemberRole(ctx.db, role);
      await runAsyncOrSync(
        ctx.db.adapter,
        `UPDATE "__lattice_member_invites" SET "revoked_at" = now() WHERE "role" = ? AND "revoked_at" IS NULL`,
        [role],
      ).catch((e: unknown) => {
        // Best-effort audit only — the role IS already revoked; log, don't fail.
        console.error('[cloud] mark invite revoked failed:', (e as Error).message);
      });
      sendJson(res, { ok: true, role });
    });
    return true;
  }

  // POST /api/cloud/redeem-invite — the MEMBER side. Decrypt the email-bound
  // token locally with the invitee's email, reconstruct the SAME scoped
  // credential the owner minted, and join via the shared connect path. The UI
  // only ever handles email + token — never a postgres:// string. Delegated to
  // the exported `redeemInvite` so the GUI server can serve it from the virgin
  // state too (it depends only on createCloudWorkspace, not the active DB).
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
  if (pathname === '/api/cloud/secure' && method === 'POST') {
    await tryHandler(res, async () => {
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
