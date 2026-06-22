import type { DbConfigContext } from './shared.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { sendJson, readJson, tryHandler } from '../http.js';
import { getS3ConfigRaw, saveS3ConfigRaw } from '../../framework/user-config.js';
import { activeWorkspaceLabel, mergeS3ConfigForSave } from '../../framework/s3-config.js';
import { cloudRlsInstalled, canManageRoles } from '../../framework/cloud-connect.js';
import {
  installCloudSettings,
  getCloudSetting,
  getCloudSettingStrict,
  setCloudSetting,
  CLOUD_SETTING_SYSTEM_PROMPT,
  CLOUD_SETTING_WORKSPACE_LOGO,
  CLOUD_SETTING_WORKSPACE_LOGO_ETAG,
} from '../../cloud/settings.js';
import { setRowVisibility, grantRow, revokeRow, batchRowGrants } from '../../cloud/members.js';
import { memberGroupFor } from '../../cloud/rls.js';
import { getAsyncOrSync, allAsyncOrSync } from '../../db/adapter.js';

/** Generous upper bound on the stored chat system prompt — well past any real
 *  house-style/domain preamble, but it stops an accidental multi-MB paste from
 *  bloating every member's turn (and the model context). Owner-only input. */
const MAX_SYSTEM_PROMPT_CHARS = 100_000;

/** Max decoded logo size — 64 KB (~88 KB base64, under the 1 MB JSON body cap). */
const MAX_LOGO_BYTES = 65_536;
/** Allowed logo image types. SVG is excluded — it can carry script (stored XSS). */
const LOGO_MIMES = ['image/png', 'image/jpeg'] as const;

/** Result of validating an uploaded workspace logo data: URI. */
export type LogoParse =
  | { ok: true; mime: 'image/png' | 'image/jpeg'; bytes: Buffer; etag: string }
  | { ok: false; error: string };

/** Pixel dimensions of a PNG (IHDR) or JPEG (first SOF marker), or null if unreadable. */
function imageDimensions(mime: string, b: Buffer): { width: number; height: number } | null {
  if (mime === 'image/png') {
    // IHDR is the first chunk: 8-byte signature, 4-byte length, 'IHDR', then
    // width@16 / height@20 as big-endian uint32.
    if (b.length < 24) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments to the first Start-Of-Frame (SOFn).
  let off = 2; // skip the SOI (FFD8)
  while (off + 9 <= b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      off += 2;
      continue;
    }
    const segLen = ((b[off + 2] ?? 0) << 8) | (b[off + 3] ?? 0);
    if (segLen < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF payload: precision(1), height(2), width(2).
      const height = ((b[off + 5] ?? 0) << 8) | (b[off + 6] ?? 0);
      const width = ((b[off + 7] ?? 0) << 8) | (b[off + 8] ?? 0);
      return { width, height };
    }
    off += 2 + segLen;
  }
  return null;
}

/**
 * Validate an owner-uploaded workspace logo data: URI. Accepts ONLY square
 * `image/png` or `image/jpeg` (validated by both the declared MIME AND the magic
 * bytes — a declared image can't actually be HTML), decoded ≤ {@link MAX_LOGO_BYTES}.
 * SVG is rejected by construction (not in {@link LOGO_MIMES}) — it can carry script
 * and would execute in every member's GUI (stored XSS). Pure + exported for unit
 * tests. Returns a validated `{ mime, bytes, etag }` or a `{ ok:false, error }`.
 */
export function parseAndValidateLogo(dataUri: unknown): LogoParse {
  if (typeof dataUri !== 'string') return { ok: false, error: 'logo must be a data: URI string' };
  const m = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri.trim());
  if (!m)
    return { ok: false, error: 'logo must be a base64 data: URI of type image/png or image/jpeg' };
  const mime = m[1] as 'image/png' | 'image/jpeg';
  if (!LOGO_MIMES.includes(mime)) return { ok: false, error: 'unsupported image type' };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2] ?? '', 'base64');
  } catch {
    return { ok: false, error: 'logo is not valid base64' };
  }
  if (bytes.length === 0) return { ok: false, error: 'logo is empty' };
  if (bytes.length > MAX_LOGO_BYTES) {
    return { ok: false, error: `logo is too large (max ${String(MAX_LOGO_BYTES)} bytes decoded)` };
  }
  // Magic-byte sniff — the declared MIME must match the actual content so a
  // text/html (or SVG) payload can't masquerade as a PNG/JPEG.
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg)) {
    return { ok: false, error: 'logo content does not match its declared image type' };
  }
  const dims = imageDimensions(mime, bytes);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return { ok: false, error: 'could not read the image dimensions' };
  }
  if (dims.width !== dims.height) {
    return {
      ok: false,
      error: `logo must be square (got ${String(dims.width)}×${String(dims.height)})`,
    };
  }
  return { ok: true, mime, bytes, etag: createHash('sha256').update(bytes).digest('hex') };
}

export async function dispatchCloudSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DbConfigContext,
): Promise<boolean> {
  const { pathname, method } = ctx;

  // GET /api/cloud/members — list the cloud's members (the owner + every role in
  // the member group). Owner-only enumeration; off a secured cloud returns []
  // (the panel then just shows the local single-user state).
  if (pathname === '/api/cloud/members' && method === 'GET') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { members: [] });
        return;
      }
      const me = (await getAsyncOrSync(ctx.db.adapter, `SELECT session_user AS u`)) as
        | { u?: string }
        | undefined;
      const ownerRole = me?.u ?? '';
      // The operator's own identity (mirrored into __lattice_user_identity on open)
      // — so the owner row shows a real name/email, not the bare Postgres role.
      const idRow = (await getAsyncOrSync(
        ctx.db.adapter,
        `SELECT display_name, email FROM "__lattice_user_identity" WHERE id = 'singleton'`,
      ).catch(() => undefined)) as { display_name?: string; email?: string } | undefined;
      // An EMPTY trimmed name must fall back to the role (not just a null one).
      const trimmedOwnerName = idRow?.display_name?.trim() ?? '';
      const ownerName = trimmedOwnerName.length > 0 ? trimmedOwnerName : ownerRole;
      const ownerEmail = idRow?.email ?? '';

      // Only an owner can enumerate roles; a scoped member just sees itself.
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, {
          members: ownerRole
            ? [
                {
                  role: ownerRole,
                  name: ownerName,
                  email: ownerEmail,
                  status: 'member',
                  isYou: true,
                },
              ]
            : [],
        });
        return;
      }
      // Member-group roles — EXCLUDING the owner (it was double-counted: prepended
      // AND listed again from the group). Scoped to THIS cloud's own member group.
      const group = await memberGroupFor(ctx.db);
      const rows = (await allAsyncOrSync(
        ctx.db.adapter,
        `SELECT m.rolname AS role
           FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = ?
           JOIN pg_roles m ON m.oid = am.member
          WHERE m.rolname <> ?
          ORDER BY m.rolname`,
        [group, ownerRole],
      )) as { role: string }[];
      // role → its latest non-revoked invite (email + whether it's been redeemed)
      // for human-readable display + accurate status. An invite with redeemed_at
      // NULL means the person was invited but hasn't joined yet → "Invited"; once
      // they redeem (redeemed_at set) → "Member". A member-group role with no
      // invite row (e.g. a DBA-created role) is treated as a redeemed member.
      const invites = (await allAsyncOrSync(
        ctx.db.adapter,
        `SELECT DISTINCT ON ("role") "role", "email", "redeemed_at"
           FROM "__lattice_member_invites"
          WHERE "revoked_at" IS NULL
          ORDER BY "role", "created_at" DESC`,
      ).catch(() => [])) as { role: string; email?: string; redeemed_at?: string | null }[];
      const inviteByRole = new Map(invites.map((r) => [r.role, r]));
      const members = [
        { role: ownerRole, name: ownerName, email: ownerEmail, status: 'owner', isYou: true },
        ...rows.map((r) => {
          const inv = inviteByRole.get(r.role);
          const email = inv?.email ?? '';
          const name = email ? (email.split('@')[0] ?? r.role) : r.role;
          // Pending (un-redeemed) invite → Invited; redeemed or no invite → Member.
          const status = inv && inv.redeemed_at == null ? 'invited' : 'member';
          return { role: r.role, name, email, status, isYou: false };
        }),
      ];
      sendJson(res, { members });
    });
    return true;
  }

  // POST /api/cloud/share — set a row's visibility (private | everyone) via the
  // owner-only RLS function. Only the row's owner may change its sharing; the
  // database raises for anyone else, which surfaces as a 403-ish error here.
  if (pathname === '/api/cloud/share' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const table = typeof body.table === 'string' ? body.table : '';
      const pk = typeof body.pk === 'string' ? body.pk : '';
      const visibility = typeof body.visibility === 'string' ? body.visibility : '';
      if (!table || !pk || !visibility) {
        sendJson(res, { error: 'table, pk and visibility are required' }, 400);
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Sharing requires a cloud (Postgres) database' }, 400);
        return;
      }
      await setRowVisibility(ctx.db, table, pk, visibility);
      sendJson(res, { ok: true, table, pk, visibility });
    });
    return true;
  }

  // POST /api/cloud/row-grant — "share with specific people". The row owner
  // grants (or revokes) one member access to one row (table + pk), flipping the
  // row to `custom` visibility. Owner-only — the SECURITY DEFINER function raises
  // for a non-owner (and for a never-share table), surfaced here as an error.
  if (pathname === '/api/cloud/row-grant' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const table = typeof body.table === 'string' ? body.table : '';
      const pk = typeof body.pk === 'string' ? body.pk : '';
      const grantee = typeof body.grantee === 'string' ? body.grantee : '';
      const revoke = body.revoke === true;
      if (!table || !pk || !grantee) {
        sendJson(res, { error: 'table, pk and grantee are required' }, 400);
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Per-row sharing requires a cloud (Postgres) database' }, 400);
        return;
      }
      if (revoke) await revokeRow(ctx.db, table, pk, grantee);
      else await grantRow(ctx.db, table, pk, grantee);
      sendJson(res, { ok: true, table, pk, grantee, revoked: revoke });
    });
    return true;
  }

  // POST /api/cloud/row-grants — BATCH "share with specific people". The row
  // owner stages a multi-select in the GUI and commits ONCE: grant access to
  // every role in `grant`, revoke it from every role in `revoke`, against one
  // row (table + pk). Each subject goes through the same owner-only, idempotent
  // SECURITY DEFINER path as the single-grantee route, so a non-owner caller is
  // rejected by the database (surfaced here as an error). The first grant flips
  // the row to `custom` server-side. The single-grantee route above stays for
  // any other caller.
  if (pathname === '/api/cloud/row-grants' && method === 'POST') {
    await tryHandler(res, async () => {
      const body = await readJson(req);
      const table = typeof body.table === 'string' ? body.table : '';
      const pk = typeof body.pk === 'string' ? body.pk : '';
      const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      const grant = strList(body.grant);
      const revoke = strList(body.revoke);
      if (!table || !pk) {
        sendJson(res, { error: 'table and pk are required' }, 400);
        return;
      }
      if (ctx.db.getDialect() !== 'postgres') {
        sendJson(res, { error: 'Per-row sharing requires a cloud (Postgres) database' }, 400);
        return;
      }
      await batchRowGrants(ctx.db, table, pk, grant, revoke);
      sendJson(res, { ok: true, table, pk, granted: grant, revoked: revoke });
    });
    return true;
  }

  // GET/POST /api/cloud/s3-config — enable S3 file storage for this cloud
  // workspace. When on, uploaded file bytes go to S3 so other members can pull
  // them (access still gated by the files-row RLS at the serve route). Config is
  // stored per-member + machine-local (encrypted), NOT in the shared DB. Setting
  // it is owner-only; the secret is redacted on read.
  if (pathname === '/api/cloud/s3-config' && method === 'GET') {
    // Reads this member's machine-local config only (no DB/network), so the
    // handler is synchronous; return a resolved promise for tryHandler's signature.
    await tryHandler(res, () => {
      const label = activeWorkspaceLabel(ctx.configPath);
      const raw = label ? getS3ConfigRaw(label) : null;
      sendJson(res, {
        enabled: raw?.enabled === true,
        bucket: typeof raw?.bucket === 'string' ? raw.bucket : null,
        region: typeof raw?.region === 'string' ? raw.region : null,
        prefix: typeof raw?.prefix === 'string' ? raw.prefix : null,
        endpoint: typeof raw?.endpoint === 'string' ? raw.endpoint : null,
        // Never return the secret; just whether one is stored.
        accessKeyId: typeof raw?.accessKeyId === 'string' ? raw.accessKeyId : null,
        hasSecret: typeof raw?.secretAccessKey === 'string' && raw.secretAccessKey.length > 0,
      });
      return Promise.resolve();
    });
    return true;
  }
  if (pathname === '/api/cloud/s3-config' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can configure S3 file storage' }, 403);
        return;
      }
      const label = activeWorkspaceLabel(ctx.configPath);
      if (!label) {
        sendJson(res, { error: 'The active workspace is not a labelled cloud connection' }, 400);
        return;
      }
      const body = await readJson(req);
      // Merge over the existing stored config so a PARTIAL update (toggling
      // `enabled`, changing `prefix`) doesn't silently drop the stored secret — the
      // GET handler redacts secretAccessKey, so a UI round-trip never carries it
      // back. (See mergeS3ConfigForSave.)
      const toSave = mergeS3ConfigForSave(getS3ConfigRaw(label) ?? {}, body);
      if (toSave.enabled && (!toSave.bucket || !toSave.region)) {
        sendJson(res, { error: 'bucket and region are required to enable S3' }, 400);
        return;
      }
      saveS3ConfigRaw(label, toSave);
      // Auto-enable the in-database presigner so KEYLESS members (who have no
      // local S3 config) can fetch/upload bytes for files they can see. One owner
      // action turns it on cloud-wide. Best-effort: a failure (e.g. no privilege
      // to CREATE EXTENSION pgcrypto) must not fail the owner's S3-config save.
      const ak = typeof toSave.accessKeyId === 'string' ? toSave.accessKeyId : '';
      const sk = typeof toSave.secretAccessKey === 'string' ? toSave.secretAccessKey : '';
      if (
        toSave.enabled &&
        typeof toSave.bucket === 'string' &&
        typeof toSave.region === 'string' &&
        ak &&
        sk
      ) {
        try {
          await ctx.db.enableCloudFilePresigning({
            bucket: toSave.bucket,
            region: toSave.region,
            accessKey: ak,
            secretKey: sk,
            ...(typeof toSave.prefix === 'string' ? { prefix: toSave.prefix } : {}),
            ...(typeof toSave.endpoint === 'string' ? { endpoint: toSave.endpoint } : {}),
          });
        } catch (e) {
          console.warn(
            '[cloud s3-config] could not enable the in-database file presigner:',
            (e as Error).message,
          );
        }
      }
      sendJson(res, { ok: true, enabled: toSave.enabled, bucket: toSave.bucket || null });
    });
    return true;
  }

  // GET/POST /api/cloud/system-prompt — the workspace chat system prompt the cloud
  // OWNER bundles into every member's chat. Owner-only to VIEW and to EDIT: the GET
  // returns the text ONLY to an owner (a member gets canEdit:false and NO text), so
  // the prompt never crosses the product API to a member. Secrecy is app-mediated
  // (see src/cloud/settings.ts) — it's hidden from the UI + API, not cryptographic.
  if (pathname === '/api/cloud/system-prompt' && method === 'GET') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        // Not a cloud — no shared/secret prompt concept. Report unsupported so the
        // UI hides the control rather than showing an empty editor.
        sendJson(res, { supported: false, canEdit: false });
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        // A member: never return the prompt text through the product API.
        sendJson(res, { supported: true, canEdit: false });
        return;
      }
      // Owner: ensure the store exists (covers clouds secured before this feature),
      // then return the current prompt for editing. Use the STRICT reader: a real
      // read failure must surface (tryHandler → 500, the modal shows a load error)
      // rather than swallow to '' — a deceptive empty editor would invite a blind
      // overwrite of the live prompt (fail loudly, never silently). '' means genuinely unset.
      await installCloudSettings(ctx.db);
      const prompt = await getCloudSettingStrict(ctx.db, CLOUD_SETTING_SYSTEM_PROMPT);
      sendJson(res, { supported: true, canEdit: true, prompt: prompt ?? '' });
    });
    return true;
  }
  if (pathname === '/api/cloud/system-prompt' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can edit the chat system prompt' }, 403);
        return;
      }
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
        sendJson(
          res,
          { error: `prompt is too long (max ${String(MAX_SYSTEM_PROMPT_CHARS)} characters)` },
          400,
        );
        return;
      }
      await installCloudSettings(ctx.db);
      // The setter is owner-guarded inside Postgres too (RAISEs for a non-owner) —
      // the API gate above is defense in depth + a clean error.
      await setCloudSetting(ctx.db, CLOUD_SETTING_SYSTEM_PROMPT, prompt);
      sendJson(res, { ok: true, length: prompt.length });
    });
    return true;
  }

  // GET /api/cloud/workspace-logo — the owner-set logo bytes, readable by every
  // member (unlike the system prompt, the logo is meant to be seen). Cheap on the
  // hot path: reads the ~64-byte etag first and answers an `If-None-Match` with a
  // 304 before touching the full blob; the blob itself is `immutable` + cache-
  // busted by `?v=<etag>`, so each client fetches it once per logo version.
  if (pathname === '/api/cloud/workspace-logo' && method === 'GET') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'not a cloud workspace' }, 404);
        return;
      }
      // Best-effort: a missing setting / un-upgraded cloud reads as "no logo".
      const etag = await getCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO_ETAG);
      if (!etag) {
        sendJson(res, { error: 'no workspace logo set' }, 404);
        return;
      }
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm.replace(/"/g, '') === etag) {
        res.writeHead(304, { etag: `"${etag}"` });
        res.end();
        return;
      }
      const stored = await getCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO);
      const m = stored ? /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec(stored) : null;
      if (!m) {
        sendJson(res, { error: 'no workspace logo set' }, 404);
        return;
      }
      const bytes = Buffer.from(m[2] ?? '', 'base64');
      res.writeHead(200, {
        'content-type': m[1] === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        etag: `"${etag}"`,
        // Content-addressed by `?v=<etag>`, so the blob never changes for a given
        // URL — cache hard. `nosniff` + sandbox CSP mirror the file-blob serve.
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      res.end(bytes);
    });
    return true;
  }

  // POST /api/cloud/workspace-logo — owner-only. Empty body removes the logo
  // (clears both keys → readers report null → the default Lattice mark returns).
  // Otherwise validates a square PNG/JPEG data: URI and stores blob-then-etag.
  if (pathname === '/api/cloud/workspace-logo' && method === 'POST') {
    await tryHandler(res, async () => {
      if (ctx.db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(ctx.db))) {
        sendJson(res, { error: 'The active database is not a Lattice cloud' }, 400);
        return;
      }
      if (!(await canManageRoles(ctx.db))) {
        sendJson(res, { error: 'Only a cloud owner can change the workspace logo' }, 403);
        return;
      }
      await installCloudSettings(ctx.db);
      // Allow up to ~2 MB of request body so a too-big logo reaches the precise
      // 64 KB validation message below (a smaller cap would 413 with only a
      // generic "body too large"). parseAndValidateLogo enforces the real limit.
      const body = await readJson(req, { maxBytes: 2_000_000 });
      const raw = typeof body.logo === 'string' ? body.logo.trim() : '';
      if (!raw) {
        // Remove: clear both keys (readers map '' → null → default logo).
        await setCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO, '');
        await setCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO_ETAG, '');
        sendJson(res, { ok: true, logoEtag: null });
        return;
      }
      const parsed = parseAndValidateLogo(raw);
      if (!parsed.ok) {
        sendJson(res, { error: parsed.error }, 400);
        return;
      }
      // Write the blob first, then the etag — if the second write fails, a reader
      // sees the old etag (no logo) rather than a dangling etag with no blob.
      await setCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO, raw);
      await setCloudSetting(ctx.db, CLOUD_SETTING_WORKSPACE_LOGO_ETAG, parsed.etag);
      sendJson(res, { ok: true, logoEtag: parsed.etag });
    });
    return true;
  }

  return false;
}
