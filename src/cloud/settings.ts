import { createHash, randomBytes } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { cloudSchema, pinDefinerSearchPath, runCloudBootstrapSql } from './rls.js';

/**
 * Workspace-level settings for a cloud — cloud-wide values the OWNER controls and
 * members never see in the product surface. Stored in `__lattice_cloud_settings`,
 * a bookkeeping table members have no grant on — so its VALUE is unreadable to a
 * member (SELECT is denied, like every other `__lattice_*` table; the System view
 * may still list the table's existence + column names from the catalog, but never
 * its contents). It is reached only through two `SECURITY DEFINER` helpers:
 *
 *   - `lattice_get_cloud_setting(key)` — readable by members, because a member's
 *     own chat must inject the value (the chat call is assembled in each member's
 *     LOCAL gui process). This is the deliberate, documented ceiling: secrecy is
 *     **app-mediated** (hidden from the UI + every API response), NOT cryptographic
 *     — a member CAN read the value from their own session if they go looking.
 *   - `lattice_set_cloud_setting(key, value)` — owner-only (RAISEs unless the
 *     caller can create roles, the same gate as `lattice_assign_role`).
 *
 * Postgres-only: a local SQLite workspace is single-user, so there is nothing to
 * keep secret and these are all no-ops / null there.
 */

/** Setting key for the chat system prompt an owner bundles into every member's chat. */
export const CLOUD_SETTING_SYSTEM_PROMPT = 'chat_system_prompt';

/** Setting key for the per-cloud salt that peppers the invite-audit email hash. */
export const CLOUD_SETTING_INVITE_SALT = 'invite_email_salt';

/**
 * Setting key for the owner-set workspace logo — a `data:image/(png|jpeg);base64,…`
 * URI that replaces the default Lattice topbar mark for every member of the cloud.
 * Stored as text (base64) in the shared owner-write/member-read settings table.
 */
export const CLOUD_SETTING_WORKSPACE_LOGO = 'workspace_logo';

/**
 * Setting key for the workspace logo's content hash (sha256 hex of the decoded
 * bytes, computed server-side on write). Used as the cache-busting `?v=` token and
 * the `ETag` — cheap to read (~64 bytes) so a member's per-load cost is one tiny
 * read, and the full blob is fetched at most once per logo version.
 */
export const CLOUD_SETTING_WORKSPACE_LOGO_ETAG = 'workspace_logo_etag';

/**
 * The per-cloud salt used to hash invitee emails in `__lattice_member_invites`
 * (#4.10). A bare unsalted SHA-256 is trivially rainbow-tableable; a stable
 * per-cloud random salt defeats that while keeping the hash a stable lookup key
 * (re-invite + orphan cleanup match by it). Read-or-create: generated once on the
 * first invite and persisted in the owner-only settings table. Owner-only path
 * (the setter raises for a non-owner) — only the invite route (owner-gated) calls
 * it. Throws on a genuine DB error rather than silently using an empty salt.
 */
export async function getOrCreateInviteSalt(db: Lattice): Promise<string> {
  const existing = await getCloudSettingStrict(db, CLOUD_SETTING_INVITE_SALT);
  if (existing) return existing;
  const salt = randomBytes(16).toString('hex');
  await setCloudSetting(db, CLOUD_SETTING_INVITE_SALT, salt);
  return salt;
}

/** Salted hash of an invitee email for the audit table (#4.10). Lowercased +
 *  trimmed (so the same address always maps to the same hash) then peppered with
 *  the per-cloud salt. */
export function hashInviteEmail(salt: string, email: string): string {
  return createHash('sha256').update(`${salt}\n${email.trim().toLowerCase()}`).digest('hex');
}

const CLOUD_SETTINGS_BOOTSTRAP_SQL = `
-- Owner-controlled, cloud-wide key/value settings. No grant to the member group,
-- so a member's SELECT is denied (the VALUE is unreadable — the catalog may still
-- reveal the table exists, like every other __lattice_* table); the SECURITY
-- DEFINER getter below is the only member-reachable read path.
CREATE TABLE IF NOT EXISTS "__lattice_cloud_settings" (
  "key"        text PRIMARY KEY,
  "value"      text,
  "updated_by" text NOT NULL DEFAULT session_user,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Read a setting. SECURITY DEFINER so a scoped member (no direct grant on the
-- table) can still read it to inject into their own chat. App-mediated ceiling:
-- this returns the value to whoever calls it, so the secrecy is at the product
-- surface (UI + API), not against a member's own SQL session.
CREATE OR REPLACE FUNCTION lattice_get_cloud_setting(p_key text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT "value" FROM "__lattice_cloud_settings" WHERE "key" = p_key LIMIT 1
$fn$;

-- Owner-only write. Raises unless the caller can create roles (a cloud owner /
-- DBA) — members get no write path even though the function is callable.
CREATE OR REPLACE FUNCTION lattice_set_cloud_setting(p_key text, p_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'lattice: only a cloud owner may change workspace settings';
  END IF;
  INSERT INTO "__lattice_cloud_settings" ("key", "value", "updated_by", "updated_at")
    VALUES (p_key, p_value, session_user, now())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "updated_by" = session_user, "updated_at" = now();
END $fn$;
`;

/**
 * Install the workspace-settings table + helpers. Idempotent (`CREATE TABLE IF
 * NOT EXISTS` / `CREATE OR REPLACE FUNCTION`). No-op on SQLite. Run as the cloud
 * owner — `secureCloud` calls it for new clouds, and the owner-only settings
 * endpoint calls it lazily so an already-secured cloud picks it up on first use.
 */
export async function installCloudSettings(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const schema = await cloudSchema(db);
  // Direct (not version-gated), same convergence reasoning as installCloudRls,
  // and serialized by the shared advisory lock so concurrent owner opens don't
  // collide on catalog updates. CREATE … IF NOT EXISTS / CREATE OR REPLACE.
  await runCloudBootstrapSql(db, pinDefinerSearchPath(CLOUD_SETTINGS_BOOTSTRAP_SQL, schema));
}

/**
 * Read a cloud workspace setting via the SECURITY DEFINER getter. Best-effort:
 * returns null on SQLite, on a cloud that hasn't installed the helper yet (the
 * function is absent), or on any error — so a caller treats "unset" and "couldn't
 * read" identically (e.g. the chat path simply injects nothing).
 */
export async function getCloudSetting(db: Lattice, key: string): Promise<string | null> {
  if (db.getDialect() !== 'postgres') return null;
  try {
    const row = (await getAsyncOrSync(db.adapter, `SELECT lattice_get_cloud_setting(?) AS value`, [
      key,
    ])) as { value?: string | null } | undefined;
    const v = row?.value;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Read a cloud workspace setting, THROWING on a genuine DB error instead of
 * swallowing it. Use this on the OWNER read/edit surface: an owner who opens the
 * editor must see a load error (a 500 the route surfaces) rather than a deceptive
 * empty textarea that invites a blind overwrite of the live prompt. Returns null
 * ONLY when genuinely unset (the getter returned NULL) or on a non-Postgres db.
 * The hot chat path uses {@link getCloudSetting} (best-effort) instead.
 */
export async function getCloudSettingStrict(db: Lattice, key: string): Promise<string | null> {
  if (db.getDialect() !== 'postgres') return null;
  const row = (await getAsyncOrSync(db.adapter, `SELECT lattice_get_cloud_setting(?) AS value`, [
    key,
  ])) as { value?: string | null } | undefined;
  const v = row?.value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Owner-only: write a cloud workspace setting via the SECURITY DEFINER setter.
 * The function RAISEs if the caller isn't a cloud owner; that surfaces here as a
 * thrown error which the (already owner-gated) endpoint reports. Not silent.
 */
export async function setCloudSetting(db: Lattice, key: string, value: string): Promise<void> {
  await runAsyncOrSync(db.adapter, `SELECT lattice_set_cloud_setting(?, ?)`, [key, value]);
}
